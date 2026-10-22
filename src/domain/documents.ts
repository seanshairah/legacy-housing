import { spawn } from "node:child_process";
import { mkdir, writeFile, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import { z } from "zod";
import { db, transaction } from "../lib/db";
import { hash, token, encrypt, decrypt } from "../lib/security";
import { type Actor, permit } from "./access";
import { event } from "./events";
const kinds = z.enum([
  "IDENTITY",
  "REGISTRATION",
  "RESIDENCE",
  "SPONSOR",
  "MEDICAL",
  "PAYMENT_PROOF",
  "SIGNED_LEASE",
  "SUPPORT",
]);
function storagePath(key: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(key)) throw new Error("INVALID_STORAGE_KEY");
  return path.resolve(process.env.STORAGE_ROOT || ".data/private", key);
}
export async function upload(
  actor: Actor,
  input: {
    propertyId: string;
    applicationId?: string;
    kind: string;
    filename: string;
    bytes: Buffer;
    medicalConsent?: boolean;
  },
) {
  const kind = kinds.parse(input.kind);
  if (kind === "MEDICAL" && !input.medicalConsent)
    throw new Error("EXPLICIT_MEDICAL_CONSENT_REQUIRED");
  const user = await db.user.findUniqueOrThrow({ where: { id: actor.id } });
  if (!user.emailVerifiedAt || !user.phoneVerifiedAt)
    throw new Error("VERIFY_EMAIL_AND_PHONE");
  const app = await db.application.findFirst({
    where: {
      userId: actor.id,
      propertyId: input.propertyId,
      ...(input.applicationId ? { id: input.applicationId } : {}),
    },
  });
  if (!app) throw new Error("APPLICATION_REQUIRED");
  if (input.bytes.length < 4 || input.bytes.length > 10 * 1024 * 1024)
    throw new Error("FILE_SIZE_LIMIT_10MB");
  const b = input.bytes;
  const mime =
    b.subarray(0, 5).toString() === "%PDF-"
      ? "application/pdf"
      : b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        ? "image/png"
        : b[0] === 255 && b[1] === 216 && b[2] === 255
          ? "image/jpeg"
          : null;
  if (!mime) throw new Error("ONLY_PDF_PNG_JPEG");
  // No caller path or original filename is used in storage. Payload never becomes public.
  const key = token();
  await mkdir(path.dirname(storagePath(key)), { recursive: true, mode: 0o700 });
  await writeFile(storagePath(key), encrypt(b, "FILE_KEY"), {
    mode: 0o600,
    flag: "wx",
  });
  try {
    return await transaction(async (tx) => {
      const version =
        (await tx.document.count({
          where: { userId: actor.id, applicationId: app.id, kind },
        })) + 1;
      if (kind === "MEDICAL")
        await tx.consent.create({
          data: {
            userId: actor.id,
            purpose: "MEDICAL_DECLARATION",
            version: "v1",
            documentHash: hash(
              "I explicitly consent to the selected property authorized medical reviewers processing this voluntary medical declaration for accommodation support. I understand it is restricted separately from standard KYC.",
            ),
          },
        });
      const doc = await tx.document.create({
        data: {
          userId: actor.id,
          propertyId: input.propertyId,
          applicationId: app.id,
          kind,
          filename: input.filename.replace(/[^\w. -]/g, "_").slice(0, 120),
          mime,
          bytes: b.length,
          hash: hash(b),
          storageKey: key,
          version,
        },
      });
      await event(tx, actor.id, input.propertyId, "document.uploaded", doc.id, {
        kind,
        version,
      });
      return doc;
    });
  } catch (e) {
    await unlink(storagePath(key));
    throw e;
  }
}
export async function scanBytes(bytes: Buffer): Promise<"CLEAN" | "INFECTED"> {
  // ClamAV INSTREAM: daemon must return an explicit OK; outages never approve files.
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({
      host: process.env.CLAMAV_HOST || "127.0.0.1",
      port: Number(process.env.CLAMAV_PORT || 3310),
    });
    let reply = "";
    socket.setTimeout(20000);
    socket.on("timeout", () => socket.destroy(new Error("SCANNER_TIMEOUT")));
    socket.on("error", reject);
    socket.on("connect", () => {
      socket.write("zINSTREAM\0");
      for (let i = 0; i < bytes.length; i += 65536) {
        const chunk = bytes.subarray(i, i + 65536),
          length = Buffer.alloc(4);
        length.writeUInt32BE(chunk.length);
        socket.write(length);
        socket.write(chunk);
      }
      socket.write(Buffer.alloc(4));
    });
    socket.on("data", (chunk) => {
      reply += chunk.toString();
      if (reply.includes("\0")) socket.end();
    });
    socket.on("end", () => {
      if (reply.includes("FOUND")) resolve("INFECTED");
      else if (reply.includes(": OK")) resolve("CLEAN");
      else reject(new Error("SCANNER_INVALID_RESPONSE"));
    });
  });
}
async function validatePrivateBytes(bytes: Buffer, mime: string) {
  return new Promise<boolean>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--max-old-space-size=128",
        "--import",
        "tsx",
        "scripts/validate-file.ts",
        mime,
      ],
      {
        env: { PATH: process.env.PATH, NODE_ENV: "production" },
        stdio: ["pipe", "ignore", "ignore"],
      },
    );
    const timeout = setTimeout(() => child.kill("SIGKILL"), 10000);
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.stdin.on("error", () => {
      /* A bounded validator may exit before reading all bytes. */
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve(true);
      else if (code === 42) resolve(false);
      else reject(new Error("VALIDATOR_UNAVAILABLE_OR_RESOURCE_LIMIT"));
    });
    child.stdin.end(bytes);
  });
}
export async function scanDocument(id: string) {
  const doc = await db.document.findUniqueOrThrow({ where: { id } });
  if (doc.state !== "QUARANTINED") return;
  const bytes = decrypt(
    await readFile(storagePath(doc.storageKey), "utf8"),
    "FILE_KEY",
  );
  if (hash(bytes) !== doc.hash) throw new Error("DOCUMENT_INTEGRITY_FAILED");
  if (!(await validatePrivateBytes(bytes, doc.mime))) {
    await transaction(async (tx) => {
      await tx.document.updateMany({
        where: { id, state: "QUARANTINED" },
        data: {
          state: "REJECTED",
          scanResult: "FORMAT_REJECTED",
          reason:
            "File format or content validation failed. Submit a standard PDF, PNG or JPEG.",
        },
      });
      await event(
        tx,
        "validator",
        doc.propertyId,
        "document.rejected",
        id,
        { reason: "FORMAT_REJECTED" },
        doc.userId,
      );
    });
    return;
  }
  const result = await scanBytes(bytes);
  await transaction(async (tx) => {
    await tx.document.updateMany({
      where: { id, state: "QUARANTINED" },
      data: {
        state: result === "CLEAN" ? "CLEAN" : "REJECTED",
        scanResult: result,
      },
    });
    await event(
      tx,
      "scanner",
      doc.propertyId,
      "document.scanned",
      id,
      { result },
      doc.userId,
    );
  });
}
export async function reviewDocument(
  actor: Actor,
  id: string,
  approved: boolean,
  reason: string,
) {
  return transaction(async (tx) => {
    const doc = await tx.document.findUniqueOrThrow({ where: { id } });
    await permit(
      actor,
      doc.propertyId,
      doc.kind === "MEDICAL"
        ? "medical"
        : doc.kind === "PAYMENT_PROOF"
          ? "finance"
          : "kyc",
      tx,
    );
    if (doc.userId === actor.id || doc.state !== "CLEAN" || !reason.trim())
      throw new Error("DOCUMENT_REVIEW_INVALID");
    await tx.document.update({
      where: { id },
      data: {
        state: approved ? "APPROVED" : "REJECTED",
        reviewerId: actor.id,
        reason,
      },
    });
    await event(
      tx,
      actor.id,
      doc.propertyId,
      approved ? "kyc.approved" : "kyc.rejected",
      id,
      { reason },
      doc.userId,
    );
  });
}
export async function download(actor: Actor, id: string) {
  const doc = await db.document.findUniqueOrThrow({ where: { id } });
  if (doc.userId !== actor.id)
    await permit(
      actor,
      doc.propertyId,
      doc.kind === "MEDICAL"
        ? "medical"
        : doc.kind === "PAYMENT_PROOF"
          ? "finance"
          : doc.kind === "SIGNED_LEASE"
            ? "leases"
            : "kyc",
    );
  if (!["CLEAN", "APPROVED"].includes(doc.state))
    throw new Error("DOCUMENT_QUARANTINED_OR_REJECTED");
  const bytes = decrypt(
    await readFile(storagePath(doc.storageKey), "utf8"),
    "FILE_KEY",
  );
  if (hash(bytes) !== doc.hash) throw new Error("DOCUMENT_INTEGRITY_FAILED");
  await transaction((tx) =>
    event(tx, actor.id, doc.propertyId, "document.downloaded", id),
  );
  return { doc, bytes };
}
