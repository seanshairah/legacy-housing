import { db, transaction } from "../lib/db";
import { event } from "./events";
export async function scheduledReminders(now = new Date()) {
  const day = now.toISOString().slice(0, 10);
  let ticketCursor: string | undefined, leaseCursor: string | undefined;
  let escalations = 0,
    leaseReminders = 0;
  while (true) {
    const tickets = await db.ticket.findMany({
      where: { dueAt: { lt: now }, status: { notIn: ["RESOLVED", "CLOSED"] } },
      orderBy: { id: "asc" },
      ...(ticketCursor ? { cursor: { id: ticketCursor }, skip: 1 } : {}),
      take: 100,
    });
    for (const t of tickets) {
      const created = await transaction(async (tx) => {
        const externalId = `sla:${t.id}:${day}`;
        if (
          await tx.inboxEvent.findUnique({
            where: {
              provider_externalId: { provider: "scheduler", externalId },
            },
          })
        )
          return false;
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
        return true;
      });
      if (created) escalations++;
    }
    if (tickets.length < 100) break;
    ticketCursor = tickets.at(-1)!.id;
  }
  while (true) {
    const leases = await db.lease.findMany({
      where: {
        status: "EXECUTED",
        reservation: {
          state: { in: ["ACTIVE", "CONFIRMED"] },
          endAt: { gte: now, lte: new Date(now.getTime() + 30 * 86400000) },
        },
      },
      include: { reservation: true },
      orderBy: { id: "asc" },
      ...(leaseCursor ? { cursor: { id: leaseCursor }, skip: 1 } : {}),
      take: 100,
    });
    for (const l of leases) {
      const created = await transaction(async (tx) => {
        const externalId = `expiry:${l.id}:${day}`;
        if (
          await tx.inboxEvent.findUnique({
            where: {
              provider_externalId: { provider: "scheduler", externalId },
            },
          })
        )
          return false;
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
        return true;
      });
      if (created) leaseReminders++;
    }
    if (leases.length < 100) break;
    leaseCursor = leases.at(-1)!.id;
  }
  return { escalations, leaseReminders };
}
