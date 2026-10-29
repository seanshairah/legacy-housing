import { it, expect } from "vitest";
import { randomUUID, randomBytes } from "node:crypto";
import { fullFixture } from "./browser/support";
import { db } from "../src/lib/db";
import { reserve, expireHolds } from "../src/domain/inventory";
process.env.DATA_KEY ||= randomBytes(32).toString("hex");

it("concurrent repeats of one booking return one application, hold, consent and durable submission event", async () => {
  const f = await fullFixture(),
    input = {
      bedId: f.room.beds[0].id,
      startAt: f.start,
      endAt: f.end,
      consent: true,
      termsVersion: "application-policy-v1",
      idempotencyKey: randomUUID(),
    };
  const results = await Promise.all(
    Array.from({ length: 3 }, () => reserve(f.people.RESIDENT, input)),
  );
  expect(new Set(results.map((r) => r.reservation.id)).size).toBe(1);
  expect(
    await db.application.count({ where: { userId: f.people.RESIDENT.id } }),
  ).toBe(1);
  expect(
    await db.consent.count({
      where: { userId: f.people.RESIDENT.id, purpose: "APPLICATION" },
    }),
  ).toBe(1);
  expect(
    await db.auditEvent.count({
      where: { actorId: f.people.RESIDENT.id, action: "application.submitted" },
    }),
  ).toBe(1);
  await expect(
    reserve(f.people.RESIDENT, { ...input, bedId: f.room.beds[1].id }),
  ).rejects.toThrow("IDEMPOTENCY_CONFLICT");
  await expect(reserve(f.people.OTHER, input)).rejects.toThrow(
    "IDEMPOTENCY_CONFLICT",
  );
  await db.reservation.update({
    where: { id: results[0].reservation.id },
    data: { expiresAt: new Date(0) },
  });
  await expireHolds();
  const replay = await reserve(f.people.RESIDENT, input);
  expect(replay.reservation.state).toBe("EXPIRED");
  expect(
    await db.reservation.count({ where: { userId: f.people.RESIDENT.id } }),
  ).toBe(1);
  await expect(
    db.reservation.update({
      where: { id: replay.reservation.id },
      data: { idempotencyKey: randomUUID() },
    }),
  ).rejects.toThrow();
});
