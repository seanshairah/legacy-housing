import { z } from "zod";
import { transaction, type Tx } from "../lib/db";
import { type Actor, permit, ownerOrPermit, rolePermissions } from "./access";
import { event } from "./events";
import { organisationForProperty } from "./organisations";

const reasonSchema = z.string().trim().min(10).max(2000);
const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .transform((s) => {
    const date = new Date(`${s}T00:00:00.000Z`);
    if (
      !Number.isFinite(date.getTime()) ||
      date.toISOString().slice(0, 10) !== s ||
      date < new Date("1900-01-01") ||
      date > new Date()
    )
      throw new Error("INVALID_PAYMENT_DATE");
    return date;
  });
const emptyOptional = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess(
    (v) => (v === "" || v === null ? undefined : v),
    schema.optional(),
  );
async function active(actor: Actor, tx: Tx) {
  if (
    !(
      await tx.user.findUnique({
        where: { id: actor.id },
        select: { active: true },
      })
    )?.active
  )
    throw new Error("UNAUTHENTICATED");
}
async function manualPayment(
  tx: Tx,
  id: string,
  actor: Actor,
  financeOnly = false,
) {
  await tx.$queryRaw`SELECT id FROM "Payment" WHERE id=${id} FOR UPDATE`;
  const payment = await tx.payment.findUniqueOrThrow({ where: { id } });
  await organisationForProperty(payment.propertyId, tx);
  if (financeOnly) await permit(actor, payment.propertyId, "finance", tx);
  else
    await ownerOrPermit(
      actor,
      payment.userId,
      payment.propertyId,
      "finance",
      tx,
    );
  if (
    !["BANK", "CASH"].includes(payment.method) ||
    payment.status !== "PROOF_REVIEW" ||
    payment.settledAt
  )
    throw new Error("PAYMENT_EVIDENCE_NOT_EDITABLE");
  return payment;
}
export async function recordPaymentEvidence(actor: Actor, input: unknown) {
  const d = z
    .object({
      paymentId: z.string().min(1),
      paymentDate: dateSchema,
      currency: z.enum(["USD", "ZWG"]),
      bankName: emptyOptional(z.string().trim().min(2).max(120)),
      accountLast4: emptyOptional(z.string().regex(/^\d{4}$/)),
      reason: reasonSchema,
    })
    .parse(input);
  return transaction(async (tx) => {
    await active(actor, tx);
    const p = await manualPayment(tx, d.paymentId, actor);
    if (d.currency !== p.currency) throw new Error("PAYMENT_CURRENCY_MISMATCH");
    if (p.method === "BANK" && !d.bankName)
      throw new Error("BANK_NAME_REQUIRED");
    if (p.method === "CASH" && (d.bankName || d.accountLast4))
      throw new Error("CASH_HAS_NO_BANK_DETAILS");
    const before = await tx.paymentEvidence.findUnique({
      where: { paymentId: p.id },
    });
    const fields = {
      paymentDate: d.paymentDate,
      bankName: d.bankName || null,
      accountLast4: d.accountLast4 || null,
    };
    const evidence = await tx.paymentEvidence.upsert({
      where: { paymentId: p.id },
      create: {
        paymentId: p.id,
        propertyId: p.propertyId,
        recordedBy: actor.id,
        ...fields,
      },
      update: fields,
    });
    await event(
      tx,
      actor.id,
      p.propertyId,
      "payment.evidence_updated",
      p.id,
      {
        reason: d.reason,
        before: before
          ? {
              paymentDate: before.paymentDate.toISOString(),
              bankName: before.bankName,
              accountLast4: before.accountLast4,
            }
          : null,
        after: {
          paymentDate: evidence.paymentDate.toISOString(),
          bankName: evidence.bankName,
          accountLast4: evidence.accountLast4,
        },
      },
      p.userId,
    );
    return evidence;
  });
}
export async function assignPaymentReviewer(actor: Actor, input: unknown) {
  const d = z
    .object({
      paymentId: z.string().min(1),
      reviewerId: z.string().min(1),
      reason: reasonSchema,
    })
    .parse(input);
  return transaction(async (tx) => {
    const p = await manualPayment(tx, d.paymentId, actor, true);
    const reviewer = await tx.user.findUnique({
      where: { id: d.reviewerId },
      select: {
        active: true,
        mfaConfirmed: true,
        emailVerifiedAt: true,
        phoneVerifiedAt: true,
      },
    });
    const grant = await tx.membership.findFirst({
      where: {
        userId: d.reviewerId,
        propertyId: p.propertyId,
        role: { in: ["FINANCE", "FINANCE_APPROVER"] },
      },
    });
    if (
      !grant ||
      !reviewer?.active ||
      !reviewer.mfaConfirmed ||
      !reviewer.emailVerifiedAt ||
      !reviewer.phoneVerifiedAt
    )
      throw new Error("ELIGIBLE_FINANCE_REVIEWER_REQUIRED");
    if (d.reviewerId === p.proposedBy || d.reviewerId === p.userId)
      throw new Error("INDEPENDENT_FINANCE_REVIEWER_REQUIRED");
    const evidence = await tx.paymentEvidence.findUnique({
      where: { paymentId: p.id },
    });
    if (!evidence) throw new Error("PAYMENT_EVIDENCE_DETAILS_REQUIRED");
    await tx.paymentEvidence.update({
      where: { id: evidence.id },
      data: { assignedReviewerId: d.reviewerId },
    });
    await event(
      tx,
      actor.id,
      p.propertyId,
      "payment.reviewer_assigned",
      p.id,
      {
        previousReviewerId: evidence.assignedReviewerId,
        reviewerId: d.reviewerId,
        reason: d.reason,
      },
      p.userId,
    );
    return { paymentId: p.id, reviewerId: d.reviewerId };
  });
}
export async function openPaymentDispute(actor: Actor, input: unknown) {
  const d = z
    .object({ paymentId: z.string().min(1), reason: reasonSchema })
    .parse(input);
  return transaction(async (tx) => {
    await active(actor, tx);
    await tx.$queryRaw`SELECT id FROM "Payment" WHERE id=${d.paymentId} FOR UPDATE`;
    const p = await tx.payment.findUniqueOrThrow({
      where: { id: d.paymentId },
    });
    await organisationForProperty(p.propertyId, tx);
    if (actor.apiPropertyId || p.userId !== actor.id)
      throw new Error("FORBIDDEN");
    const existing = await tx.paymentDispute.findFirst({
      where: { paymentId: p.id, state: { in: ["OPEN", "INVESTIGATING"] } },
    });
    if (existing) throw new Error("EXISTING_OPEN_PAYMENT_DISPUTE");
    const dispute = await tx.paymentDispute.create({
      data: {
        paymentId: p.id,
        propertyId: p.propertyId,
        userId: p.userId,
        reason: d.reason,
        events: {
          create: { actorId: actor.id, state: "OPEN", reason: d.reason },
        },
      },
    });
    await event(
      tx,
      actor.id,
      p.propertyId,
      "payment.dispute_opened",
      dispute.id,
      { paymentId: p.id },
      p.userId,
    );
    return dispute;
  });
}
export async function reviewPaymentDispute(actor: Actor, input: unknown) {
  const d = z
    .object({
      id: z.string().min(1),
      state: z.enum(["INVESTIGATING", "RESOLVED", "REJECTED"]),
      reason: reasonSchema,
      verified: z.union([z.boolean(), z.string()]).optional(),
    })
    .parse(input);
  return transaction(async (tx) => {
    const dispute = await tx.paymentDispute.findUniqueOrThrow({
      where: { id: d.id },
      include: { payment: { include: { evidence: true, property: true } } },
    });
    const p = dispute.payment;
    await tx.$queryRaw`SELECT id FROM "Payment" WHERE id=${p.id} FOR UPDATE`;
    await permit(actor, p.propertyId, "finance", tx);
    if (
      actor.id === dispute.userId ||
      (p.property.makerChecker && actor.id === p.proposedBy)
    )
      throw new Error("INDEPENDENT_FINANCE_REVIEWER_REQUIRED");
    if (!["OPEN", "INVESTIGATING"].includes(dispute.state))
      throw new Error("PAYMENT_DISPUTE_ALREADY_CLOSED");
    if (
      p.evidence?.assignedReviewerId &&
      p.evidence.assignedReviewerId !== actor.id
    )
      throw new Error("ASSIGNED_FINANCE_REVIEWER_REQUIRED");
    if (d.state === "RESOLVED") {
      if (!(d.verified === true || d.verified === "on"))
        throw new Error("VERIFIED_EVIDENCE_CONFIRMATION_REQUIRED");
      if (
        ["BANK", "CASH"].includes(p.method) &&
        (!p.evidence || !p.bankReference)
      )
        throw new Error("PAYMENT_EVIDENCE_DETAILS_REQUIRED");
      if (p.method === "BANK") {
        const proof = await tx.document.findUnique({
          where: { id: p.proofDocumentId || "" },
        });
        if (
          !proof ||
          proof.userId !== p.userId ||
          proof.propertyId !== p.propertyId ||
          proof.kind !== "PAYMENT_PROOF" ||
          !["CLEAN", "APPROVED"].includes(proof.state) ||
          proof.scanResult !== "CLEAN" ||
          proof.hash !== p.proofHash
        )
          throw new Error("VERIFIED_CLEAN_PROOF_REQUIRED");
      }
      if (
        p.method === "PAYNOW" &&
        !["PAID", "PARTIALLY_REFUNDED", "REFUNDED"].includes(p.status)
      )
        throw new Error("AUTHORITATIVE_PROVIDER_RECONCILIATION_REQUIRED");
    }
    const reviewed = await tx.paymentDispute.update({
      where: { id: dispute.id },
      data: {
        state: d.state,
        reviewedBy: actor.id,
        resolution: d.reason,
        events: {
          create: { actorId: actor.id, state: d.state, reason: d.reason },
        },
      },
    });
    await event(
      tx,
      actor.id,
      p.propertyId,
      "payment.dispute_reviewed",
      dispute.id,
      {
        paymentId: p.id,
        state: d.state,
        reason: d.reason,
        ledgerPosted: false,
      },
      p.userId,
    );
    return reviewed;
  });
}
export async function assertNoOpenPaymentDisputes(tx: Tx, paymentId: string) {
  if (
    await tx.paymentDispute.count({
      where: { paymentId, state: { in: ["OPEN", "INVESTIGATING"] } },
    })
  )
    throw new Error("RESOLVE_PAYMENT_DISPUTE_BEFORE_POSTING");
}
export async function paymentEvidenceOverview(
  actor: Actor,
  propertyId: string,
  page = 1,
) {
  page = z.number().int().min(1).max(10000).parse(page);
  return transaction(async (tx) => {
    await active(actor, tx);
    await organisationForProperty(propertyId, tx);
    const grants = await tx.membership.findMany({
      where: { userId: actor.id, propertyId },
    });
    const canRead = grants.some((g) =>
      rolePermissions[g.role]?.includes("finance.read"),
    );
    const canWrite = grants.some((g) =>
      rolePermissions[g.role]?.includes("finance"),
    );
    if (canRead) await permit(actor, propertyId, "finance.read", tx);
    const payments = await tx.payment.findMany({
      where: { propertyId, ...(!canRead ? { userId: actor.id } : {}) },
      select: {
        id: true,
        propertyId: true,
        userId: true,
        reference: true,
        method: true,
        status: true,
        amountMinor: true,
        currency: true,
        bankReference: true,
        proposedBy: true,
        createdAt: true,
        proofDocumentId: true,
        evidence: true,
        disputes: {
          include: { events: { orderBy: { createdAt: "asc" }, take: 20 } },
          orderBy: { createdAt: "desc" },
          take: 10,
        },
      },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * 20,
      take: 21,
    });
    const reviewers = canWrite
      ? await tx.membership.findMany({
          where: {
            propertyId,
            role: { in: ["FINANCE", "FINANCE_APPROVER"] },
            user: {
              active: true,
              mfaConfirmed: true,
              emailVerifiedAt: { not: null },
              phoneVerifiedAt: { not: null },
            },
          },
          select: { userId: true, user: { select: { name: true } } },
          distinct: ["userId"],
        })
      : [];
    return {
      payments: payments.slice(0, 20),
      hasNext: payments.length > 20,
      page,
      reviewers,
      canWrite,
      canRead,
    };
  });
}
