import { unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { transaction, type Tx } from "../lib/db";
import { type Actor, permit } from "./access";
import { event } from "./events";

// Financial and signed agreement evidence has a separate legal retention basis.
// This subsystem never deletes it, even if a general document policy expires.
const disposableKinds = z.enum([
  "IDENTITY",
  "REGISTRATION",
  "RESIDENCE",
  "SPONSOR",
  "MEDICAL",
  "SUPPORT",
]);
const rationale = z.string().trim().min(10).max(2000);
async function retentionPermission(actor: Actor, propertyId: string, tx: Tx) {
  await permit(actor, propertyId, "settings", tx);
}
async function documentPermission(actor: Actor, documentId: string, tx: Tx) {
  const doc = await tx.document.findUniqueOrThrow({
    where: { id: documentId },
  });
  await retentionPermission(actor, doc.propertyId, tx);
  if (doc.kind === "MEDICAL")
    await permit(actor, doc.propertyId, "medical", tx);
  return doc;
}

export async function proposeRetentionPolicy(actor: Actor, input: unknown) {
  const d = z
    .object({
      propertyId: z.string().min(1),
      kind: disposableKinds,
      retainDays: z.coerce.number().int().min(1).max(36500),
      basis: rationale,
      policyReference: z.string().trim().min(5).max(500),
    })
    .parse(input);
  return transaction(async (tx) => {
    await retentionPermission(actor, d.propertyId, tx);
    await tx.$queryRaw`SELECT id FROM "Property" WHERE id=${d.propertyId} FOR UPDATE`;
    const previous = await tx.retentionPolicy.findFirst({
      where: { propertyId: d.propertyId, kind: d.kind },
      orderBy: { version: "desc" },
    });
    const policy = await tx.retentionPolicy.create({
      data: {
        ...d,
        proposedBy: actor.id,
        version: (previous?.version || 0) + 1,
      },
    });
    await event(
      tx,
      actor.id,
      d.propertyId,
      "retention.policy_proposed",
      policy.id,
      {
        kind: d.kind,
        retainDays: d.retainDays,
        version: policy.version,
        policyReference: d.policyReference,
      },
    );
    return policy;
  });
}
export async function approveRetentionPolicy(
  actor: Actor,
  id: string,
  reason: string,
) {
  rationale.parse(reason);
  return transaction(async (tx) => {
    const policy = await tx.retentionPolicy.findUniqueOrThrow({
      where: { id },
    });
    await retentionPermission(actor, policy.propertyId, tx);
    if (policy.proposedBy === actor.id)
      throw new Error("INDEPENDENT_RETENTION_APPROVER_REQUIRED");
    if (policy.state !== "DRAFT") throw new Error("RETENTION_POLICY_NOT_DRAFT");
    await tx.$queryRaw`SELECT id FROM "Property" WHERE id=${policy.propertyId} FOR UPDATE`;
    await tx.retentionPolicy.updateMany({
      where: {
        propertyId: policy.propertyId,
        kind: policy.kind,
        state: "APPROVED",
      },
      data: { state: "SUPERSEDED" },
    });
    const approved = await tx.retentionPolicy.update({
      where: { id },
      data: { state: "APPROVED", approvedBy: actor.id, approvedAt: new Date() },
    });
    await event(
      tx,
      actor.id,
      policy.propertyId,
      "retention.policy_approved",
      id,
      { reason },
    );
    return approved;
  });
}

// A reason is returned for each exclusion so a dry run can be reviewed without
// exposing filenames, document contents or medical details.
async function eligibility(tx: Tx, documentId: string, policyId?: string) {
  const doc = await tx.document.findUniqueOrThrow({
    where: { id: documentId },
    include: { application: true },
  });
  if (!disposableKinds.safeParse(doc.kind).success)
    return { doc, reason: "IMMUTABLE_EVIDENCE" };
  if (doc.deletedAt || doc.state === "DELETED")
    return { doc, reason: "ALREADY_DELETED" };
  if (
    (await tx.lease.count({ where: { signedDocumentId: doc.id } })) ||
    (await tx.payment.count({ where: { proofDocumentId: doc.id } }))
  )
    return { doc, reason: "IMMUTABLE_EVIDENCE" };
  if (
    await tx.documentLegalHold.count({
      where: { documentId: doc.id, releasedAt: null },
    })
  )
    return { doc, reason: "LEGAL_HOLD" };
  const policy = await tx.retentionPolicy.findFirst({
    where: {
      propertyId: doc.propertyId,
      kind: doc.kind,
      state: "APPROVED",
      ...(policyId ? { id: policyId } : {}),
    },
    orderBy: { version: "desc" },
  });
  if (!policy) return { doc, reason: "NO_APPROVED_RETENTION_POLICY" };
  if (
    doc.application &&
    !["DECLINED", "WITHDRAWN", "ENDED"].includes(doc.application.status)
  )
    return { doc, reason: "ACTIVE_APPLICATION" };
  if (
    await tx.ticketMessage.count({
      where: {
        documentId: doc.id,
        ticket: { status: { notIn: ["CLOSED", "RESOLVED"] } },
      },
    })
  )
    return { doc, reason: "ACTIVE_SERVICE_REQUEST" };
  // The schedule begins after the latest application transition, rather than
  // upload, so a long lived tenancy never shortens post-tenancy retention.
  const service = await tx.ticket.aggregate({
    where: { messages: { some: { documentId: doc.id } } },
    _max: { updatedAt: true, resolvedAt: true },
  });
  const anchor = Math.max(
    doc.createdAt.getTime(),
    doc.application?.updatedAt.getTime() || 0,
    service._max.updatedAt?.getTime() || 0,
    service._max.resolvedAt?.getTime() || 0,
  );
  if (anchor + policy.retainDays * 86400000 > Date.now())
    return { doc, reason: "RETENTION_NOT_EXPIRED" };
  return { doc, policy, reason: null };
}

export async function retentionDryRun(
  actor: Actor,
  propertyId: string,
  limit = 100,
  after?: string,
) {
  z.number().int().min(1).max(100).parse(limit);
  return transaction(async (tx) => {
    await retentionPermission(actor, propertyId, tx);
    const docs = await tx.document.findMany({
      where: { propertyId, ...(after ? { id: { gt: after } } : {}) },
      orderBy: { id: "asc" },
      take: limit + 1,
      select: { id: true, kind: true },
    });
    const page = docs.slice(0, limit),
      items = [];
    for (const d of page) {
      if (d.kind === "MEDICAL") await permit(actor, propertyId, "medical", tx);
      const check = await eligibility(tx, d.id);
      const reason =
        check.doc.state === "DELETION_PENDING"
          ? "DELETION_ALREADY_CLAIMED"
          : check.reason;
      items.push({
        id: d.id,
        kind: d.kind,
        eligible: !reason,
        reason,
        policyId: check.policy?.id,
      });
    }
    await event(tx, actor.id, propertyId, "retention.dry_run", propertyId, {
      count: items.length,
    });
    return { items, next: docs.length > limit ? page.at(-1)!.id : null };
  });
}
export async function retentionOverview(
  actor: Actor,
  propertyId: string,
  page = 1,
) {
  z.number().int().min(1).max(100000).parse(page);
  const skip = (page - 1) * 100;
  return transaction(async (tx) => {
    await retentionPermission(actor, propertyId, tx);
    await permit(actor, propertyId, "medical", tx);
    const policies = await tx.retentionPolicy.findMany({
      where: { propertyId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 101,
      skip,
    });
    const holds = await tx.documentLegalHold.findMany({
      where: { propertyId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 101,
      skip,
    });
    const deletions = await tx.documentDeletion.findMany({
      where: { propertyId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 101,
      skip,
    });
    return {
      policies: policies.slice(0, 100),
      holds: holds.slice(0, 100),
      deletions: deletions.slice(0, 100),
      hasNext: [policies, holds, deletions].some((items) => items.length > 100),
      executionEnabled: process.env.RETENTION_EXECUTION_ENABLED === "true",
    };
  });
}

export async function requestDocumentDeletion(
  actor: Actor,
  documentId: string,
  reason: string,
) {
  rationale.parse(reason);
  return transaction(async (tx) => {
    const doc = await documentPermission(actor, documentId, tx);
    await tx.$queryRaw`SELECT id FROM "Document" WHERE id=${doc.id} FOR UPDATE`;
    const check = await eligibility(tx, doc.id);
    if (check.reason || !check.policy)
      throw new Error(check.reason || "NO_APPROVED_RETENTION_POLICY");
    const existing = await tx.documentDeletion.findUnique({
      where: { documentId },
    });
    if (existing) return existing;
    const request = await tx.documentDeletion.create({
      data: {
        documentId,
        propertyId: doc.propertyId,
        policyId: check.policy.id,
        requestedBy: actor.id,
        reason,
      },
    });
    await event(
      tx,
      actor.id,
      doc.propertyId,
      "retention.deletion_requested",
      request.id,
      { documentId, policyId: check.policy.id, reason },
    );
    return request;
  });
}
export async function approveDocumentDeletion(
  actor: Actor,
  id: string,
  reason: string,
) {
  rationale.parse(reason);
  return transaction(async (tx) => {
    const request = await tx.documentDeletion.findUniqueOrThrow({
      where: { id },
    });
    const doc = await documentPermission(actor, request.documentId, tx);
    await tx.$queryRaw`SELECT id FROM "Document" WHERE id=${doc.id} FOR UPDATE`;
    if (request.requestedBy === actor.id)
      throw new Error("INDEPENDENT_DELETION_APPROVER_REQUIRED");
    if (request.state !== "REQUESTED")
      throw new Error("DELETION_NOT_REQUESTED");
    const check = await eligibility(tx, doc.id, request.policyId);
    if (check.reason) throw new Error(check.reason);
    const approved = await tx.documentDeletion.update({
      where: { id },
      data: { state: "APPROVED", approvedBy: actor.id, approvedAt: new Date() },
    });
    await event(
      tx,
      actor.id,
      doc.propertyId,
      "retention.deletion_approved",
      id,
      { documentId: doc.id, reason },
    );
    return approved;
  });
}
export async function imposeDocumentHold(actor: Actor, input: unknown) {
  const d = z
    .object({ documentId: z.string().min(1), reason: rationale })
    .parse(input);
  return transaction(async (tx) => {
    const doc = await documentPermission(actor, d.documentId, tx);
    await tx.$queryRaw`SELECT id FROM "Document" WHERE id=${doc.id} FOR UPDATE`;
    if (doc.deletedAt || ["DELETION_PENDING", "DELETED"].includes(doc.state))
      throw new Error("DELETION_ALREADY_CLAIMED");
    const hold = await tx.documentLegalHold.create({
      data: { ...d, propertyId: doc.propertyId, imposedBy: actor.id },
    });
    await event(
      tx,
      actor.id,
      doc.propertyId,
      "retention.hold_imposed",
      hold.id,
      { documentId: doc.id, reason: d.reason },
    );
    return hold;
  });
}
export async function releaseDocumentHold(
  actor: Actor,
  id: string,
  reason: string,
) {
  rationale.parse(reason);
  return transaction(async (tx) => {
    const hold = await tx.documentLegalHold.findUniqueOrThrow({
      where: { id },
    });
    await documentPermission(actor, hold.documentId, tx);
    if (hold.imposedBy === actor.id)
      throw new Error("INDEPENDENT_HOLD_RELEASE_REQUIRED");
    if (hold.releasedAt) throw new Error("HOLD_ALREADY_RELEASED");
    const released = await tx.documentLegalHold.update({
      where: { id },
      data: { releasedBy: actor.id, releasedAt: new Date() },
    });
    await event(tx, actor.id, hold.propertyId, "retention.hold_released", id, {
      documentId: hold.documentId,
      reason,
    });
    return released;
  });
}

export async function executeDocumentDeletion(actor: Actor, id: string) {
  if (process.env.RETENTION_EXECUTION_ENABLED !== "true")
    throw new Error("RETENTION_EXECUTION_DISABLED");
  const claimed = await transaction(async (tx) => {
    const request = await tx.documentDeletion.findUniqueOrThrow({
      where: { id },
    });
    const doc = await documentPermission(actor, request.documentId, tx);
    if (request.state === "COMPLETED") return { doc, completed: true };
    await tx.$queryRaw`SELECT id FROM "Document" WHERE id=${doc.id} FOR UPDATE`;
    if (
      !["APPROVED", "DELETING", "FAILED"].includes(request.state) ||
      !request.approvedBy ||
      request.approvedBy === request.requestedBy
    )
      throw new Error("INDEPENDENT_DELETION_APPROVAL_REQUIRED");
    const check = await eligibility(tx, doc.id, request.policyId);
    if (check.reason) throw new Error(check.reason);
    if (!/^[A-Za-z0-9_-]+$/.test(doc.storageKey))
      throw new Error("INVALID_STORAGE_KEY");
    await tx.document.update({
      where: { id: doc.id },
      data: { state: "DELETION_PENDING" },
    });
    await tx.documentDeletion.update({
      where: { id },
      data: { state: "DELETING", lastError: null },
    });
    await event(
      tx,
      actor.id,
      doc.propertyId,
      "retention.deletion_claimed",
      id,
      { documentId: doc.id },
    );
    return { doc, completed: false };
  });
  if (claimed.completed) return { id, state: "COMPLETED" };
  try {
    return await transaction(async (tx) => {
      // Backup holds the shared form of this lock across its exported snapshot
      // and file capture. Keep physical unlink and tombstone commit exclusive.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(648271430)`;
      const current = await tx.documentDeletion.findUniqueOrThrow({
        where: { id },
      });
      if (current.state === "COMPLETED") return { id, state: "COMPLETED" };
      await unlink(
        resolve(
          process.env.STORAGE_ROOT || ".data/private",
          claimed.doc.storageKey,
        ),
      ).catch((error: NodeJS.ErrnoException) => {
        // A prior attempt may have unlinked before its completion transaction.
        if (error.code !== "ENOENT") throw error;
      });
      await tx.document.update({
        where: { id: claimed.doc.id },
        data: {
          state: "DELETED",
          deletedAt: new Date(),
          filename: "erased-document",
          reason:
            "Private payload erased under an independently approved retention policy.",
        },
      });
      await tx.documentDeletion.update({
        where: { id },
        data: { state: "COMPLETED", completedAt: new Date(), lastError: null },
      });
      await event(
        tx,
        actor.id,
        claimed.doc.propertyId,
        "retention.document_deleted",
        id,
        {
          documentId: claimed.doc.id,
          hash: claimed.doc.hash,
          policyId: current.policyId,
        },
        claimed.doc.userId,
      );
      return { id, state: "COMPLETED" };
    });
  } catch (error) {
    await transaction(async (tx) => {
      await tx.documentDeletion.updateMany({
        where: { id, state: { not: "COMPLETED" } },
        data: { state: "FAILED", lastError: "PRIVATE_FILE_DELETION_FAILED" },
      });
      await event(
        tx,
        actor.id,
        claimed.doc.propertyId,
        "retention.deletion_failed",
        id,
        { documentId: claimed.doc.id },
      );
    });
    throw error;
  }
}
