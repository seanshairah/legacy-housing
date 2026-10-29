import { z } from "zod";
import { db, transaction, type Tx } from "../lib/db";
import { type Actor, permit, ownerOrPermit } from "./access";
import { event } from "./events";
async function activeActor(actor: Actor, client: Tx | typeof db = db) {
  const user = await client.user.findUnique({
    where: { id: actor.id },
    select: { active: true },
  });
  if (!user?.active) throw new Error("UNAUTHENTICATED");
}
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
    await activeActor(actor, tx);
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
const booleanInput = z.preprocess(
  (value) =>
    value === "on" || value === "true"
      ? true
      : value === undefined || value === "" || value === "false"
        ? false
        : value,
  z.boolean(),
);
export async function getTicketThread(
  actor: Actor,
  id: string,
  includeInternal = false,
) {
  await activeActor(actor);
  const ticket = await db.ticket.findUniqueOrThrow({ where: { id } });
  await ownerOrPermit(actor, ticket.userId, ticket.propertyId, "operations");
  if (includeInternal) await permit(actor, ticket.propertyId, "operations");
  const messages = await db.ticketMessage.findMany({
    where: { ticketId: id, ...(includeInternal ? {} : { internal: false }) },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  return { ...ticket, messages };
}
export async function updateTicket(actor: Actor, id: string, input: unknown) {
  const d = z
    .object({
      status: z.enum(["OPEN", "IN_PROGRESS", "WAITING", "RESOLVED", "CLOSED"]),
      body: z.string().trim().min(2).max(5000),
      internal: booleanInput,
      resolutionConfirmed: booleanInput,
      assignedTo: z.string().optional(),
      documentId: z.preprocess(
        (v) => (v === "" ? undefined : v),
        z.string().optional(),
      ),
    })
    .parse(input);
  return transaction(async (tx) => {
    await activeActor(actor, tx);
    const t = await tx.ticket.findUniqueOrThrow({ where: { id } });
    await ownerOrPermit(actor, t.userId, t.propertyId, "operations", tx);
    const own = t.userId === actor.id;
    if (d.internal) {
      await permit(actor, t.propertyId, "operations", tx);
      // Notes remain staff-only and cannot cause an otherwise hidden state change.
      if (d.status !== t.status || d.assignedTo || d.resolutionConfirmed)
        throw new Error("INTERNAL_NOTE_CANNOT_CHANGE_STATE");
    } else {
      if (own && d.assignedTo) throw new Error("FORBIDDEN");
      if (own && !["OPEN", "CLOSED"].includes(d.status))
        throw new Error("STAFF_TRANSITION_REQUIRED");
      if (d.resolutionConfirmed && !own) throw new Error("FORBIDDEN");
      if (d.resolutionConfirmed && d.status !== "CLOSED")
        throw new Error("RESOLUTION_CONFIRMATION_REQUIRES_CLOSURE");
      if (
        own &&
        d.status === "CLOSED" &&
        (!d.resolutionConfirmed || !["RESOLVED", "CLOSED"].includes(t.status))
      )
        throw new Error("RESOLUTION_CONFIRMATION_REQUIRED");
      const transitions: Record<string, readonly string[]> = {
        OPEN: ["OPEN", "IN_PROGRESS", "WAITING", "RESOLVED"],
        IN_PROGRESS: ["OPEN", "IN_PROGRESS", "WAITING", "RESOLVED"],
        WAITING: ["OPEN", "IN_PROGRESS", "WAITING", "RESOLVED"],
        RESOLVED: ["OPEN", "RESOLVED", "CLOSED"],
        CLOSED: ["OPEN", "CLOSED"],
      };
      if (!transitions[t.status]?.includes(d.status))
        throw new Error("INVALID_TICKET_TRANSITION");
    }
    if (d.assignedTo) {
      const m = await tx.membership.findFirst({
        where: {
          userId: d.assignedTo,
          propertyId: t.propertyId,
          role: {
            in: [
              "ADMIN",
              "CARETAKER",
              "MAINTENANCE_OFFICER",
              "PROPERTY_MANAGER",
            ],
          },
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
    const reopened =
      !d.internal &&
      ["CLOSED", "RESOLVED"].includes(t.status) &&
      d.status === "OPEN";
    await tx.ticket.update({
      where: { id },
      data: {
        ...(!d.internal
          ? {
              status: d.status,
              assignedTo: d.assignedTo || undefined,
              firstResponseAt:
                !own && !t.firstResponseAt ? new Date() : undefined,
              resolvedAt: ["RESOLVED", "CLOSED"].includes(d.status)
                ? t.resolvedAt || new Date()
                : null,
              resolutionConfirmedAt: reopened
                ? null
                : d.resolutionConfirmed
                  ? t.resolutionConfirmedAt || new Date()
                  : undefined,
              resolutionConfirmedBy: reopened
                ? null
                : d.resolutionConfirmed
                  ? actor.id
                  : undefined,
              reopenedCount: reopened ? { increment: 1 } : undefined,
            }
          : {}),
        messages: {
          create: {
            actorId: actor.id,
            body: d.body,
            documentId: d.documentId,
            internal: d.internal,
          },
        },
      },
    });
    await event(
      tx,
      actor.id,
      t.propertyId,
      d.internal
        ? "service_request.internal_note_added"
        : "service_request.updated",
      id,
      {
        status: d.status,
        previousStatus: t.status,
        internal: d.internal,
        reopened,
        resolutionConfirmed: d.resolutionConfirmed,
      },
      d.internal ? undefined : t.userId,
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
