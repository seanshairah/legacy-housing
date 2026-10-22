import type { RatePlan, Prisma } from "@prisma/client";
import { type Tx, db } from "../lib/db";
const dayMs = 86400000,
  common = 377580n; // LCM(28,29,30,31), preserving exact integer fractions.
export type PriceSegment = {
  start: string;
  end: string;
  monthlyMinor: string;
  monthDays: number;
  rateId: string;
};
export type PriceSnapshot = {
  version: 1;
  currency: string;
  totalMinor: string;
  segments: PriceSegment[];
};
function day(date: Date) {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}
export function quoteRates(
  input: {
    roomId: string;
    bedId: string;
    baseMinor: bigint;
    currency: string;
    startAt: Date;
    endAt: Date;
  },
  rates: RatePlan[],
): PriceSnapshot {
  const start = day(input.startAt),
    end = day(input.endAt);
  if (end <= start) throw new Error("AT_LEAST_ONE_NIGHT_REQUIRED");
  const nights = (end.getTime() - start.getTime()) / dayMs;
  if (nights > 732) throw new Error("STAY_TOO_LONG");
  const matching = rates.filter(
    (r) =>
      (!r.roomId || r.roomId === input.roomId) &&
      (!r.bedId || r.bedId === input.bedId) &&
      r.minNights <= nights,
  );
  const segments: PriceSegment[] = [];
  let numerator = 0n;
  for (let at = start; at < end; at = new Date(at.getTime() + dayMs)) {
    const rule = matching
      .filter((r) => r.startAt <= at && r.endAt > at)
      .sort(
        (a, b) =>
          Number(!!b.bedId) - Number(!!a.bedId) ||
          Number(!!b.roomId) - Number(!!a.roomId) ||
          b.priority - a.priority ||
          b.minNights - a.minNights ||
          a.id.localeCompare(b.id),
      )[0];
    const monthly = rule?.monthlyMinor ?? input.baseMinor,
      days = new Date(
        Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 0),
      ).getUTCDate(),
      endDay = new Date(at.getTime() + dayMs).toISOString();
    numerator += monthly * (common / BigInt(days));
    const previous = segments.at(-1);
    if (
      previous &&
      previous.monthlyMinor === String(monthly) &&
      previous.monthDays === days &&
      previous.rateId === (rule?.id || "ROOM_BASE")
    )
      previous.end = endDay;
    else
      segments.push({
        start: at.toISOString(),
        end: endDay,
        monthlyMinor: String(monthly),
        monthDays: days,
        rateId: rule?.id || "ROOM_BASE",
      });
  }
  return {
    version: 1,
    currency: input.currency,
    totalMinor: String((numerator + common / 2n) / common),
    segments,
  };
}
export async function quoteBed(
  client: Tx | typeof db,
  bedId: string,
  startAt: Date,
  endAt: Date,
) {
  const bed = await client.bed.findUniqueOrThrow({
    where: { id: bedId },
    include: {
      room: {
        include: {
          floor: { include: { building: { include: { property: true } } } },
        },
      },
    },
  });
  const property = bed.room.floor.building.property;
  const rates = await client.ratePlan.findMany({
    where: {
      propertyId: property.id,
      startAt: { lt: endAt },
      endAt: { gt: startAt },
    },
  });
  return quoteRates(
    {
      bedId,
      roomId: bed.roomId,
      baseMinor: bed.room.monthlyMinor,
      currency: property.currency,
      startAt,
      endAt,
    },
    rates,
  );
}
export function quoteSlice(snapshot: PriceSnapshot, from: Date, to: Date) {
  let total = 0n;
  for (const s of snapshot.segments) {
    const start = Math.max(day(from).getTime(), new Date(s.start).getTime()),
      end = Math.min(day(to).getTime(), new Date(s.end).getTime());
    if (end > start)
      total +=
        BigInt(s.monthlyMinor) *
        BigInt((end - start) / dayMs) *
        (common / BigInt(s.monthDays));
  }
  return (total + common / 2n) / common;
}
export function priceJson(snapshot: PriceSnapshot): Prisma.InputJsonValue {
  return snapshot as unknown as Prisma.InputJsonValue;
}
