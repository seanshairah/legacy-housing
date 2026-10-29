import { Prisma } from "@prisma/client";
import { db } from "../lib/db";
import { type Actor, permit } from "./access";
export type ReportFilters = {
  from?: string;
  to?: string;
  building?: string;
  floor?: string;
  room?: string;
};
export function reportPeriod(filters: ReportFilters) {
  const from = filters.from ? new Date(filters.from) : undefined,
    to = filters.to ? new Date(filters.to) : undefined;
  if (
    (from && isNaN(from.getTime())) ||
    (to && isNaN(to.getTime())) ||
    (from && to && to <= from)
  )
    throw new Error("INVALID_REPORT_PERIOD");
  return {
    from,
    to,
    range: { ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) },
  };
}
async function population(propertyId: string, filters: ReportFilters) {
  const roomWhere: Prisma.RoomWhereInput = {
    ...(filters.room ? { id: filters.room } : {}),
    floor: {
      ...(filters.floor ? { id: filters.floor } : {}),
      building: {
        propertyId,
        ...(filters.building ? { id: filters.building } : {}),
      },
    },
  };
  const rooms = await db.room.findMany({
    where: roomWhere,
    include: { beds: true },
  });
  const ids = rooms.map((r) => r.id);
  const userWhere: Prisma.UserWhereInput =
    filters.building || filters.floor || filters.room
      ? { reservations: { some: { propertyId, bed: { roomId: { in: ids } } } } }
      : {};
  return { rooms, ids, userWhere };
}
const sum = (values: bigint[]) => values.reduce((a, b) => a + b, 0n);
export const ratio = (numerator: bigint, denominator: bigint) =>
  denominator > 0n ? Number((numerator * 10000n) / denominator) / 100 : null;
export async function financialReconciliation(
  actor: Actor,
  propertyId: string,
  filters: ReportFilters = {},
  now = new Date(),
) {
  await permit(actor, propertyId, "finance.read");
  const { range } = reportPeriod(filters),
    { userWhere } = await population(propertyId, filters);
  const [property, charges, payments] = await Promise.all([
    db.property.findUniqueOrThrow({ where: { id: propertyId } }),
    db.charge.findMany({
      where: { propertyId, dueAt: range, user: userWhere },
      include: {
        user: { select: { id: true, name: true } },
        credits: true,
        allocations: { include: { reversals: true } },
      },
      orderBy: { dueAt: "asc" },
    }),
    db.payment.findMany({
      where: { propertyId, createdAt: range, user: userWhere },
      include: {
        refunds: true,
        allocations: { include: { reversals: true } },
        receipt: true,
      },
      orderBy: { createdAt: "asc" },
    }),
  ]);
  const invoices = charges.map((c) => {
    const credited = sum(c.credits.map((v) => v.amountMinor)),
      allocated = sum(
        c.allocations.map(
          (a) => a.amountMinor - sum(a.reversals.map((r) => r.amountMinor)),
        ),
      );
    return {
      id: c.id,
      reference: c.reference,
      userId: c.userId,
      resident: c.user.name,
      category: c.category,
      dueAt: c.dueAt,
      netDue: c.amountMinor - credited,
      allocated,
      outstanding: c.amountMinor - credited - allocated,
    };
  });
  const transactions = payments.map((p) => {
    const settled = ["PAID", "REFUNDED", "PARTIALLY_REFUNDED"].includes(
        p.status,
      ),
      refunded = sum(p.refunds.map((r) => r.amountMinor)),
      allocated = sum(
        p.allocations.map(
          (a) => a.amountMinor - sum(a.reversals.map((r) => r.amountMinor)),
        ),
      );
    const verified = settled ? p.amountMinor - refunded : 0n;
    return {
      id: p.id,
      reference: p.reference,
      method: p.method,
      status: p.status,
      createdAt: p.createdAt,
      received: settled ? p.amountMinor : 0n,
      refunded,
      verified,
      allocated,
      unallocated: verified - allocated,
      receipt: p.receipt?.number || null,
      exception:
        settled && !p.receipt
          ? "MISSING_RECEIPT"
          : allocated > verified
            ? "ALLOCATION_EXCEEDS_VERIFIED_FUNDS"
            : !settled && allocated > 0n
              ? "UNSETTLED_ALLOCATION"
              : null,
    };
  });
  const netDue = sum(invoices.map((c) => c.netDue)),
    collected = sum(invoices.map((c) => c.allocated));
  return {
    currency: property.currency,
    asOf: now.toISOString(),
    netDue,
    collected,
    outstanding: sum(invoices.map((c) => c.outstanding)),
    overdueRent: sum(
      invoices
        .filter((c) => c.category === "RENT" && c.dueAt < now)
        .map((c) => c.outstanding),
    ),
    collectionPercent: ratio(collected, netDue),
    invoices,
    transactions,
    exceptions: transactions.filter((t) => t.exception).length,
  };
}
export async function operationalAnalytics(
  actor: Actor,
  propertyId: string,
  filters: ReportFilters = {},
  now = new Date(),
) {
  await permit(actor, propertyId, "reports");
  const { range, from, to } = reportPeriod(filters),
    { rooms, ids, userWhere } = await population(propertyId, filters);
  const [active, cohort, tickets] = await Promise.all([
    db.reservation.findMany({
      where: { propertyId, state: "ACTIVE", bed: { roomId: { in: ids } } },
      select: { bedId: true },
    }),
    db.lease.findMany({
      where: {
        propertyId,
        executedAt: { not: null },
        reservation: {
          bed: { roomId: { in: ids } },
          endAt: {
            gte: from || new Date(now.getTime() - 90 * 86400000),
            lt: to || now,
          },
        },
      },
      select: { id: true },
    }),
    db.ticket.findMany({
      where: { propertyId, createdAt: range, user: userWhere },
      select: { type: true, createdAt: true, category: true },
    }),
  ]);
  const renewed = await db.tenancyRequest.findMany({
    where: {
      type: "RENEWAL",
      state: "APPROVED",
      leaseId: { in: cohort.map((l) => l.id) },
    },
    distinct: ["leaseId"],
    select: { leaseId: true },
  });
  const months = new Map<
    string,
    {
      month: string;
      complaints: number;
      maintenance: number;
      compliments: number;
      support: number;
    }
  >();
  for (const t of tickets) {
    const month = t.createdAt.toISOString().slice(0, 7),
      r = months.get(month) || {
        month,
        complaints: 0,
        maintenance: 0,
        compliments: 0,
        support: 0,
      };
    if (t.type === "COMPLAINT") r.complaints++;
    if (t.type === "MAINTENANCE") r.maintenance++;
    if (t.type === "COMPLIMENT") r.compliments++;
    if (t.type === "SUPPORT") r.support++;
    months.set(month, r);
  }
  const occupied = new Set(active.map((r) => r.bedId));
  return {
    eligibleLeases: cohort.length,
    renewedLeases: renewed.length,
    renewalPercent: ratio(BigInt(renewed.length), BigInt(cohort.length)),
    cohortFrom: (from || new Date(now.getTime() - 90 * 86400000)).toISOString(),
    cohortTo: (to || now).toISOString(),
    trends: [...months.values()].sort((a, b) => a.month.localeCompare(b.month)),
    rooms: rooms.map((r) => ({
      id: r.id,
      name: r.name,
      beds: r.beds.length,
      occupied: r.beds.filter((b) => occupied.has(b.id)).length,
      blocked: r.beds.filter((b) => b.blocked).length,
    })),
  };
}
