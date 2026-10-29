import { afterAll, afterEach, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { db } from "../src/lib/db";
import { offerWaitlist } from "../src/domain/inventory";
import { accountingCsv, pmsCsv, sisCsv } from "../src/integrations";
import { assertTestDatabase } from "./safety";
assertTestDatabase();
process.env.DATA_KEY ||= randomBytes(32).toString("hex");
afterAll(async () => db.$disconnect());
const createdProperties: string[] = [];
afterEach(async () => {
  await db.waitlist.updateMany({
    where: { propertyId: { in: createdProperties }, state: "WAITING" },
    data: { state: "EXPIRED" },
  });
});
const dates = () => ({
  startAt: new Date(Date.now() + 86400000),
  endAt: new Date(Date.now() + 31 * 86400000),
});
async function people(count: number) {
  const run = randomUUID();
  const rows = Array.from({ length: count }, (_, n) => ({
    id: `batch-user-${run}-${n}`,
    email: `batch-${run}-${n}@example.invalid`,
    phone: `batch-${run}-${n}`,
    name: "Synthetic batch boundary user",
    passwordHash: "not-used-by-this-test",
    emailVerifiedAt: new Date(),
    phoneVerifiedAt: new Date(),
  }));
  await db.user.createMany({ data: rows });
  return rows;
}
async function fixture(beds = 1) {
  const run = randomUUID();
  const property = await db.property.create({
    data: {
      slug: `batch-${run}`,
      name: "Synthetic batch boundary property",
      description: "Synthetic batch correctness test only",
      location: "Test only",
      published: true,
    },
  });
  createdProperties.push(property.id);
  const building = await db.building.create({
    data: { propertyId: property.id, name: "Batch" },
  });
  const floor = await db.floor.create({
    data: { buildingId: building.id, name: "Ground", level: 0 },
  });
  const room = await db.room.create({
    data: {
      floorId: floor.id,
      name: "Batch",
      category: "SHARED",
      monthlyMinor: 10000n,
    },
  });
  const ids = Array.from(
    { length: beds },
    (_, n) => `batch-bed-${run}-${String(n).padStart(4, "0")}`,
  );
  await db.bed.createMany({
    data: ids.map((id, n) => ({ id, roomId: room.id, label: String(n) })),
  });
  const [admin, other] = await people(2);
  await db.membership.createMany({
    data: [
      { userId: admin.id, propertyId: property.id, role: "ADMIN" },
      { userId: other.id, propertyId: property.id, role: "CARETAKER" },
    ],
  });
  return { property, ids, admin, other };
}
it("a full first 50-entry property cannot starve an available property later in the waitlist", async () => {
  const closed = await fixture(),
    open = await fixture(),
    applicants = await people(51);
  await db.bed.update({
    where: { id: closed.ids[0] },
    data: { blocked: true },
  });
  const stay = dates();
  await db.waitlist.createMany({
    data: applicants.map((p, n) => ({
      userId: p.id,
      propertyId: n < 50 ? closed.property.id : open.property.id,
      ...stay,
      priority: n < 50 ? 10 : 0,
    })),
  });
  const last = await db.waitlist.findFirstOrThrow({
    where: { userId: applicants[50].id },
  });
  await offerWaitlist();
  expect(
    (await db.waitlist.findUniqueOrThrow({ where: { id: last.id } })).state,
  ).toBe("OFFERED");
  expect(
    await db.waitlist.count({
      where: { propertyId: closed.property.id, state: "WAITING" },
    }),
  ).toBe(50);
  await offerWaitlist();
  expect(
    await db.reservation.count({
      where: { propertyId: open.property.id, userId: applicants[50].id },
    }),
  ).toBe(1);
});
it("the waitlist finds free bed 101 after 100 occupied candidates", async () => {
  const f = await fixture(101),
    occupants = await people(101),
    stay = dates();
  await db.reservation.createMany({
    data: occupants.slice(0, 100).map((p, n) => ({
      propertyId: f.property.id,
      userId: p.id,
      bedId: f.ids[n],
      ...stay,
      state: "ACTIVE",
    })),
  });
  const entry = await db.waitlist.create({
    data: { propertyId: f.property.id, userId: occupants[100].id, ...stay },
  });
  await offerWaitlist();
  const updated = await db.waitlist.findUniqueOrThrow({
    where: { id: entry.id },
  });
  expect(updated.state).toBe("OFFERED");
  expect(
    (
      await db.reservation.findUniqueOrThrow({
        where: { id: updated.offeredReservationId! },
      })
    ).bedId,
  ).toBe(f.ids[100]);
});
it("accounting CSV exports every charge beyond its first 500 rows without crossing property grants", async () => {
  const f = await fixture(),
    foreign = await fixture(),
    [resident] = await people(1);
  await db.charge.createMany({
    data: Array.from({ length: 501 }, (_, n) => ({
      propertyId: f.property.id,
      userId: resident.id,
      reference: `batch-invoice-${f.property.id}-${n}`,
      category: "RENT",
      description: "Synthetic boundary charge",
      amountMinor: 101n,
      currency: "USD",
      dueAt: new Date(),
    })),
  });
  const exported = await accountingCsv.export(f.admin, f.property.id);
  expect(exported.rows).toHaveLength(501);
  expect(new Set(exported.rows.map((r) => r[0])).size).toBe(501);
  expect(exported.rows.every((r) => r[3] === "101")).toBe(true);
  await expect(accountingCsv.export(f.other, f.property.id)).rejects.toThrow(
    "FORBIDDEN",
  );
  await expect(
    accountingCsv.export(f.admin, foreign.property.id),
  ).rejects.toThrow("FORBIDDEN");
});
it("PMS CSV exports all 501 inventory records in stable order", async () => {
  const f = await fixture(501);
  const exported = await pmsCsv.export(f.admin, f.property.id);
  expect(exported.rows).toHaveLength(501);
  expect(exported.rows.map((r) => r[0])).toEqual(f.ids);
});
it("SIS CSV paginates all 501 consenting students while excluding students without consent", async () => {
  const f = await fixture(),
    students = await people(502);
  await db.user.updateMany({
    where: { id: { in: students.map((p) => p.id) } },
    data: { residentType: "STUDENT", institution: "Synthetic institution" },
  });
  await db.application.createMany({
    data: students.map((p) => ({ propertyId: f.property.id, userId: p.id })),
  });
  await db.consent.createMany({
    data: students.slice(0, 501).map((p) => ({
      userId: p.id,
      purpose: "SIS_EXCHANGE",
      version: "v1",
      documentHash: "synthetic-approved-consent",
    })),
  });
  const exported = await sisCsv.export(f.admin, f.property.id);
  expect(exported.rows).toHaveLength(501);
  expect(new Set(exported.rows.map((r) => r[0])).size).toBe(501);
  expect(exported.rows.some((r) => r[0] === students[501].id)).toBe(false);
});

it("concurrent waitlist workers offer the final available bed only once", async () => {
  const f = await fixture(),
    applicants = await people(2),
    stay = dates();
  await db.waitlist.createMany({
    data: applicants.map((p, n) => ({
      propertyId: f.property.id,
      userId: p.id,
      ...stay,
      priority: n === 0 ? 10 : 0,
    })),
  });
  await Promise.all([offerWaitlist(), offerWaitlist()]);
  expect(
    await db.reservation.count({
      where: { propertyId: f.property.id, state: "HOLD" },
    }),
  ).toBe(1);
  const offered = await db.waitlist.findFirstOrThrow({
    where: { propertyId: f.property.id, state: "OFFERED" },
  });
  expect(offered.userId).toBe(applicants[0].id);
  expect(
    await db.waitlist.count({
      where: { propertyId: f.property.id, state: "WAITING" },
    }),
  ).toBe(1);
});
it("unpublished inventory and inactive applicants never receive a waitlist hold", async () => {
  const unpublished = await fixture(),
    open = await fixture(),
    applicants = await people(2),
    stay = dates();
  await db.property.update({
    where: { id: unpublished.property.id },
    data: { published: false },
  });
  await db.user.update({
    where: { id: applicants[1].id },
    data: { active: false },
  });
  await db.waitlist.createMany({
    data: [
      {
        propertyId: unpublished.property.id,
        userId: applicants[0].id,
        ...stay,
      },
      { propertyId: open.property.id, userId: applicants[1].id, ...stay },
    ],
  });
  await offerWaitlist();
  expect(
    await db.reservation.count({
      where: {
        propertyId: { in: [unpublished.property.id, open.property.id] },
      },
    }),
  ).toBe(0);
});
