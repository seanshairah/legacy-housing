import { z } from "zod";
import { db, transaction } from "../lib/db";
import { type Actor, permit, ownerOrPermit } from "./access";
import { event } from "./events";
export async function createTicket(actor: Actor, input: unknown) {
  const d = z
    .object({
      propertyId: z.string(),
      type: z.enum(["MAINTENANCE", "COMPLAINT", "COMPLIMENT", "SUPPORT"]),
      category: z.string().min(2).max(80),
      priority: z.enum(["NORMAL", "HIGH", "URGENT"]),
      subject: z.string().min(4).max(160),
      body: z.string().min(10).max(5000),
    })
    .parse(input);
  return transaction(async (tx) => {
    const resident = await tx.application.findFirst({
      where: {
        userId: actor.id,
        propertyId: d.propertyId,
        status: { notIn: ["DECLINED", "WITHDRAWN", "ENDED"] },
      },
    });
    if (!resident) await permit(actor, d.propertyId, "operations", tx);
    const ticket = await tx.ticket.create({
      data: {
        ...d,
        userId: actor.id,
        dueAt: new Date(
          Date.now() +
            { URGENT: 4, HIGH: 24, NORMAL: 72 }[d.priority] * 3600000,
        ),
      },
    });
    await event(
      tx,
      actor.id,
      d.propertyId,
      "service_request.created",
      ticket.id,
      {},
      actor.id,
    );
    return ticket;
  });
}
export async function updateTicket(actor: Actor, id: string, input: unknown) {
  const d = z
    .object({
      status: z.enum(["OPEN", "IN_PROGRESS", "WAITING", "RESOLVED", "CLOSED"]),
      body: z.string().min(2).max(5000),
      assignedTo: z.string().optional(),
      documentId: z.string().optional(),
    })
    .parse(input);
  return transaction(async (tx) => {
    const t = await tx.ticket.findUniqueOrThrow({ where: { id } });
    await ownerOrPermit(actor, t.userId, t.propertyId, "operations", tx);
    const own = t.userId === actor.id;
    if (own && d.assignedTo) throw new Error("FORBIDDEN");
    if (own && !["OPEN", "CLOSED"].includes(d.status))
      throw new Error("STAFF_TRANSITION_REQUIRED");
    if (d.assignedTo) {
      const m = await tx.membership.findFirst({
        where: {
          userId: d.assignedTo,
          propertyId: t.propertyId,
          role: { in: ["ADMIN", "CARETAKER", "PROPERTY_MANAGER"] },
        },
      });
      if (!m) throw new Error("INVALID_ASSIGNEE");
    }
    if (d.documentId) {
      const doc = await tx.document.findUnique({ where: { id: d.documentId } });
      if (
        !doc ||
        doc.userId !== actor.id ||
        doc.propertyId !== t.propertyId ||
        !["CLEAN", "APPROVED"].includes(doc.state) ||
        doc.kind !== "SUPPORT"
      )
        throw new Error("INVALID_ATTACHMENT");
    }
    await tx.ticket.update({
      where: { id },
      data: {
        status: d.status,
        assignedTo: d.assignedTo || undefined,
        firstResponseAt: !own && !t.firstResponseAt ? new Date() : undefined,
        resolvedAt: ["RESOLVED", "CLOSED"].includes(d.status)
          ? new Date()
          : null,
        messages: {
          create: { actorId: actor.id, body: d.body, documentId: d.documentId },
        },
      },
    });
    await event(
      tx,
      actor.id,
      t.propertyId,
      "service_request.updated",
      id,
      {
        status: d.status,
        previousStatus: t.status,
        reopened:
          ["CLOSED", "RESOLVED"].includes(t.status) && d.status === "OPEN",
      },
      t.userId,
    );
  });
}
export async function propertyMetrics(actor: Actor, propertyId: string) {
  await permit(actor, propertyId, "reports");
  const [beds, active, tickets] = await Promise.all([
    db.bed.count({ where: { room: { floor: { building: { propertyId } } } } }),
    db.reservation.count({ where: { propertyId, state: "ACTIVE" } }),
    db.ticket.findMany({ where: { propertyId } }),
  ]);
  const responded = tickets.filter((t) => t.firstResponseAt),
    resolved = tickets.filter((t) => t.resolvedAt);
  return {
    beds,
    occupied: active,
    occupancyPercent: beds ? Math.round((active / beds) * 100) : 0,
    openTickets: tickets.filter(
      (t) => !["RESOLVED", "CLOSED"].includes(t.status),
    ).length,
    overdueTickets: tickets.filter(
      (t) => !["RESOLVED", "CLOSED"].includes(t.status) && t.dueAt < new Date(),
    ).length,
    meanFirstResponseHours: responded.length
      ? responded.reduce(
          (n, t) =>
            n +
            (t.firstResponseAt!.getTime() - t.createdAt.getTime()) / 3600000,
          0,
        ) / responded.length
      : null,
    meanResolutionHours: resolved.length
      ? resolved.reduce(
          (n, t) =>
            n + (t.resolvedAt!.getTime() - t.createdAt.getTime()) / 3600000,
          0,
        ) / resolved.length
      : null,
  };
}
