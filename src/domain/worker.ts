import {
  assertNotificationVersion,
  notificationTemplate,
  identityNotification,
} from "./notification-templates";
import { operationalLog, operationalErrorCode } from "../lib/logger";
import { scheduledReminders } from "./scheduler";
import { billCurrentMonth } from "./tenancy";
import { db, transaction } from "../lib/db";
import { token, decrypt, hash } from "../lib/security";
import { expireHolds, offerWaitlist } from "./inventory";
import { scanDocument } from "./documents";
import { reconcilePaynow } from "./paynow";
export async function workOnce() {
  await expireHolds();
  await billCurrentMonth();
  await offerWaitlist();
  await scheduledReminders();
  for (const d of await db.document.findMany({
    where: { state: "QUARANTINED", nextScanAt: { lte: new Date() } },
    take: 10,
  })) {
    try {
      await scanDocument(d.id);
    } catch {
      await db.document.updateMany({
        where: { id: d.id, state: "QUARANTINED" },
        data: { scanResult: "SCANNER_UNAVAILABLE_OR_INTEGRITY_ERROR" },
      });
    }
  }
  // Recover abandoned leases; conditional claim prevents duplicate delivery by active workers.
  const recovered = await db.outboxEvent.updateMany({
    where: {
      state: "PROCESSING",
      lockedAt: { lt: new Date(Date.now() - 5 * 60000) },
    },
    data: { state: "PENDING", lockedAt: null },
  });
  if (recovered.count)
    operationalLog("worker.claims_recovered", {
      count: recovered.count,
      outcome: "recovered",
    });
  let processed = 0;
  const pending = await db.outboxEvent.findMany({
    where: { state: "PENDING", availableAt: { lte: new Date() } },
    take: 25,
    orderBy: { createdAt: "asc" },
  });
  for (const e of pending) {
    const claim = await db.outboxEvent.updateMany({
      where: { id: e.id, state: "PENDING" },
      data: {
        state: "PROCESSING",
        lockedAt: new Date(),
        attempts: { increment: 1 },
      },
    });
    if (!claim.count) continue;
    processed++;
    const started = Date.now();
    try {
      assertNotificationVersion(e.version);
      if (e.type === "announcement.published" && !e.userId)
        await fanOutAnnouncement(e);
      else if (e.type === "paynow.reconcile")
        await reconcilePaynow((e.payload as { paymentId: string }).paymentId);
      else if (
        ["identity.email", "identity.phone", "identity.reset"].includes(e.type)
      ) {
        const u = await db.user.findUniqueOrThrow({ where: { id: e.userId! } });
        const raw = decrypt(
          (e.payload as { encrypted: string }).encrypted,
        ).toString();
        const template = identityNotification(e.type, e.version, raw);
        if (e.type === "identity.phone") {
          if (!process.env.SMSPOP_API_KEY || !process.env.SMSPOP_SENDER_ID)
            throw new Error("SMS_PROVIDER_NOT_CONFIGURED");
          const r = await fetch("https://smspop.co.zw/api/campaigns", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${process.env.SMSPOP_API_KEY}`,
              "Content-Type": "application/json",
              "Idempotency-Key": e.id,
            },
            body: JSON.stringify({
              sender_id: process.env.SMSPOP_SENDER_ID,
              recipients: [u.phone.replace(/^\+/, "")],
              message: template.sms,
            }),
            signal: AbortSignal.timeout(20000),
            redirect: "error",
          });
          if (!r.ok) throw new Error("SMS_DELIVERY_FAILED");
        } else {
          if (!process.env.RESEND_API_KEY || !process.env.EMAIL_FROM)
            throw new Error("EMAIL_PROVIDER_NOT_CONFIGURED");
          const r = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
              "Content-Type": "application/json",
              "Idempotency-Key": e.id,
            },
            body: JSON.stringify({
              from: process.env.EMAIL_FROM,
              to: u.email,
              subject: template.subject,
              text: template.email,
            }),
            signal: AbortSignal.timeout(20000),
            redirect: "error",
          });
          if (!r.ok) throw new Error("EMAIL_DELIVERY_FAILED");
        }
      } else if (e.userId) {
        const template = notificationTemplate(
          e.type,
          e.version,
          process.env.APP_URL || "http://localhost:3001",
        );
        const preference = await db.notificationPreference.findUnique({
          where: { userId: e.userId },
        });
        if (preference?.email !== false) {
          if (!process.env.RESEND_API_KEY || !process.env.EMAIL_FROM)
            throw new Error("EMAIL_PROVIDER_NOT_CONFIGURED");
          const u = await db.user.findUniqueOrThrow({
            where: { id: e.userId },
          });
          const response = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
              "Content-Type": "application/json",
              "Idempotency-Key": e.id,
            },
            body: JSON.stringify({
              from: process.env.EMAIL_FROM,
              to: u.email,
              subject: template.subject,
              text: template.email,
            }),
            signal: AbortSignal.timeout(20000),
            redirect: "error",
          });
          if (!response.ok) throw new Error("EMAIL_DELIVERY_FAILED");
        }
        if (preference?.sms) {
          if (!process.env.SMSPOP_API_KEY || !process.env.SMSPOP_SENDER_ID)
            throw new Error("SMS_PROVIDER_NOT_CONFIGURED");
          const u = await db.user.findUniqueOrThrow({
            where: { id: e.userId! },
          });
          const response = await fetch("https://smspop.co.zw/api/campaigns", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${process.env.SMSPOP_API_KEY}`,
              "Content-Type": "application/json",
              "Idempotency-Key": e.id,
            },
            body: JSON.stringify({
              sender_id: process.env.SMSPOP_SENDER_ID,
              recipients: [u.phone.replace(/^\+/, "")],
              message: template.sms,
            }),
            signal: AbortSignal.timeout(20000),
            redirect: "error",
          });
          if (!response.ok) throw new Error("SMS_DELIVERY_FAILED");
        }
      }
      // DELIVERED means a configured outbound operation succeeded, or an internal event was consumed.

      await db.outboxEvent.update({
        where: { id: e.id },
        data: { state: "DELIVERED", lastError: null, lockedAt: null },
      });
      operationalLog("worker.outbox_completed", {
        jobId: e.id,
        type: e.type,
        propertyId: e.propertyId,
        attempt: e.attempts + 1,
        outcome: e.userId ? "delivered" : "consumed",
        durationMs: Date.now() - started,
        templateVersion: e.version,
        traceId: e.traceId,
      });
    } catch (error) {
      const errorCode = operationalErrorCode(error);
      await db.outboxEvent.update({
        where: { id: e.id },
        data: {
          state: e.attempts >= 4 ? "DEAD" : "PENDING",
          lastError: errorCode,
          lockedAt: null,
          availableAt: new Date(
            Date.now() + Math.min(3600, 2 ** (e.attempts + 1) * 30) * 1000,
          ),
        },
      });
      operationalLog(
        "worker.outbox_failed",
        {
          jobId: e.id,
          type: e.type,
          propertyId: e.propertyId,
          attempt: e.attempts + 1,
          outcome: e.attempts >= 4 ? "dead" : "retry",
          errorCode,
          durationMs: Date.now() - started,
          templateVersion: e.version,
          traceId: e.traceId,
        },
        "error",
      );
    }
  }
  return { processed, trace: token().slice(0, 8) };
}

async function fanOutAnnouncement(job: {
  id: string;
  propertyId: string | null;
  payload: unknown;
  version: number;
  traceId: string;
}) {
  const announcementId = (job.payload as { objectId?: string })?.objectId;
  if (!announcementId || !job.propertyId)
    throw new Error("ANNOUNCEMENT_SCOPE_MISMATCH");
  await transaction(async (tx) => {
    const announcement = await tx.announcement.findUnique({
      where: { id: announcementId },
    });
    if (!announcement || announcement.propertyId !== job.propertyId)
      throw new Error("ANNOUNCEMENT_SCOPE_MISMATCH");
    let cursor: string | undefined;
    while (true) {
      const recipients = await tx.user.findMany({
        where: {
          active: true,
          OR: [
            { memberships: { some: { propertyId: job.propertyId! } } },
            {
              applications: {
                some: {
                  propertyId: job.propertyId!,
                  status: { notIn: ["DECLINED", "WITHDRAWN", "ENDED"] },
                },
              },
            },
          ],
        },
        select: { id: true },
        orderBy: { id: "asc" },
        take: 100,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      const data = recipients.map((user) => ({
        id: `notice_${hash(`${job.id}:${user.id}`)}`,
        userId: user.id,
      }));
      await tx.notification.createMany({
        data: data.map((entry) => ({
          ...entry,
          title: "New property notice",
          body: "Read the complete property notice in your portal.",
        })),
        skipDuplicates: true,
      });
      await tx.outboxEvent.createMany({
        data: data.map((entry) => ({
          ...entry,
          propertyId: job.propertyId,
          type: "announcement.available",
          version: job.version,
          traceId: job.traceId,
          payload: { objectId: announcement.id },
        })),
        skipDuplicates: true,
      });
      if (recipients.length < 100) break;
      cursor = recipients.at(-1)!.id;
    }
  });
}
