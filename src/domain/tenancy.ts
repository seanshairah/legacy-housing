import { quoteBed, quoteSlice, priceJson, type PriceSnapshot } from "./pricing";
import { z } from "zod";
import { db, transaction } from "../lib/db";
import { type Actor, permit } from "./access";
import { event } from "./events";
import { datesSchema } from "./inventory";
import { account } from "./finance";
export async function requestTenancyChange(actor: Actor, input: unknown) {
  const d = z
    .object({
      leaseId: z.string(),
      type: z.enum(["RENEWAL", "TRANSFER"]),
      targetBedId: z.string(),
      startAt: z.coerce.date(),
      endAt: z.coerce.date(),
      reason: z.string().min(10).max(2000),
    })
    .parse(input);
  datesSchema.parse(d);
  return transaction(async (tx) => {
    const l = await tx.lease.findUniqueOrThrow({
      where: { id: d.leaseId },
      include: { reservation: true },
    });
    if (
      l.userId !== actor.id ||
      l.status !== "EXECUTED" ||
      !["ACTIVE", "CONFIRMED"].includes(l.reservation.state)
    )
      throw new Error("TENANCY_CHANGE_DENIED");
    if (
      d.type === "RENEWAL" &&
      d.startAt.getTime() !== l.reservation.endAt.getTime()
    )
      throw new Error("RENEWAL_MUST_FOLLOW_EXISTING_TERM");
    if (
      d.type === "TRANSFER" &&
      (d.startAt < new Date() || d.startAt >= l.reservation.endAt)
    )
      throw new Error("INVALID_TRANSFER_DATE");
    const b = await tx.bed.findUniqueOrThrow({
      where: { id: d.targetBedId },
      include: {
        room: { include: { floor: { include: { building: true } } } },
      },
    });
    if (b.blocked || b.room.floor.building.propertyId !== l.propertyId)
      throw new Error("BED_UNAVAILABLE");
    const existing = await tx.tenancyRequest.findFirst({
      where: { leaseId: l.id, state: "PENDING" },
    });
    if (existing) throw new Error("EXISTING_TENANCY_REQUEST");
    const r = await tx.tenancyRequest.create({
      data: { ...d, userId: actor.id, propertyId: l.propertyId },
    });
    await event(
      tx,
      actor.id,
      l.propertyId,
      "tenancy.change_requested",
      r.id,
      { type: d.type },
      actor.id,
    );
    return r;
  });
}
export async function reviewTenancyChange(
  actor: Actor,
  id: string,
  approved: boolean,
  reason: string,
) {
  if (!reason.trim()) throw new Error("REASON_REQUIRED");
  return transaction(async (tx) => {
    const r = await tx.tenancyRequest.findUniqueOrThrow({ where: { id } });
    await permit(actor, r.propertyId, "leases", tx);
    if (r.state !== "PENDING" || r.userId === actor.id)
      throw new Error("TENANCY_REVIEW_INVALID");
    if (!approved) {
      await tx.tenancyRequest.update({
        where: { id },
        data: { state: "DECLINED", reviewedBy: actor.id, reviewReason: reason },
      });
      await event(
        tx,
        actor.id,
        r.propertyId,
        "tenancy.change_declined",
        id,
        { reason },
        r.userId,
      );
      return;
    }
    const l = await tx.lease.findUniqueOrThrow({
      where: { id: r.leaseId },
      include: { reservation: true },
    });
    if ((await account(r.userId, r.propertyId, tx)).outstanding > 0n)
      throw new Error("CLEAR_ARREARS_BEFORE_CHANGE");
    const b = await tx.bed.findUniqueOrThrow({ where: { id: r.targetBedId } });
    if (b.blocked) throw new Error("BED_UNAVAILABLE");
    await tx.$queryRaw`SELECT id FROM "Bed" WHERE id=${r.targetBedId} FOR UPDATE`;
    await tx.reservation.updateMany({
      where: {
        bedId: r.targetBedId,
        state: "HOLD",
        expiresAt: { lte: new Date() },
      },
      data: { state: "EXPIRED" },
    });
    // Existing executed agreement is never edited. Reservation segment ends at the approved transfer boundary.
    if (r.type === "TRANSFER")
      await tx.reservation.update({
        where: { id: l.reservationId },
        data: { endAt: r.startAt },
      });
    const application = await tx.application.create({
      data: {
        userId: r.userId,
        propertyId: r.propertyId,
        status: "LEASE_SIGNING_PENDING",
        history: {
          create: { actorId: actor.id, status: "CHANGE_APPROVED", reason },
        },
      },
    });
    await tx.reservation.create({
      data: {
        userId: r.userId,
        propertyId: r.propertyId,
        bedId: r.targetBedId,
        priceSnapshot: priceJson(
          await quoteBed(tx, r.targetBedId, r.startAt, r.endAt),
        ),
        applicationId: application.id,
        startAt: r.startAt,
        endAt: r.endAt,
        state: "CONFIRMED",
      },
    });
    await tx.tenancyRequest.update({
      where: { id },
      data: {
        state: "APPROVED",
        reviewedBy: actor.id,
        reviewReason: reason,
        newApplicationId: application.id,
      },
    });
    await tx.leaseEvent.create({
      data: {
        leaseId: l.id,
        actorId: actor.id,
        type: r.type,
        evidence: {
          requestId: id,
          newApplicationId: application.id,
          startAt: r.startAt.toISOString(),
          endAt: r.endAt.toISOString(),
          reason,
        },
      },
    });
    await event(
      tx,
      actor.id,
      r.propertyId,
      "tenancy.change_approved",
      id,
      { newApplicationId: application.id },
      r.userId,
    );
    return application;
  });
}
export async function billCurrentMonth(now = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
    end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)),
    month = start.toISOString().slice(0, 7);
  const leases = await db.lease.findMany({
    where: {
      status: "EXECUTED",
      reservation: {
        state: { in: ["ACTIVE", "CONFIRMED"] },
        startAt: { lt: end },
        endAt: { gt: start },
      },
    },
    include: {
      property: true,
      reservation: { include: { bed: { include: { room: true } } } },
    },
  });
  for (const l of leases)
    await transaction(async (tx) => {
      const reference = `RENT-${l.reservationId}-${month}`;
      if (await tx.charge.findUnique({ where: { reference } })) return;
      const s = l.reservation.startAt > start ? l.reservation.startAt : start,
        e = l.reservation.endAt < end ? l.reservation.endAt : end;
      const days = BigInt(
          Math.max(0, Math.ceil((e.getTime() - s.getTime()) / 86400000)),
        ),
        monthDays = BigInt((end.getTime() - start.getTime()) / 86400000);
      const amountMinor = l.reservation.priceSnapshot
        ? quoteSlice(
            l.reservation.priceSnapshot as unknown as PriceSnapshot,
            s,
            e,
          )
        : (l.reservation.bed.room.monthlyMinor * days + monthDays / 2n) /
          monthDays;
      if (amountMinor === 0n) return;
      const c = await tx.charge.create({
        data: {
          userId: l.userId,
          propertyId: l.propertyId,
          reference,
          category: "RENT",
          description: `Rent ${month} (${days}/${monthDays} days; configured room rate)`,
          amountMinor,
          currency: l.property.currency,
          dueAt: s,
        },
      });
      await event(
        tx,
        "billing-worker",
        l.propertyId,
        "invoice.issued",
        c.id,
        { amountMinor: String(amountMinor) },
        l.userId,
      );
    });
  return leases.length;
}
