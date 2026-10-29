import { afterAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { db } from "../src/lib/db";
import {
  account,
  applyAvailableCredit,
  creditCharge,
  issueCharge,
  proposePayment,
  refund,
  reviewProof,
} from "../src/domain/finance";
import { assertTestDatabase } from "./safety";

assertTestDatabase();
afterAll(() => db.$disconnect());
const decimal = (n: bigint) =>
  `${n / 100n}.${String(n % 100n).padStart(2, "0")}`;

async function fixture() {
  const run = randomUUID();
  const property = await db.property.create({
    data: {
      name: "Synthetic financial invariant property",
      slug: `invariant-${run}`,
      description: "Synthetic records only",
      location: "Local test",
      published: true,
    },
  });
  const users = await Promise.all(
    ["FINANCE", "ADMIN", "RESIDENT"].map((role, n) =>
      db.user.create({
        data: {
          name: `Synthetic ${role}`,
          email: `${role}-${run}@example.invalid`,
          phone: `+990${Date.now()}${n}`,
          passwordHash: "not-a-login-fixture",
          emailVerifiedAt: new Date(),
          phoneVerifiedAt: new Date(),
        },
      }),
    ),
  );
  await db.membership.createMany({
    data: [
      { userId: users[0].id, propertyId: property.id, role: "FINANCE" },
      { userId: users[1].id, propertyId: property.id, role: "ADMIN" },
    ],
  });
  await db.application.create({
    data: { propertyId: property.id, userId: users[2].id },
  });
  return { property, finance: users[0], checker: users[1], resident: users[2] };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function assertConservation(f: Fixture) {
  const charges = await db.charge.findMany({
    where: { propertyId: f.property.id, userId: f.resident.id },
    include: { credits: true, allocations: { include: { reversals: true } } },
  });
  const payments = await db.payment.findMany({
    where: { propertyId: f.property.id, userId: f.resident.id },
    include: {
      refunds: true,
      allocations: { include: { reversals: true } },
      receipt: true,
    },
  });
  let netCharges = 0n,
    netPayments = 0n;
  for (const charge of charges) {
    const credited = charge.credits.reduce((sum, c) => sum + c.amountMinor, 0n);
    const allocated = charge.allocations.reduce((sum, a) => {
      const reversed = a.reversals.reduce((s, r) => s + r.amountMinor, 0n);
      expect(reversed).toBeGreaterThanOrEqual(0n);
      expect(reversed).toBeLessThanOrEqual(a.amountMinor);
      return sum + a.amountMinor - reversed;
    }, 0n);
    expect(credited).toBeGreaterThanOrEqual(0n);
    expect(credited + allocated).toBeLessThanOrEqual(charge.amountMinor);
    netCharges += charge.amountMinor - credited;
  }
  for (const payment of payments) {
    const refunded = payment.refunds.reduce(
      (sum, r) => sum + r.amountMinor,
      0n,
    );
    const allocated = payment.allocations.reduce(
      (sum, a) =>
        sum +
        a.amountMinor -
        a.reversals.reduce((s, r) => s + r.amountMinor, 0n),
      0n,
    );
    expect(refunded).toBeLessThanOrEqual(payment.amountMinor);
    if (["PAID", "PARTIALLY_REFUNDED", "REFUNDED"].includes(payment.status)) {
      expect(payment.receipt).not.toBeNull();
      expect(allocated).toBeGreaterThanOrEqual(0n);
      expect(allocated).toBeLessThanOrEqual(payment.amountMinor - refunded);
      netPayments += payment.amountMinor - refunded;
    } else {
      expect(payment.receipt).toBeNull();
      expect(allocated).toBe(0n);
    }
  }
  const balance = await account(f.resident.id, f.property.id);
  expect(balance.outstanding).toBeGreaterThanOrEqual(0n);
  expect(balance.credit).toBeGreaterThanOrEqual(0n);
  expect(balance.outstanding - balance.credit).toBe(netCharges - netPayments);
  expect(
    await db.receipt.count({
      where: { payment: { propertyId: f.property.id } },
    }),
  ).toBe(
    payments.filter((p) =>
      ["PAID", "PARTIALLY_REFUNDED", "REFUNDED"].includes(p.status),
    ).length,
  );
}

async function tender(f: Fixture, amountMinor: bigint) {
  return proposePayment(f.finance, {
    propertyId: f.property.id,
    userId: f.resident.id,
    amount: decimal(amountMinor),
    method: "CASH",
    bankReference: `SYNTHETIC-${randomUUID()}`,
    idempotencyKey: randomUUID(),
  });
}

it("seeded financial sequences preserve conservation, immutable evidence and idempotency after charges, credits, excess funds and refunds", async () => {
  const f = await fixture();
  let seed = 0x4c484631;
  const next = (max: number) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % max;
  };
  for (let round = 0; round < 24; round++) {
    const charge = await issueCharge(f.finance, {
      propertyId: f.property.id,
      userId: f.resident.id,
      reference: `INV-${randomUUID()}`,
      category: ["RENT", "UTILITIES", "PENALTY", "OTHER"][next(4)],
      description: `Seeded synthetic charge ${round}`,
      amount: decimal(BigInt(101 + next(5000))),
      dueAt: new Date(Date.now() + round * 1000),
    });
    await assertConservation(f);
    if (round % 3 === 0) {
      const credit = await creditCharge(
        f.finance,
        charge.id,
        "0.01",
        "Synthetic documented correction",
        `CR-${randomUUID()}`,
      );
      expect(
        (
          await creditCharge(
            f.finance,
            charge.id,
            "0.01",
            "Replay of synthetic correction",
            credit.reference,
          )
        ).id,
      ).toBe(credit.id);
    }
    const payment = await tender(f, BigInt(1 + next(6500)));
    await assertConservation(f);
    await reviewProof(
      f.checker,
      payment.id,
      "APPROVE",
      "Synthetic voucher verification, no real funds",
    );
    const receipt = await db.receipt.findUniqueOrThrow({
      where: { paymentId: payment.id },
    });
    if (round % 2 === 0) {
      const amount = BigInt(1 + next(Number(payment.amountMinor)));
      const reversal = await refund(
        f.finance,
        payment.id,
        decimal(amount),
        "Synthetic externally verified refund",
        `REF-${randomUUID()}`,
      );
      expect(
        (
          await refund(
            f.finance,
            payment.id,
            decimal(amount),
            "Replay of synthetic refund",
            reversal.reference,
          )
        ).id,
      ).toBe(reversal.id);
      await expect(
        refund(
          f.finance,
          payment.id,
          decimal(payment.amountMinor + 1n),
          "Attempted invalid over-refund",
          `REF-${randomUUID()}`,
        ),
      ).rejects.toThrow("INVALID_REFUND");
    }
    await applyAvailableCredit(f.resident, f.resident.id, f.property.id);
    await assertConservation(f);
    expect(
      await db.receipt.findUniqueOrThrow({ where: { id: receipt.id } }),
    ).toEqual(receipt);
    await expect(
      db.charge.update({
        where: { id: charge.id },
        data: { amountMinor: charge.amountMinor + 1n },
      }),
    ).rejects.toThrow();
  }
});

it("concurrent approvals, credits, available-credit applications and refunds cannot over-allocate or over-refund", async () => {
  const f = await fixture();
  const charge = await issueCharge(f.finance, {
    propertyId: f.property.id,
    userId: f.resident.id,
    reference: `INV-${randomUUID()}`,
    category: "RENT",
    description: "Synthetic concurrent financial operations",
    amount: "100.00",
    dueAt: new Date(),
  });
  const payments = await Promise.all(
    [6000n, 6000n, 6000n].map((amount) => tender(f, amount)),
  );
  await Promise.all(
    payments.map((p) =>
      reviewProof(
        f.checker,
        p.id,
        "APPROVE",
        "Synthetic concurrent independent verification",
      ),
    ),
  );
  await assertConservation(f);
  expect((await account(f.resident.id, f.property.id)).credit).toBe(8000n);
  const followup = await issueCharge(f.finance, {
    propertyId: f.property.id,
    userId: f.resident.id,
    reference: `INV-${randomUUID()}`,
    category: "UTILITIES",
    description: "Synthetic outstanding service charge",
    amount: "120.00",
    dueAt: new Date(),
  });
  await Promise.all([
    applyAvailableCredit(f.resident, f.resident.id, f.property.id),
    creditCharge(
      f.finance,
      followup.id,
      "10.00",
      "Synthetic correction approved for this charge",
      `CR-${randomUUID()}`,
    ),
    refund(
      f.finance,
      payments[0].id,
      "20.00",
      "Synthetic verified bank refund",
      `REF-${randomUUID()}`,
    ),
  ]);
  await assertConservation(f);
  const attempted = await Promise.allSettled([
    refund(
      f.finance,
      payments[1].id,
      "50.00",
      "Concurrent refund attempt one",
      `REF-${randomUUID()}`,
    ),
    refund(
      f.finance,
      payments[1].id,
      "50.00",
      "Concurrent refund attempt two",
      `REF-${randomUUID()}`,
    ),
  ]);
  expect(attempted.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(attempted.filter((r) => r.status === "rejected")).toHaveLength(1);
  const rejected = attempted.find(
    (r) => r.status === "rejected",
  ) as PromiseRejectedResult;
  expect(rejected.reason.message).toContain("INVALID_REFUND");
  await assertConservation(f);
  expect(
    (await db.charge.findUniqueOrThrow({ where: { id: charge.id } }))
      .amountMinor,
  ).toBe(10000n);
});
