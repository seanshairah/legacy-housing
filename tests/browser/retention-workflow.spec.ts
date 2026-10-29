import { test, expect } from "@playwright/test";
import { db } from "../../src/lib/db";
import {
  fullFixture,
  actorContext,
  api,
  submit,
  uploadViaUi,
  reserveViaUi,
} from "./support";

test.skip(
  process.env.LEGACY_FULL_E2E !== "true",
  "Guarded HTTPS/worker fixture suite required",
);
test.setTimeout(120000);
test("R01 real upload → retention policy → independent approval → hold → independent release → private payload erasure", async ({
  browser,
}) => {
  const f = await fullFixture();
  // Independent, already MFA-enrolled reviewer. Fixture grant is setup only;
  // every retention operation below uses the real authenticated browser routes.
  await db.membership.create({
    data: {
      propertyId: f.property.id,
      userId: f.people.PROPERTY_MANAGER.id,
      role: "ADMIN",
    },
  });
  const maker = await actorContext(browser, f, "ADMIN"),
    checker = await actorContext(browser, f, "PROPERTY_MANAGER"),
    resident = await actorContext(browser, f, "RESIDENT"),
    old = new Date(Date.now() - 10 * 86400000);
  const uploadPage = await resident.newPage(),
    application = await reserveViaUi(uploadPage, f),
    doc = await uploadViaUi(uploadPage, f.property.id, "IDENTITY");
  await api(resident, "application.withdraw", {
    id: application.id,
    reason: "Synthetic applicant withdraws before retention review",
  });
  await db.application.update({
    where: { id: application.id },
    data: { updatedAt: old },
  });
  // Clock advance is isolated fixture setup, never a production policy default.
  await db.document.update({ where: { id: doc.id }, data: { createdAt: old } });
  const m = await maker.newPage(),
    c = await checker.newPage(),
    path = `/workspace/settings?property=${f.property.id}`;
  await m.goto(path);
  await m
    .locator("#retention")
    .getByText("Propose a retention policy", { exact: true })
    .click();
  await submit(m, "retention.policy", {
    kind: "IDENTITY",
    retainDays: "1",
    policyReference: "SYNTHETIC-POLICY-ONLY",
    basis:
      "SYNTHETIC browser retention policy, not a real legal retention schedule.",
  });
  const policy = await db.retentionPolicy.findFirstOrThrow({
    where: { propertyId: f.property.id },
  });
  await expect(m.locator("#retention")).toContainText(
    "Another administrator must approve your proposal",
  );
  await api(
    maker,
    "retention.policy.approve",
    { id: policy.id, reason: "Self approval must be rejected" },
    "INDEPENDENT_RETENTION_APPROVER_REQUIRED",
  );
  await c.goto(path);
  await submit(
    c,
    "retention.policy.approve",
    { reason: "Independent reviewer approved synthetic test policy" },
    policy.id,
  );
  await c
    .locator("#retention")
    .getByText("Place a legal hold on this document", { exact: true })
    .click();
  await submit(c, "retention.hold", {
    reason: "SYNTHETIC legal hold for deletion workflow verification",
  });
  const hold = await db.documentLegalHold.findFirstOrThrow({
    where: { documentId: doc.id },
  });
  await m.reload();
  await expect(m.locator("#retention")).toContainText(
    "A legal hold prevents deletion",
  );
  await api(
    maker,
    "retention.request",
    { documentId: doc.id, reason: "Held document must remain preserved" },
    "LEGAL_HOLD",
  );
  await submit(
    m,
    "retention.hold.release",
    { reason: "Independent synthetic hold review permits release" },
    hold.id,
  );
  await submit(m, "retention.request", {
    reason: "SYNTHETIC expired payload reviewed against approved policy",
  });
  const request = await db.documentDeletion.findUniqueOrThrow({
    where: { documentId: doc.id },
  });
  await c.reload();
  await submit(
    c,
    "retention.approve",
    { reason: "Independent reviewer verified synthetic deletion evidence" },
    request.id,
  );
  const erase = c
    .locator("#retention")
    .getByRole("button", { name: "Erase approved document payload" });
  await expect(erase).toBeEnabled();
  await submit(c, "retention.execute", { confirm: true }, request.id);
  const erased = await db.document.findUniqueOrThrow({ where: { id: doc.id } });
  expect(erased.state).toBe("DELETED");
  expect(erased.deletedAt).toBeTruthy();
  expect(erased.filename).toBe("erased-document");
  expect(erased.hash).toBe(doc.hash);
  expect(
    (await resident.request.get(`/api/documents/${doc.id}`)).status(),
  ).toBe(403);
  expect(
    await db.auditEvent.count({
      where: { objectId: request.id, action: "retention.document_deleted" },
    }),
  ).toBe(1);
  await expect(c.locator("#retention")).toContainText(
    "The private payload has already been erased",
  );
  for (const context of [maker, checker, resident]) await context.close();
});
