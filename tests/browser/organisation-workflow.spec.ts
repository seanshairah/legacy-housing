import { test, expect } from "@playwright/test";
import { db } from "../../src/lib/db";
import { actorContext, fullFixture, origin, submit } from "./support";

test.skip(
  process.env.LEGACY_FULL_E2E !== "true",
  "Requires guarded HTTPS production suite",
);
test.setTimeout(120000);
test("O01 operator provisioning → organisation settings → scoped property → merchant storage → membership revocation", async ({
  browser,
}) => {
  const f = await fullFixture();
  await db.platformGrant.create({ data: { userId: f.people.ADMIN.id } });
  const operator = await actorContext(browser, f, "ADMIN"),
    op = await operator.newPage();
  const slug = `org-${f.run}`;
  await op.goto("/workspace/organisations");
  await submit(op, "organisation.create", {
    name: `Synthetic organisation ${f.run.slice(0, 8)}`,
    slug,
    legalEntity: "Synthetic independent organisation entity",
    adminUserId: f.people.FINANCE.id,
    residencyRegion: "SYNTHETIC LOCAL TEST",
  });
  const organisation = await db.organisation.findUniqueOrThrow({
    where: { slug },
  });
  expect(organisation.paymentMode).toBe("disabled");
  expect(
    (
      await operator.request.get(
        `/api/organisations?organisationId=${organisation.id}`,
      )
    ).status(),
  ).toBe(403);
  const owner = await actorContext(browser, f, "FINANCE"),
    page = await owner.newPage();
  await page.goto(`/workspace/organisations?organisation=${organisation.id}`);
  await expect(
    page.getByRole("heading", { name: "Branding and governance" }),
  ).toBeVisible();
  await submit(page, "organisation.update", {
    name: "Synthetic independent provider",
    legalEntity: "Synthetic legal provider",
    displayName: "Independent synthetic residence",
    primaryColour: "#2a5141",
    supportEmail: "help@example.invalid",
    residencyRegion: "SYNTHETIC APPROVED REGION",
    policyReference: "SYNTHETIC RETENTION POLICY",
    noticeVersion: "synthetic-v1",
  });
  await page.goto(`/workspace/organisations?organisation=${organisation.id}`);
  const propertySlug = `org-property-${f.run}`;
  await submit(page, "property.create", {
    name: "Synthetic organisation property",
    slug: propertySlug,
    legalEntity: "Synthetic property entity",
    description:
      "Synthetic independent property used only in end to end verification.",
    location: "Test only",
    currency: "USD",
    deposit: "0.00",
    holdMinutes: "30",
  });
  const property = await db.property.findUniqueOrThrow({
    where: { slug: propertySlug },
  });
  expect(property.organisationId).toBe(organisation.id);
  expect(property.published).toBe(false);
  await page.goto(`/workspace/inventory?property=${property.id}`);
  await expect(
    page.getByRole("link", {
      name: "Independent synthetic residence",
      exact: true,
    }),
  ).toBeVisible();
  expect(
    await page
      .locator(".app-shell")
      .evaluate((el) =>
        getComputedStyle(el).getPropertyValue("--green").trim(),
      ),
  ).toBe("#2a5141");
  const properties = await owner.request.get(
    `/api/organisations?organisationId=${organisation.id}&resource=properties`,
  );
  expect(properties.status()).toBe(200);
  expect(
    (await properties.json()).data.map((p: { id: string }) => p.id),
  ).toEqual([property.id]);
  await page.goto(`/workspace/organisations?organisation=${organisation.id}`);
  const syntheticKey = "synthetic-browser-merchant-never-real";
  await submit(page, "organisation.payment", {
    mode: "disabled",
    integrationId: "synthetic-browser-id",
    integrationKey: syntheticKey,
    currency: "USD",
  });
  const safeMetadata = await (
    await owner.request.get(
      `/api/organisations?organisationId=${organisation.id}`,
    )
  ).json();
  expect(JSON.stringify(safeMetadata)).not.toContain(syntheticKey);
  expect(JSON.stringify(safeMetadata)).not.toContain(
    "paymentCredentialsEncrypted",
  );
  expect(
    (
      await db.organisation.findUniqueOrThrow({
        where: { id: organisation.id },
      })
    ).paymentCredentialsEncrypted,
  ).not.toContain(syntheticKey);
  const outsider = await actorContext(browser, f, "KYC");
  expect(
    (
      await outsider.request.get(
        `/api/organisations?organisationId=${organisation.id}`,
      )
    ).status(),
  ).toBe(403);
  expect(
    (
      await outsider.request.get(`/api/v1/invoices?propertyId=${property.id}`)
    ).status(),
  ).toBe(403);
  await page.goto(`/workspace/organisations?organisation=${organisation.id}`);
  await submit(page, "organisation.membership", {
    userId: f.people.KYC.id,
    role: "MEMBER",
  });
  expect((await outsider.request.get("/api/v1/me-export")).status()).toBe(401);
  const member = await actorContext(browser, f, "KYC");
  expect(
    (
      await member.request.get(
        `/api/organisations?organisationId=${organisation.id}`,
      )
    ).status(),
  ).toBe(200);
  expect(
    (
      await (
        await member.request.get(
          `/api/organisations?organisationId=${organisation.id}&resource=properties`,
        )
      ).json()
    ).data,
  ).toHaveLength(0);
  expect(
    (
      await member.request.get(`/api/v1/invoices?propertyId=${property.id}`)
    ).status(),
  ).toBe(403);
  const membership = await db.organisationMembership.findFirstOrThrow({
    where: {
      organisationId: organisation.id,
      userId: f.people.KYC.id,
      role: "MEMBER",
    },
  });
  await page.goto(`/workspace/organisations?organisation=${organisation.id}`);
  await submit(
    page,
    "organisation.membership.revoke",
    { reason: "Synthetic organisation access is no longer required" },
    membership.id,
  );
  expect((await member.request.get("/api/v1/me-export")).status()).toBe(401);
  expect(
    await db.organisationMembership.count({ where: { id: membership.id } }),
  ).toBe(0);
  const relogged = await actorContext(browser, f, "KYC");
  expect(
    (
      await relogged.request.get(
        `/api/organisations?organisationId=${organisation.id}`,
      )
    ).status(),
  ).toBe(403);
  const anonymous = await browser.newContext({
    baseURL: origin,
    ignoreHTTPSErrors: true,
  });
  expect((await anonymous.request.get("/api/organisations")).status()).toBe(
    401,
  );
  for (const context of [
    operator,
    owner,
    outsider,
    member,
    relogged,
    anonymous,
  ])
    await context.close();
});
