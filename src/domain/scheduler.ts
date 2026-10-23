import { db, transaction } from "../lib/db";
import { event } from "./events";
export async function scheduledReminders(now = new Date()) {
  const day = now.toISOString().slice(0, 10);
  const tickets = await db.ticket.findMany({
    where: { dueAt: { lt: now }, status: { notIn: ["RESOLVED", "CLOSED"] } },
    take: 100,
  });
  for (const t of tickets)
    await transaction(async (tx) => {
      const externalId = `sla:${t.id}:${day}`;
      if (
        await tx.inboxEvent.findUnique({
          where: { provider_externalId: { provider: "scheduler", externalId } },
        })
      )
        return;
      await tx.inboxEvent.create({
        data: { provider: "scheduler", externalId, payloadHash: externalId },
      });
      await event(
        tx,
        "scheduler",
        t.propertyId,
        "service_request.sla_escalated",
        t.id,
        {},
        t.userId,
      );
      const staff = await tx.membership.findMany({
        where: {
          propertyId: t.propertyId,
          role: { in: ["ADMIN", "PROPERTY_MANAGER"] },
        },
        distinct: ["userId"],
      });
      for (const m of staff)
        await tx.notification.create({
          data: {
            userId: m.userId,
            title: "Service SLA exceeded",
            body: `Request ${t.id} needs a manager review.`,
          },
        });
    });
  const leases = await db.lease.findMany({
    where: {
      status: "EXECUTED",
      reservation: {
        state: { in: ["ACTIVE", "CONFIRMED"] },
        endAt: { gte: now, lte: new Date(now.getTime() + 30 * 86400000) },
      },
    },
    include: { reservation: true },
    take: 100,
  });
  for (const l of leases)
    await transaction(async (tx) => {
      const externalId = `expiry:${l.id}:${day}`;
      if (
        await tx.inboxEvent.findUnique({
          where: { provider_externalId: { provider: "scheduler", externalId } },
        })
      )
        return;
      await tx.inboxEvent.create({
        data: { provider: "scheduler", externalId, payloadHash: externalId },
      });
      await event(
        tx,
        "scheduler",
        l.propertyId,
        "lease.expiry_reminder",
        l.id,
        { endAt: l.reservation.endAt.toISOString() },
        l.userId,
      );
    });
  return { escalations: tickets.length, leaseReminders: leases.length };
}
