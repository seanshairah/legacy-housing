import { afterAll, afterEach, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { db } from "../src/lib/db";
import { fullFixture, testPdf } from "./browser/support";
import { upload, scanDocument } from "../src/domain/documents";
import { proposePayment, reviewProof } from "../src/domain/finance";
import {
  assignPaymentReviewer,
  openPaymentDispute,
  paymentEvidenceOverview,
  recordPaymentEvidence,
  reviewPaymentDispute,
} from "../src/domain/payment-evidence";
import { assertTestDatabase } from "./safety";
import { GET } from "../src/app/api/v1/[resource]/route";

const auth = vi.hoisted(() => ({ id: "" }));
vi.mock("../src/lib/current-user", () => ({
  currentUser: async () => (auth.id ? { id: auth.id } : null),
}));
afterEach(() => {
  auth.id = "";
});

assertTestDatabase();
process.env.DATA_KEY ||= randomBytes(32).toString("hex");
process.env.FILE_KEY ||= randomBytes(32).toString("hex");
const previousRoot = process.env.STORAGE_ROOT;
process.env.STORAGE_ROOT = `.data/test-payment-evidence-${randomUUID()}`;
afterAll(async () => {
  if (previousRoot === undefined) delete process.env.STORAGE_ROOT;
  else process.env.STORAGE_ROOT = previousRoot;
  await db.$disconnect();
});
const today = () => new Date().toISOString().slice(0, 10);
async function fixture(method: "BANK" | "CASH" = "BANK") {
  const f = await fullFixture();
  const application = await db.application.create({
    data: { propertyId: f.property.id, userId: f.people.RESIDENT.id },
  });
  let documentId: string | undefined;
  if (method === "BANK") {
    const document = await upload(f.people.RESIDENT, {
      propertyId: f.property.id,
      applicationId: application.id,
      kind: "PAYMENT_PROOF",
      filename: "synthetic-bank-evidence.pdf",
      bytes: await testPdf("SYNTHETIC PAYMENT EVIDENCE ONLY"),
    });
    await scanDocument(document.id);
    expect(
      (await db.document.findUniqueOrThrow({ where: { id: document.id } }))
        .state,
    ).toBe("CLEAN");
    documentId = document.id;
  }
  const payment = await proposePayment(
    method === "BANK" ? f.people.RESIDENT : f.people.FINANCE,
    {
      propertyId: f.property.id,
      userId: f.people.RESIDENT.id,
      method,
      amount: "10.00",
      bankReference: `SYNTHETIC-${randomUUID()}`,
      proofDocumentId: documentId,
      idempotencyKey: randomUUID(),
    },
  );
  const details = {
    paymentId: payment.id,
    paymentDate: today(),
    currency: "USD",
    ...(method === "BANK"
      ? { bankName: "Synthetic test bank", accountLast4: "1234" }
      : {}),
    reason: "Synthetic date and tender details checked",
  };
  return { ...f, payment, details };
}

it("records actual tender metadata with immutable audit history and does not post funds", async () => {
  const f = await fixture();
  const evidence = await recordPaymentEvidence(f.people.RESIDENT, f.details);
  expect(evidence.paymentDate.toISOString().slice(0, 10)).toBe(today());
  expect(evidence.accountLast4).toBe("1234");
  expect(evidence.recordedBy).toBe(f.people.RESIDENT.id);
  expect(await db.receipt.count({ where: { paymentId: f.payment.id } })).toBe(
    0,
  );
  expect(
    (await db.payment.findUniqueOrThrow({ where: { id: f.payment.id } }))
      .status,
  ).toBe("PROOF_REVIEW");
  const updated = await recordPaymentEvidence(f.people.RESIDENT, {
    ...f.details,
    accountLast4: "5678",
    reason: "Synthetic last four digit correction",
  });
  expect(updated.id).toBe(evidence.id);
  const history = await db.auditEvent.findMany({
    where: { objectId: f.payment.id, action: "payment.evidence_updated" },
    orderBy: { createdAt: "asc" },
  });
  expect(history).toHaveLength(2);
  expect(JSON.stringify(history[1].detail)).toContain("1234");
  expect(JSON.stringify(history[1].detail)).toContain("5678");
});

it("rejects foreign metadata, invalid dates, currency substitution and full bank account numbers", async () => {
  const f = await fixture(),
    foreign = await fullFixture();
  await expect(
    recordPaymentEvidence(foreign.people.FINANCE, f.details),
  ).rejects.toThrow("FORBIDDEN");
  await expect(
    recordPaymentEvidence(f.people.OTHER, f.details),
  ).rejects.toThrow("FORBIDDEN");
  for (const patch of [
    { paymentDate: "2099-01-01" },
    { paymentDate: "2026-02-30" },
    { paymentDate: "1899-12-31" },
    { accountLast4: "1234567890" },
    { currency: "ZWG" },
    { bankName: "" },
  ])
    await expect(
      recordPaymentEvidence(f.people.RESIDENT, { ...f.details, ...patch }),
    ).rejects.toThrow();
  await db.user.update({
    where: { id: f.people.RESIDENT.id },
    data: { active: false },
  });
  await expect(
    recordPaymentEvidence(f.people.RESIDENT, f.details),
  ).rejects.toThrow("UNAUTHENTICATED");
  expect(
    await db.paymentEvidence.count({ where: { paymentId: f.payment.id } }),
  ).toBe(0);
});

it("requires a verified independent finance reviewer in the same property", async () => {
  const f = await fixture("CASH");
  await recordPaymentEvidence(f.people.RESIDENT, f.details);
  await expect(
    recordPaymentEvidence(f.people.RESIDENT, {
      ...f.details,
      bankName: "Not allowed for cash",
    }),
  ).rejects.toThrow("CASH_HAS_NO_BANK_DETAILS");
  await expect(
    assignPaymentReviewer(f.people.RESIDENT, {
      paymentId: f.payment.id,
      reviewerId: f.people.FINANCE_APPROVER.id,
      reason: "Synthetic resident attempts to choose approver",
    }),
  ).rejects.toThrow("FORBIDDEN");
  await expect(
    assignPaymentReviewer(f.people.ADMIN, {
      paymentId: f.payment.id,
      reviewerId: f.people.FINANCE.id,
      reason: "Synthetic maker must not review own cash",
    }),
  ).rejects.toThrow("INDEPENDENT_FINANCE_REVIEWER_REQUIRED");
  await expect(
    assignPaymentReviewer(f.people.ADMIN, {
      paymentId: f.payment.id,
      reviewerId: f.people.CARETAKER.id,
      reason: "Synthetic caretaker must not approve finance",
    }),
  ).rejects.toThrow("ELIGIBLE_FINANCE_REVIEWER_REQUIRED");
  await assignPaymentReviewer(f.people.ADMIN, {
    paymentId: f.payment.id,
    reviewerId: f.people.FINANCE_APPROVER.id,
    reason: "Synthetic independent verified approver assigned",
  });
  await expect(
    reviewProof(
      f.people.ADMIN,
      f.payment.id,
      "APPROVE",
      "Synthetic wrong assigned approver",
    ),
  ).rejects.toThrow("ASSIGNED_FINANCE_REVIEWER_REQUIRED");
  expect(await db.receipt.count({ where: { paymentId: f.payment.id } })).toBe(
    0,
  );
});

it("blocks settlement while disputed and preserves independent review history without fabricating verification", async () => {
  const f = await fixture();
  await recordPaymentEvidence(f.people.RESIDENT, f.details);
  await assignPaymentReviewer(f.people.ADMIN, {
    paymentId: f.payment.id,
    reviewerId: f.people.FINANCE_APPROVER.id,
    reason: "Synthetic independent approver assigned",
  });
  const dispute = await openPaymentDispute(f.people.RESIDENT, {
    paymentId: f.payment.id,
    reason: "Synthetic resident disputes the tender reference",
  });
  await expect(
    openPaymentDispute(f.people.RESIDENT, {
      paymentId: f.payment.id,
      reason: "Synthetic duplicate dispute must be denied",
    }),
  ).rejects.toThrow("EXISTING_OPEN_PAYMENT_DISPUTE");
  await expect(
    openPaymentDispute(f.people.OTHER, {
      paymentId: f.payment.id,
      reason: "Synthetic substituted reference must be denied",
    }),
  ).rejects.toThrow("FORBIDDEN");
  await expect(
    reviewProof(
      f.people.FINANCE_APPROVER,
      f.payment.id,
      "APPROVE",
      "Must resolve dispute before settlement",
    ),
  ).rejects.toThrow("RESOLVE_PAYMENT_DISPUTE_BEFORE_POSTING");
  await expect(
    reviewPaymentDispute(f.people.RESIDENT, {
      id: dispute.id,
      state: "RESOLVED",
      reason: "Resident cannot approve own dispute",
      verified: true,
    }),
  ).rejects.toThrow("FORBIDDEN");
  await expect(
    reviewPaymentDispute(f.people.FINANCE, {
      id: dispute.id,
      state: "INVESTIGATING",
      reason: "Wrong assigned reviewer cannot review",
    }),
  ).rejects.toThrow("ASSIGNED_FINANCE_REVIEWER_REQUIRED");
  await reviewPaymentDispute(f.people.FINANCE_APPROVER, {
    id: dispute.id,
    state: "INVESTIGATING",
    reason: "Synthetic bank reference under investigation",
  });
  await expect(
    reviewPaymentDispute(f.people.FINANCE_APPROVER, {
      id: dispute.id,
      state: "RESOLVED",
      reason: "Synthetic evidence not yet independently confirmed",
    }),
  ).rejects.toThrow("VERIFIED_EVIDENCE_CONFIRMATION_REQUIRED");
  await reviewPaymentDispute(f.people.FINANCE_APPROVER, {
    id: dispute.id,
    state: "RESOLVED",
    reason: "TEST ONLY synthetic bank evidence independently checked",
    verified: true,
  });
  expect(await db.receipt.count({ where: { paymentId: f.payment.id } })).toBe(
    0,
  );
  expect(
    (await db.payment.findUniqueOrThrow({ where: { id: f.payment.id } }))
      .status,
  ).toBe("PROOF_REVIEW");
  expect(
    await db.paymentDisputeEvent.count({ where: { disputeId: dispute.id } }),
  ).toBe(3);
  await reviewProof(
    f.people.FINANCE_APPROVER,
    f.payment.id,
    "APPROVE",
    "TEST ONLY independent synthetic tender settlement",
  );
  expect(await db.receipt.count({ where: { paymentId: f.payment.id } })).toBe(
    1,
  );
  await expect(
    recordPaymentEvidence(f.people.RESIDENT, f.details),
  ).rejects.toThrow("PAYMENT_EVIDENCE_NOT_EDITABLE");
  await expect(
    db.paymentEvidence.update({
      where: { paymentId: f.payment.id },
      data: { accountLast4: "9999" },
    }),
  ).rejects.toThrow();
  await expect(
    db.paymentDisputeEvent.updateMany({
      where: { disputeId: dispute.id },
      data: { reason: "rewrite" },
    }),
  ).rejects.toThrow();
});

it("limits overview to the actor's own records or granted property and omits provider secrets", async () => {
  const f = await fixture("CASH"),
    foreign = await fullFixture();
  await recordPaymentEvidence(f.people.RESIDENT, f.details);
  const own = await paymentEvidenceOverview(f.people.RESIDENT, f.property.id);
  expect(own.payments.map((p) => p.id)).toEqual([f.payment.id]);
  expect(own.canWrite).toBe(false);
  expect(
    (await paymentEvidenceOverview(f.people.OTHER, f.property.id)).payments,
  ).toHaveLength(0);
  expect(
    (await paymentEvidenceOverview(foreign.people.FINANCE, f.property.id))
      .payments,
  ).toHaveLength(0);
  const finance = await paymentEvidenceOverview(
    f.people.FINANCE,
    f.property.id,
  );
  expect(finance.canWrite).toBe(true);
  expect(finance.payments[0]).not.toHaveProperty("providerConfigEncrypted");
  await expect(
    paymentEvidenceOverview(f.people.RESIDENT, f.property.id, 0),
  ).rejects.toThrow();
});

it("authenticated account export includes own evidence and dispute history without provider secrets or foreign payments", async () => {
  const f = await fixture("CASH"),
    foreign = await fixture("CASH");
  await recordPaymentEvidence(f.people.RESIDENT, f.details);
  const dispute = await openPaymentDispute(f.people.RESIDENT, {
    paymentId: f.payment.id,
    reason: "Synthetic export should include the resident's dispute",
  });
  await db.payment.update({
    where: { id: f.payment.id },
    data: { providerConfigEncrypted: "synthetic-sensitive-envelope" },
  });
  auth.id = f.people.RESIDENT.id;
  const response = await GET(
    new Request("https://example.invalid/api/v1/me-export"),
    { params: Promise.resolve({ resource: "me-export" }) },
  );
  expect(response.status).toBe(200);
  const result = await response.json();
  expect(result.payments).toHaveLength(1);
  expect(result.payments[0].id).toBe(f.payment.id);
  expect(result.payments[0].evidence.paymentDate.slice(0, 10)).toBe(today());
  expect(result.payments[0].disputes[0].id).toBe(dispute.id);
  expect(result.payments[0].disputes[0].events[0].state).toBe("OPEN");
  expect(JSON.stringify(result)).not.toContain("synthetic-sensitive-envelope");
  expect(JSON.stringify(result)).not.toContain("providerConfigEncrypted");
  expect(JSON.stringify(result)).not.toContain(foreign.payment.reference);
});
