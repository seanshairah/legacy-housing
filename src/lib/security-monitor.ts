import { transaction } from "./db";
import { hash } from "./security";
import { randomUUID } from "node:crypto";
export async function securitySignal(input: {
  kind: string;
  subject: string;
  propertyId?: string;
  actorId?: string;
}) {
  const now = new Date(),
    subjectHash = hash(input.subject),
    bucket = now.toISOString().slice(0, 13);
  const threshold = ["MALWARE_DETECTED", "SCAN_EXHAUSTED"].includes(input.kind)
    ? 1
    : 5;
  return transaction(async (tx) => {
    const alert = await tx.securityAlert.upsert({
      where: {
        dedupeKey: hash(
          `${input.kind}:${input.propertyId || "global"}:${subjectHash}:${bucket}`,
        ),
      },
      create: {
        dedupeKey: hash(
          `${input.kind}:${input.propertyId || "global"}:${subjectHash}:${bucket}`,
        ),
        propertyId: input.propertyId,
        kind: input.kind,
        subjectHash,
        severity: threshold === 1 ? "HIGH" : "LOW",
      },
      update: { occurrences: { increment: 1 }, lastSeenAt: now },
    });
    await tx.auditEvent.create({
      data: {
        actorId: input.actorId || "security-monitor",
        propertyId: input.propertyId,
        action: `security.${input.kind.toLowerCase()}`,
        objectId: alert.id,
        detail: { subjectHash },
        traceId: randomUUID(),
      },
    });
    const reopened = alert.occurrences >= threshold && alert.state !== "OPEN";
    if (
      alert.occurrences >= threshold &&
      (alert.severity !== "HIGH" || reopened)
    )
      await tx.securityAlert.update({
        where: { id: alert.id },
        data: { severity: "HIGH", state: "OPEN" },
      });
    if (alert.occurrences === threshold || reopened) {
      const admins = await tx.membership.findMany({
        where: {
          role: "ADMIN",
          ...(input.propertyId ? { propertyId: input.propertyId } : {}),
        },
        select: { userId: true },
        distinct: ["userId"],
      });
      for (const a of admins) {
        if (!input.propertyId) {
          const missing = await tx.property.count({
            where: {
              memberships: { none: { userId: a.userId, role: "ADMIN" } },
            },
          });
          if (missing) continue;
        }
        await tx.notification.create({
          data: {
            userId: a.userId,
            title: "Security review required",
            body: `${input.kind.replaceAll("_", " ")}. Open the security workspace. Reference ${alert.id}.`,
          },
        });
      }
    }
    return alert;
  });
}
