import { z } from "zod";
import { db, transaction, type Tx } from "../lib/db";
import { type Actor, permit, ownerOrPermit } from "./access";
import { event } from "./events";
export function minor(value: string): bigint {
  if (!/^\d{1,10}(\.\d{1,2})?$/.test(value)) throw new Error("INVALID_AMOUNT");
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
}
export function money(amount: bigint, currency = "USD") {
  const sign = amount < 0n ? "-" : "";
  const n = amount < 0n ? -amount : amount;
  return `${currency} ${sign}${n / 100n}.${String(n % 100n).padStart(2, "0")}`;
}
export async function account(
  userId: string,
  propertyId: string,
  client: Tx | typeof db = db,
) {
  const charges = await client.charge.findMany({
    where: { userId, propertyId },
    include: { credits: true, allocations: { include: { reversals: true } } },
    orderBy: { dueAt: "asc" },
  });
  const payments = await client.payment.findMany({
    where: {
      userId,
      propertyId,
      status: { in: ["PAID", "PARTIALLY_REFUNDED", "REFUNDED"] },
    },
    include: { refunds: true, allocations: { include: { reversals: true } } },
  });
  const lines = charges.map((c) => ({
    ...c,
    remaining:
      c.amountMinor -
      c.credits.reduce((n, v) => n + v.amountMinor, 0n) -
      c.allocations.reduce(
        (n, a) =>
          n +
          a.amountMinor -
          a.reversals.reduce((m, r) => m + r.amountMinor, 0n),
        0n,
      ),
  }));
  const credit = payments.reduce(
    (sum, p) =>
      sum +
      p.amountMinor -
      p.refunds.reduce((n, r) => n + r.amountMinor, 0n) -
      p.allocations.reduce(
        (n, a) =>
          n +
          a.amountMinor -
          a.reversals.reduce((m, r) => m + r.amountMinor, 0n),
        0n,
      ),
    0n,
  );
  return {
    lines,
    outstanding: lines.reduce((n, c) => n + c.remaining, 0n),
    credit,
  };
}
async function lockAccount(tx: Tx, userId: string) {
  await tx.$queryRaw`SELECT id FROM "User" WHERE id=${userId} FOR UPDATE`;
}
export async function issueCharge(actor: Actor, input: unknown) {
  const d = z
    .object({
      userId: z.string(),
      propertyId: z.string(),
      reference: z.string().min(5).max(100),
      category: z.enum(["RENT", "DEPOSIT", "UTILITIES", "PENALTY", "OTHER"]),
      description: z.string().min(3).max(500),
      amount: z.string(),
      dueAt: z.coerce.date(),
    })
    .parse(input);
  const amountMinor = minor(d.amount);
  if (amountMinor <= 0n) throw new Error("POSITIVE_AMOUNT_REQUIRED");
  return transaction(async (tx) => {
    await permit(actor, d.propertyId, "finance", tx);
    const belongs = await tx.application.findFirst({
      where: {
        userId: d.userId,
        propertyId: d.propertyId,
        status: { notIn: ["DECLINED", "WITHDRAWN"] },
      },
    });
    if (!belongs) throw new Error("RESIDENT_NOT_IN_PROPERTY");
    await lockAccount(tx, d.userId);
    const p = await tx.property.findUniqueOrThrow({
      where: { id: d.propertyId },
    });
    const { amount: _, ...fields } = d;
    void _;
    const existing = await tx.charge.findUnique({
      where: { reference: d.reference },
    });
    if (existing) {
      if (
        existing.userId !== d.userId ||
        existing.propertyId !== d.propertyId ||
        existing.amountMinor !== amountMinor ||
        existing.category !== d.category
      )
        throw new Error("IDEMPOTENCY_CONFLICT");
      return existing;
    }
    const charge = await tx.charge.create({
      data: { ...fields, amountMinor, currency: p.currency },
    });
    await event(
      tx,
      actor.id,
      p.id,
      "invoice.issued",
      charge.id,
      { amountMinor: String(amountMinor) },
      d.userId,
    );
    return charge;
  });
}
export async function proposePayment(actor: Actor, input: unknown) {
  const d = z
    .object({
      propertyId: z.string(),
      userId: z.string(),
      amount: z.string(),
      idempotencyKey: z.string().min(12).max(120),
      method: z.enum(["PAYNOW", "BANK", "CASH"]),
      proofDocumentId: z.string().optional(),
      bankReference: z.string().max(120).optional(),
    })
    .parse(input);
  const amountMinor = minor(d.amount);
  if (amountMinor <= 0n) throw new Error("POSITIVE_AMOUNT_REQUIRED");
  return transaction(async (tx) => {
    await ownerOrPermit(actor, d.userId, d.propertyId, "finance", tx);
    if (d.method === "CASH") {
      await permit(actor, d.propertyId, "finance", tx);
      if (!d.bankReference?.trim())
        throw new Error("CASH_VOUCHER_REFERENCE_REQUIRED");
    }
    await lockAccount(tx, d.userId);
    const existing = await tx.payment.findUnique({
      where: { idempotencyKey: d.idempotencyKey },
    });
    if (existing) {
      if (
        existing.userId !== d.userId ||
        existing.propertyId !== d.propertyId ||
        existing.amountMinor !== amountMinor ||
        existing.method !== d.method
      )
        throw new Error("IDEMPOTENCY_CONFLICT");
      return existing;
    }
    if (d.method === "PAYNOW") {
      const pending = await tx.payment.findFirst({
        where: {
          userId: d.userId,
          propertyId: d.propertyId,
          method: "PAYNOW",
          status: { in: ["PENDING", "INITIATING", "INITIATION_UNKNOWN"] },
        },
        orderBy: { createdAt: "desc" },
      });
      if (pending) {
        if (pending.amountMinor !== amountMinor)
          throw new Error("PRIOR_PAYMENT_REQUIRES_RECONCILIATION");
        return pending;
      }
    }
    const totals = await account(d.userId, d.propertyId, tx);
    if (d.method === "PAYNOW" && amountMinor > totals.outstanding)
      throw new Error("AMOUNT_EXCEEDS_BALANCE");
    if (
      !(await tx.application.count({
        where: { userId: d.userId, propertyId: d.propertyId },
      }))
    )
      throw new Error("RESIDENT_NOT_IN_PROPERTY");
    let proofHash: string | undefined;
    if (d.method === "BANK") {
      const doc = await tx.document.findUnique({
        where: { id: d.proofDocumentId || "" },
      });
      if (
        !doc ||
        doc.userId !== d.userId ||
        doc.propertyId !== d.propertyId ||
        doc.kind !== "PAYMENT_PROOF" ||
        !["CLEAN", "APPROVED"].includes(doc.state) ||
        !d.bankReference?.trim()
      )
        throw new Error("CLEAN_PROOF_AND_BANK_REFERENCE_REQUIRED");
    }
    if (d.method === "BANK")
      proofHash = (
        await tx.document.findUniqueOrThrow({
          where: { id: d.proofDocumentId! },
        })
      ).hash;
    const p = await tx.property.findUniqueOrThrow({
      where: { id: d.propertyId },
    });
    const { amount: _, ...fields } = d;
    void _;
    const payment = await tx.payment.create({
      data: {
        ...fields,
        proofHash,
        amountMinor,
        currency: p.currency,
        reference: `LH-${crypto.randomUUID()}`,
        proposedBy: actor.id,
        status: d.method !== "PAYNOW" ? "PROOF_REVIEW" : "PENDING",
      },
    });
    await event(
      tx,
      actor.id,
      p.id,
      "payment.initiated",
      payment.id,
      {},
      d.userId,
    );
    return payment;
  });
}
async function settle(
  tx: Tx,
  paymentId: string,
  actorId: string,
  evidence: string,
) {
  const p = await tx.payment.findUniqueOrThrow({ where: { id: paymentId } });
  await lockAccount(tx, p.userId);
  const fresh = await tx.payment.findUniqueOrThrow({ where: { id: p.id } });
  if (fresh.status === "PAID")
    return tx.receipt.findUniqueOrThrow({ where: { paymentId } });
  if (!["PENDING", "PROOF_REVIEW"].includes(fresh.status))
    throw new Error("INVALID_PAYMENT_TRANSITION");
  let remaining = p.amountMinor;
  const totals = await account(p.userId, p.propertyId, tx);
  for (const c of totals.lines) {
    const amount = c.remaining < remaining ? c.remaining : remaining;
    if (amount > 0n) {
      await tx.allocation.create({
        data: { paymentId, chargeId: c.id, amountMinor: amount },
      });
      remaining -= amount;
    }
  }
  await tx.payment.update({
    where: { id: p.id },
    data: { status: "PAID", settledAt: new Date(), approvedBy: actorId },
  });
  const receipt = await tx.receipt.create({
    data: {
      paymentId,
      number: `RCT-${p.reference}`,
      snapshot: {
        reference: p.reference,
        userId: p.userId,
        amountMinor: String(p.amountMinor),
        currency: p.currency,
        evidence,
        issuedAt: new Date().toISOString(),
      },
    },
  });
  // A paid deposit confirms only an unexpired hold. Late money remains recorded without overbooking.
  const deposits = await tx.charge.findMany({
    where: { userId: p.userId, propertyId: p.propertyId, category: "DEPOSIT" },
    include: { allocations: { include: { reversals: true } } },
  });
  for (const c of deposits) {
    const paid = c.allocations.reduce(
      (n, a) =>
        n + a.amountMinor - a.reversals.reduce((m, r) => m + r.amountMinor, 0n),
      0n,
    );
    if (paid >= c.amountMinor && c.reference.startsWith("DEP-")) {
      const applicationId = c.reference.slice(4);
      const held = await tx.reservation.updateMany({
        where: { applicationId, state: "HOLD", expiresAt: { gt: new Date() } },
        data: { state: "CONFIRMED", expiresAt: null },
      });
      if (held.count)
        await tx.application.update({
          where: { id: applicationId },
          data: { status: "LEASE_SIGNING_PENDING" },
        });
    }
  }
  await event(
    tx,
    actorId,
    p.propertyId,
    "payment.settled",
    p.id,
    { evidence, receiptId: receipt.id, unallocatedMinor: String(remaining) },
    p.userId,
  );
  return receipt;
}
export async function reviewProof(
  actor: Actor,
  paymentId: string,
  decision: "APPROVE" | "REJECT",
  reason: string,
) {
  return transaction(async (tx) => {
    const p = await tx.payment.findUniqueOrThrow({
      where: { id: paymentId },
      include: { property: true },
    });
    await permit(actor, p.propertyId, "finance", tx);
    if (
      !["BANK", "CASH"].includes(p.method) ||
      p.status !== "PROOF_REVIEW" ||
      !reason.trim()
    )
      throw new Error("PROOF_REVIEW_INVALID");
    if (p.property.makerChecker && p.proposedBy === actor.id)
      throw new Error("MAKER_CHECKER_REQUIRED");
    if (decision === "REJECT") {
      await tx.payment.update({
        where: { id: p.id },
        data: { status: "REJECTED", approvedBy: actor.id },
      });
      await event(
        tx,
        actor.id,
        p.propertyId,
        "proof.rejected",
        p.id,
        { reason },
        p.userId,
      );
      return;
    }
    return settle(tx, p.id, actor.id, `Verified ${p.method} tender: ${reason}`);
  });
}
export async function settleProvider(
  paymentId: string,
  providerId: string,
  evidenceHash: string,
) {
  return transaction(async (tx) => {
    const p = await tx.payment.findUniqueOrThrow({ where: { id: paymentId } });
    if (p.method !== "PAYNOW" || p.providerId !== providerId)
      throw new Error("PROVIDER_REFERENCE_MISMATCH");
    return settle(tx, p.id, "paynow", evidenceHash);
  });
}
async function postRefund(
  actor: Actor,
  paymentId: string,
  amount: string,
  reason: string,
  reference: string,
  providerVerified = false,
) {
  const amountMinor = minor(amount);
  if (amountMinor <= 0n || !reason.trim() || !reference.trim())
    throw new Error("REFUND_REASON_REQUIRED");
  return transaction(async (tx) => {
    const p = await tx.payment.findUniqueOrThrow({
      where: { id: paymentId },
      include: { refunds: true, allocations: { include: { reversals: true } } },
    });
    if (!providerVerified) await permit(actor, p.propertyId, "finance", tx);
    await lockAccount(tx, p.userId);
    const existing = await tx.refund.findUnique({ where: { reference } });
    if (existing) {
      if (
        existing.paymentId !== paymentId ||
        existing.amountMinor !== amountMinor
      )
        throw new Error("IDEMPOTENCY_CONFLICT");
      return existing;
    }
    const net =
      p.amountMinor - p.refunds.reduce((n, r) => n + r.amountMinor, 0n);
    if (!["PAID", "PARTIALLY_REFUNDED"].includes(p.status) || amountMinor > net)
      throw new Error("INVALID_REFUND");
    const r = await tx.refund.create({
      data: { paymentId, amountMinor, reason, reference, actorId: actor.id },
    });
    const allocated = p.allocations.reduce(
      (n, a) =>
        n + a.amountMinor - a.reversals.reduce((m, v) => m + v.amountMinor, 0n),
      0n,
    );
    let reverse =
      amountMinor > net - allocated ? amountMinor - (net - allocated) : 0n;
    for (const a of [...p.allocations].reverse()) {
      const available =
          a.amountMinor - a.reversals.reduce((n, v) => n + v.amountMinor, 0n),
        v = available < reverse ? available : reverse;
      if (v > 0n) {
        await tx.allocationReversal.create({
          data: { refundId: r.id, allocationId: a.id, amountMinor: v },
        });
        reverse -= v;
      }
    }
    await tx.payment.update({
      where: { id: paymentId },
      data: { status: amountMinor === net ? "REFUNDED" : "PARTIALLY_REFUNDED" },
    });
    await event(
      tx,
      actor.id,
      p.propertyId,
      "payment.refunded",
      paymentId,
      { amountMinor: String(amountMinor), reason, reference },
      p.userId,
    );
    return r;
  });
}
export async function creditCharge(
  actor: Actor,
  id: string,
  amount: string,
  reason: string,
  reference: string,
) {
  const amountMinor = minor(amount);
  if (amountMinor <= 0n || !reason.trim())
    throw new Error("POSITIVE_AMOUNT_AND_REASON_REQUIRED");
  return transaction(async (tx) => {
    const c = await tx.charge.findUniqueOrThrow({ where: { id } });
    await permit(actor, c.propertyId, "finance", tx);
    await lockAccount(tx, c.userId);
    const prior = await tx.credit.findUnique({ where: { reference } });
    if (prior) {
      if (prior.chargeId !== id || prior.amountMinor !== amountMinor)
        throw new Error("IDEMPOTENCY_CONFLICT");
      return prior;
    }
    const total = await account(c.userId, c.propertyId, tx),
      line = total.lines.find((v) => v.id === id)!;
    if (amountMinor > line.remaining)
      throw new Error("CREDIT_EXCEEDS_OPEN_CHARGE");
    const credit = await tx.credit.create({
      data: { chargeId: id, amountMinor, actorId: actor.id, reason, reference },
    });
    await event(
      tx,
      actor.id,
      c.propertyId,
      "credit.issued",
      credit.id,
      { amountMinor: String(amountMinor), reference },
      c.userId,
    );
    return credit;
  });
}

export async function refund(
  actor: Actor,
  paymentId: string,
  amount: string,
  reason: string,
  reference: string,
) {
  return postRefund(actor, paymentId, amount, reason, reference);
}
export async function recordProviderRefund(
  paymentId: string,
  providerId: string,
  evidence: string,
) {
  const payment = await db.payment.findUniqueOrThrow({
    where: { id: paymentId },
    include: { refunds: true },
  });
  if (payment.method !== "PAYNOW" || payment.providerId !== providerId)
    throw new Error("PROVIDER_REFERENCE_MISMATCH");
  if (["PENDING", "PROOF_REVIEW"].includes(payment.status))
    await settleProvider(paymentId, providerId, evidence);
  const current = await db.payment.findUniqueOrThrow({
      where: { id: paymentId },
      include: { refunds: true },
    }),
    net =
      current.amountMinor -
      current.refunds.reduce((n, r) => n + r.amountMinor, 0n);
  if (net <= 0n) return;
  return postRefund(
    { id: "paynow" },
    paymentId,
    `${net / 100n}.${String(net % 100n).padStart(2, "0")}`,
    `Signed authoritative full-refund confirmation: ${evidence}`,
    `PAYNOW-REFUND-${providerId}`,
    true,
  );
}
export async function applyAvailableCredit(
  actor: Actor,
  userId: string,
  propertyId: string,
) {
  return transaction(async (tx) => {
    await ownerOrPermit(actor, userId, propertyId, "finance", tx);
    await lockAccount(tx, userId);
    const totals = await account(userId, propertyId, tx),
      payments = await tx.payment.findMany({
        where: {
          userId,
          propertyId,
          status: { in: ["PAID", "PARTIALLY_REFUNDED"] },
        },
        include: {
          refunds: true,
          allocations: { include: { reversals: true } },
        },
        orderBy: { settledAt: "asc" },
      });
    let applied = 0n;
    for (const p of payments) {
      let available =
        p.amountMinor -
        p.refunds.reduce((n, r) => n + r.amountMinor, 0n) -
        p.allocations.reduce(
          (n, a) =>
            n +
            a.amountMinor -
            a.reversals.reduce((m, r) => m + r.amountMinor, 0n),
          0n,
        );
      for (const c of totals.lines) {
        if (available <= 0n) break;
        if (c.remaining <= 0n || p.allocations.some((a) => a.chargeId === c.id))
          continue;
        const amount = c.remaining < available ? c.remaining : available;
        await tx.allocation.create({
          data: { paymentId: p.id, chargeId: c.id, amountMinor: amount },
        });
        available -= amount;
        c.remaining -= amount;
        applied += amount;
      }
    }
    for (const c of totals.lines.filter(
      (c) =>
        c.category === "DEPOSIT" &&
        c.remaining === 0n &&
        c.reference.startsWith("DEP-"),
    )) {
      const applicationId = c.reference.slice(4);
      const changed = await tx.reservation.updateMany({
        where: { applicationId, state: "HOLD", expiresAt: { gt: new Date() } },
        data: { state: "CONFIRMED", expiresAt: null },
      });
      if (changed.count)
        await tx.application.update({
          where: { id: applicationId },
          data: { status: "LEASE_SIGNING_PENDING" },
        });
    }
    if (applied > 0n)
      await event(
        tx,
        actor.id,
        propertyId,
        "credit.applied",
        userId,
        { amountMinor: String(applied) },
        userId,
      );
    return { appliedMinor: String(applied) };
  });
}
