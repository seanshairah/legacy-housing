import { leaseDisplayLines } from "../lib/lease-display";
import { z } from "zod";
import { db, transaction } from "../lib/db";
import { hash, token, decrypt, totp } from "../lib/security";
import { renderPdf } from "../lib/pdf";
import { type Actor } from "./access";
import { rateLimit } from "./identity";
import { event } from "./events";
import { prepareGeneratedPdf, discardPreparedFile } from "./documents";

function source(lease: { documentSnapshot: string; documentHash: string }) {
  if (hash(lease.documentSnapshot) !== lease.documentHash)
    throw new Error("LEASE_INTEGRITY_FAILED");
  const snapshot = JSON.parse(lease.documentSnapshot);
  if (
    typeof snapshot.electronicSigningDisclosure !== "string" ||
    snapshot.electronicSigningDisclosure.length < 30
  )
    throw new Error("ELECTRONIC_SIGNING_NOT_ENABLED_FOR_THIS_AGREEMENT");
  return snapshot as {
    resident: string;
    electronicSigningDisclosure: string;
    [key: string]: unknown;
  };
}
async function signer(actor: Actor) {
  if (actor.apiPropertyId) throw new Error("SESSION_REQUIRED");
  const u = await db.user.findUniqueOrThrow({ where: { id: actor.id } });
  if (
    !u.active ||
    !u.emailVerifiedAt ||
    !u.phoneVerifiedAt ||
    !u.mfaConfirmed ||
    !u.mfaSecret
  )
    throw new Error("VERIFIED_CONTACTS_AND_AUTHENTICATOR_REQUIRED");
  return u;
}
export async function beginElectronicSigning(actor: Actor, leaseId: string) {
  await rateLimit(`lease-sign-start:${actor.id}`, 10);
  await signer(actor);
  const raw = token();
  return transaction(async (tx) => {
    const lease = await tx.lease.findUniqueOrThrow({ where: { id: leaseId } });
    if (lease.userId !== actor.id || lease.status !== "AWAITING_SIGNATURE")
      throw new Error("LEASE_SIGNATURE_DENIED");
    const snapshot = source(lease);
    const expiresAt = new Date(Date.now() + 10 * 60000);
    await tx.leaseSigningChallenge.create({
      data: {
        leaseId,
        userId: actor.id,
        tokenHash: hash(raw),
        documentHash: lease.documentHash,
        expiresAt,
      },
    });
    await event(
      tx,
      actor.id,
      lease.propertyId,
      "lease.signing_started",
      leaseId,
      { documentHash: lease.documentHash },
    );
    return {
      challenge: raw,
      documentHash: lease.documentHash,
      snapshot,
      expiresAt: expiresAt.toISOString(),
    };
  });
}
export async function signElectronically(actor: Actor, input: unknown) {
  const d = z
    .object({
      leaseId: z.string(),
      challenge: z.string().max(100),
      documentHash: z.string().length(64),
      name: z.string().trim().min(2).max(120),
      code: z.string().regex(/^\d{6}$/),
      consent: z.literal(true),
    })
    .parse(input);
  await rateLimit(`lease-sign:${actor.id}`, 6);
  const u = await signer(actor);
  const delta = totp(decrypt(u.mfaSecret!).toString()).validate({
    token: d.code,
    window: 1,
  });
  if (delta === null) throw new Error("MFA_VERIFICATION_FAILED");
  const totpStep = BigInt(Math.floor(Date.now() / 30000) + delta);
  const lease = await db.lease.findUniqueOrThrow({ where: { id: d.leaseId } });
  if (lease.userId !== actor.id || lease.status !== "AWAITING_SIGNATURE")
    throw new Error("LEASE_SIGNATURE_DENIED");
  const snapshot = source(lease);
  if (
    d.documentHash !== lease.documentHash ||
    d.name.normalize("NFKC") !== snapshot.resident.normalize("NFKC")
  )
    throw new Error("SIGNER_OR_DOCUMENT_MISMATCH");
  const c = await db.leaseSigningChallenge.findUnique({
    where: { tokenHash: hash(d.challenge) },
  });
  if (
    !c ||
    c.userId !== actor.id ||
    c.leaseId !== lease.id ||
    c.documentHash !== lease.documentHash ||
    c.consumedAt ||
    c.expiresAt <= new Date()
  )
    throw new Error("SIGNING_CHALLENGE_EXPIRED_OR_USED");
  const signedAt = new Date();
  const evidence = {
    scheme: "LEGACY_TOTP_CONSENT_V1",
    signerId: actor.id,
    signerName: d.name,
    signedAt: signedAt.toISOString(),
    sourceHash: lease.documentHash,
    disclosure: snapshot.electronicSigningDisclosure,
    challengeId: c.id,
    consent: true,
  };
  const evidenceHash = hash(JSON.stringify(evidence));
  const bytes = await renderPdf([
    "ELECTRONICALLY SIGNED LEASE",
    ...leaseDisplayLines(snapshot),
    "SIGNATURE EVIDENCE",
    ...Object.entries(evidence).map(([k, v]) => `${k}: ${v}`),
    `Evidence SHA-256: ${evidenceHash}`,
    "Submitted for independent management execution review.",
  ]);
  const prepared = await prepareGeneratedPdf(bytes);
  try {
    return await transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Lease" WHERE id=${lease.id} FOR UPDATE`;
      const current = await tx.lease.findUniqueOrThrow({
        where: { id: lease.id },
      });
      const person = await tx.user.findUniqueOrThrow({
        where: { id: actor.id },
      });
      if (
        !person.active ||
        person.mfaSecret !== u.mfaSecret ||
        !person.mfaConfirmed ||
        current.status !== "AWAITING_SIGNATURE" ||
        current.documentHash !== d.documentHash
      )
        throw new Error("LEASE_SIGNATURE_DENIED");
      const used = await tx.leaseSigningChallenge.findFirst({
        where: { userId: actor.id, totpStep },
      });
      if (used) throw new Error("AUTHENTICATOR_CODE_ALREADY_USED_FOR_SIGNING");
      const claimed = await tx.leaseSigningChallenge.updateMany({
        where: {
          id: c.id,
          userId: actor.id,
          consumedAt: null,
          expiresAt: { gt: new Date() },
        },
        data: { consumedAt: signedAt, totpStep },
      });
      if (claimed.count !== 1)
        throw new Error("SIGNING_CHALLENGE_EXPIRED_OR_USED");
      const version =
        (await tx.document.count({
          where: { applicationId: lease.applicationId, kind: "SIGNED_LEASE" },
        })) + 1;
      const doc = await tx.document.create({
        data: {
          userId: actor.id,
          propertyId: lease.propertyId,
          applicationId: lease.applicationId,
          kind: "SIGNED_LEASE",
          filename: `electronically-signed-${lease.id}.pdf`,
          mime: "application/pdf",
          bytes: prepared.bytes,
          storageKey: prepared.storageKey,
          hash: prepared.hash,
          version,
          state: "CLEAN",
          scanResult: "CLEAN",
          scanAttempts: 1,
        },
      });
      await event(
        tx,
        actor.id,
        lease.propertyId,
        "document.generated_and_scanned",
        doc.id,
        { hash: doc.hash },
      );
      await tx.lease.update({
        where: { id: lease.id },
        data: {
          status: "REVIEW",
          signedDocumentId: doc.id,
          signedHash: doc.hash,
          signedAt,
        },
      });
      await tx.leaseEvent.create({
        data: {
          leaseId: lease.id,
          actorId: actor.id,
          type: "ELECTRONICALLY_SIGNED",
          evidence: {
            ...evidence,
            evidenceHash,
            signedFileHash: doc.hash,
            documentId: doc.id,
          },
        },
      });
      await event(
        tx,
        actor.id,
        lease.propertyId,
        "lease.electronically_signed",
        lease.id,
        {
          sourceHash: lease.documentHash,
          signedFileHash: doc.hash,
          evidenceHash,
        },
        actor.id,
      );
      return { leaseId: lease.id, status: "REVIEW", documentId: doc.id };
    });
  } catch (error) {
    await discardPreparedFile(prepared.storageKey);
    throw error;
  }
}
