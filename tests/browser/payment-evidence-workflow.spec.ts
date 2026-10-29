import { test, expect } from "@playwright/test";
import { db } from "../../src/lib/db";
import {
  actorContext,
  api,
  fullFixture,
  reserveViaUi,
  submit,
  uploadViaUi,
} from "./support";

test.skip(
  process.env.LEGACY_FULL_E2E !== "true",
  "Requires guarded HTTPS/worker fixture suite",
);
test.setTimeout(120000);

test("F11 payment details → assigned reviewer → dispute review → independently verified settlement", async ({
  browser,
}) => {
  const f = await fullFixture(),
    resident = await actorContext(browser, f, "RESIDENT"),
    finance = await actorContext(browser, f, "FINANCE_APPROVER");
  const page = await resident.newPage();
  await reserveViaUi(page, f);
  const proof = await uploadViaUi(page, f.property.id, "PAYMENT_PROOF");
  const payment = await api(resident, "payment", {
    propertyId: f.property.id,
    userId: f.people.RESIDENT.id,
    amount: "10.00",
    method: "BANK",
    proofDocumentId: proof.id,
    bankReference: `SYNTHETIC-DISPUTE-${f.run}`,
    idempotencyKey: `dispute-${f.run}`,
  });
  const open = async (target: typeof page) => {
    const panel = target.getByRole("region", {
      name: "Payment evidence and disputes",
    });
    await panel
      .locator("summary")
      .filter({ hasText: payment.reference })
      .first()
      .click();
    return panel;
  };
  await page.goto("/portal");
  await open(page);
  await submit(page, "evidence.update", {
    paymentDate: new Date().toISOString().slice(0, 10),
    bankName: "Synthetic browser test bank",
    accountLast4: "1234",
    reason: "SYNTHETIC bank tender details recorded for verification",
  });
  expect(
    (
      await db.paymentEvidence.findUniqueOrThrow({
        where: { paymentId: payment.id },
      })
    ).accountLast4,
  ).toBe("1234");
  const staff = await finance.newPage();
  const staffPath = `/workspace/finance?property=${f.property.id}`;
  await staff.goto(staffPath);
  await open(staff);
  await submit(staff, "evidence.assign", {
    reviewerId: f.people.FINANCE_APPROVER.id,
    reason: "Independent synthetic finance reviewer assigned",
  });
  await page.goto("/portal");
  await open(page);
  await submit(page, "payment.dispute", {
    reason: "SYNTHETIC resident requests the bank reference to be checked",
  });
  const dispute = await db.paymentDispute.findFirstOrThrow({
    where: { paymentId: payment.id },
  });
  await api(
    finance,
    "proof.review",
    {
      id: payment.id,
      decision: "APPROVE",
      reason: "Open dispute must block posting funds",
    },
    "RESOLVE_PAYMENT_DISPUTE_BEFORE_POSTING",
  );
  expect(await db.receipt.count({ where: { paymentId: payment.id } })).toBe(0);
  await staff.goto(staffPath);
  await open(staff);
  await submit(
    staff,
    "payment.dispute.review",
    {
      state: "INVESTIGATING",
      reason: "SYNTHETIC reference and bank evidence under review",
    },
    dispute.id,
  );
  await open(staff);
  await submit(
    staff,
    "payment.dispute.review",
    {
      state: "RESOLVED",
      reason: "TEST ONLY synthetic bank evidence independently checked",
      verified: true,
    },
    dispute.id,
  );
  expect(
    (await db.payment.findUniqueOrThrow({ where: { id: payment.id } })).status,
  ).toBe("PROOF_REVIEW");
  expect(await db.receipt.count({ where: { paymentId: payment.id } })).toBe(0);
  await submit(
    staff,
    "proof.review",
    {
      decision: "APPROVE",
      reason: "TEST ONLY separately verified synthetic bank settlement",
    },
    payment.id,
  );
  expect(
    (await db.payment.findUniqueOrThrow({ where: { id: payment.id } })).status,
  ).toBe("PAID");
  const receipt = await db.receipt.findUniqueOrThrow({
    where: { paymentId: payment.id },
  });
  expect(
    (
      await resident.request.get(`/api/financial/receipt/${receipt.id}`)
    ).status(),
  ).toBe(200);
  await page.goto("/portal");
  const panel = await open(page);
  await expect(panel).toContainText("RESOLVED");
  await expect(
    panel.locator("form").filter({
      has: page.locator('input[name="action"][value="evidence.update"]'),
    }),
  ).toHaveCount(0);
  expect(
    await db.paymentDisputeEvent.count({ where: { disputeId: dispute.id } }),
  ).toBe(3);
  await resident.close();
  await finance.close();
});
