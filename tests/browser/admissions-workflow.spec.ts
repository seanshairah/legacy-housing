import { expect, test } from "@playwright/test";
import { db } from "../../src/lib/db";
import {
  actorContext,
  api,
  fullFixture,
  reserveViaUi,
  submit,
} from "./support";

test.skip(
  process.env.LEGACY_FULL_E2E !== "true",
  "Guarded HTTPS full workflow suite required",
);
test.setTimeout(90000);

test("A01 staff assign and stage an application while internal review notes stay out of the resident portal and export", async ({
  browser,
}) => {
  const f = await fullFixture(),
    resident = await actorContext(browser, f, "RESIDENT"),
    staff = await actorContext(browser, f, "ADMISSIONS");
  const portal = await resident.newPage(),
    application = await reserveViaUi(portal, f),
    page = await staff.newPage();
  const path = `/workspace/admissions?property=${f.property.id}`;
  const privateText = `SYNTHETIC PRIVATE REVIEW ${f.run}`;
  async function openReview() {
    await page.goto(path);
    const panel = page.locator("#review-management");
    await expect(panel).toBeVisible();
    const card = panel
      .locator("details.record-card")
      .filter({
        has: page.locator(`input[name="id"][value="${application.id}"]`),
      })
      .first();
    await card.locator("summary").click();
    return card;
  }
  await api(
    resident,
    "admissions.note",
    { id: application.id, body: "Resident cannot write internal notes" },
    "FORBIDDEN",
  );
  await openReview();
  await submit(
    page,
    "admissions.assign",
    {
      reviewerId: f.people.ADMISSIONS.id,
      reason: "Synthetic specialist assigned to review this application",
    },
    application.id,
  );
  expect(
    (await db.application.findUniqueOrThrow({ where: { id: application.id } }))
      .assignedReviewerId,
  ).toBe(f.people.ADMISSIONS.id);
  await openReview();
  await submit(page, "admissions.note", { body: privateText }, application.id);
  const note = await db.applicationReviewNote.findFirstOrThrow({
    where: { applicationId: application.id, kind: "NOTE" },
  });
  expect(note.body).toBe(privateText);
  const publicMessage =
    "Please provide a clear synthetic proof of residence before review.";
  await openReview();
  await submit(
    page,
    "admissions.stage",
    { stage: "DOCUMENTS_PENDING", reason: publicMessage },
    application.id,
  );
  await portal.goto("/portal");
  await expect(
    portal.getByText(publicMessage, { exact: true }).first(),
  ).toBeVisible();
  await expect(portal.getByText(privateText, { exact: true })).toHaveCount(0);
  const exported = await resident.request.get("/api/v1/me-export");
  expect(exported.status()).toBe(200);
  const body = await exported.text();
  expect(body).not.toContain(privateText);
  expect(body).not.toContain(note.id);
  await openReview();
  await submit(
    page,
    "admissions.stage",
    {
      stage: "IN_REVIEW",
      reason:
        "Synthetic documents received and independent review is underway.",
    },
    application.id,
  );
  expect(
    (await db.application.findUniqueOrThrow({ where: { id: application.id } }))
      .status,
  ).toBe("IN_REVIEW");
  await page.goto(path);
  await page.locator('[name="reviewStatus"]').selectOption("IN_REVIEW");
  await page
    .locator('[name="reviewAssigned"]')
    .selectOption(f.people.ADMISSIONS.id);
  await page
    .getByRole("button", { name: "Filter reviews", exact: true })
    .click();
  await expect(page.locator("#review-management")).toContainText(
    "1 matching applications",
  );
  await api(staff, "application.review", {
    id: application.id,
    decision: "DECLINED",
    reason:
      "Synthetic review decision for the complete admissions workflow test",
  });
  await api(
    staff,
    "admissions.stage",
    {
      id: application.id,
      stage: "IN_REVIEW",
      reason: "Closed review must not be silently reopened",
    },
    "APPLICATION_REVIEW_CLOSED",
  );
  await resident.close();
  await staff.close();
});
