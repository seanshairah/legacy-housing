import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "@playwright/test";
import { db } from "../../src/lib/db";
import {
  hash,
  token,
  passwordHash,
  encrypt,
  newTotpSecret,
  totp,
} from "../../src/lib/security";
import { randomUUID } from "node:crypto";
const url = new URL(process.env.DATABASE_URL || "postgresql://invalid/invalid");
if (
  url.pathname !== "/legacy_test" ||
  !["localhost", "127.0.0.1"].includes(url.hostname)
)
  throw new Error("Browser tests require a loopback legacy_test database");
async function browserFixture(staff = false) {
  const key = randomUUID(),
    password = "Browser fixture password 57!";
  const user = await db.user.create({
    data: {
      name: "Browser Test Resident",
      email: `browser-${key}@example.invalid`,
      phone: `+999${Date.now()}${Math.floor(Math.random() * 1000)}`,
      passwordHash: await passwordHash(password),
      emailVerifiedAt: new Date(),
      phoneVerifiedAt: new Date(),
    },
  });
  const property = await db.property.create({
    data: {
      name: "Browser test property",
      slug: `browser-${key}`,
      description: "Synthetic browser inventory",
      location: "Test only",
      published: true,
    },
  });
  const building = await db.building.create({
      data: { propertyId: property.id, name: "Test block" },
    }),
    floor = await db.floor.create({
      data: { buildingId: building.id, name: "Ground", level: 0 },
    });
  const room = await db.room.create({
    data: {
      floorId: floor.id,
      name: "B101",
      category: "SHARED",
      monthlyMinor: 12000n,
      beds: { create: [{ label: "A" }, { label: "B" }] },
    },
    include: { beds: true },
  });
  let secret = "";
  if (staff) {
    secret = newTotpSecret();
    await db.user.update({
      where: { id: user.id },
      data: { mfaSecret: encrypt(secret), mfaConfirmed: true },
    });
    await db.membership.create({
      data: { userId: user.id, propertyId: property.id, role: "ADMIN" },
    });
  }
  return { user, password, property, room, secret };
}
async function authenticate(
  page: import("@playwright/test").Page,
  f: Awaited<ReturnType<typeof browserFixture>>,
) {
  await page.goto("/auth");
  await page.getByLabel("Email address").fill(f.user.email);
  await page.getByLabel("Password", { exact: true }).fill(f.password);
  if (f.secret)
    await page.getByLabel("Authenticator code").fill(totp(f.secret).generate());
  await page
    .getByRole("button", { name: "Sign in", exact: false })
    .last()
    .click();
  await expect(page).toHaveURL(/\/portal/);
}
test("public catalogue, accessibility list, resident reservation and ticket persist", async ({
  page,
}) => {
  const f = await browserFixture();
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: /More than a room/ }),
  ).toBeVisible();
  await authenticate(page, f);
  await page.goto(`/rooms?property=${f.property.id}`);
  await expect(page.getByRole("heading", { name: "Room B101" })).toBeVisible();
  const first = page.locator(".bed-list .action-form").first();
  await first.getByRole("checkbox").check();
  await first.getByRole("button", { name: "Reserve" }).click();
  await expect(page).toHaveURL(/\/portal\?success=/);
  await expect(page.getByText("Temporary hold ends")).toBeVisible();
  await expect
    .poll(() =>
      db.reservation.count({ where: { userId: f.user.id, state: "HOLD" } }),
    )
    .toBe(1);
  const form = page
    .locator("form")
    .filter({ has: page.locator('input[value="ticket"]') });
  await form.getByLabel("Category").fill("Plumbing");
  await form.getByLabel("Subject").fill("Synthetic leaking tap");
  await form
    .getByLabel("Tell us")
    .fill("The synthetic tap needs attention in this test.");
  await form.getByRole("button", { name: "Create request" }).click();
  await expect(page.getByText("Synthetic leaking tap")).toBeVisible();
  expect(await db.ticket.count({ where: { userId: f.user.id } })).toBe(1);
  const statement = await page.request.get(
    `/api/financial/statement/${f.property.id}`,
  );
  expect(statement.status()).toBe(200);
  expect((await statement.body()).subarray(0, 5).toString()).toBe("%PDF-");
  const exported = await page.request.get("/api/v1/me-export");
  expect(exported.status()).toBe(200);
  const exportedData = await exported.json();
  expect(exportedData.user.id).toBe(f.user.id);
  expect(JSON.stringify(exportedData)).not.toMatch(
    /passwordHash|mfaSecret|tokenHash/,
  );
});
test("staff authenticator, scoped workspaces, CSRF rejection and no cross-property export", async ({
  page,
}) => {
  const f = await browserFixture(true);
  await authenticate(page, f);
  await page.goto("/workspace/overview");
  await expect(
    page.getByRole("heading", { name: "A clearer view of home." }),
  ).toBeVisible();
  for (const section of [
    "admissions",
    "inventory",
    "kyc",
    "finance",
    "leases",
    "operations",
    "integrations",
    "reports",
    "security",
    "settings",
  ]) {
    await page.goto(`/workspace/${section}`);
    await expect(page.locator("main h1")).toBeVisible();
    await expect(page.locator("body")).not.toContainText("Application error");
  }
  const forged = await page.request.post("/api/v1/commands", {
    headers: { Origin: "https://attacker.invalid" },
    data: { action: "sessions.revoke" },
  });
  expect(forged.status()).toBe(400);
  const denied = await page.request.get(
    "/api/v1/export?propertyId=unknown&resource=invoices",
  );
  expect(denied.status()).toBe(403);
});
test("mobile layout, keyboard access and anonymous private endpoints", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("link", { name: "Skip to content" }),
  ).toBeFocused();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.goto("/rooms");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  const privateRequest = await page.request.get("/api/documents/nonexistent");
  expect(privateRequest.status()).toBe(401);
});
test("registration creates hashed contact challenges; verification is one-use", async ({
  page,
}) => {
  const key = randomUUID();
  await page.goto("/auth");
  const response = await page.request.post("/api/auth", {
    headers: { Origin: "http://localhost:3002" },
    data: {
      action: "register",
      name: "New Browser Resident",
      email: `new-${key}@example.invalid`,
      phone: `+999${Date.now().toString().slice(-10)}`,
      password: "New secure password 90!",
      residentType: "PRIVATE",
    },
  });
  expect(response.status()).toBe(200);
  const user = await db.user.findUniqueOrThrow({
    where: { email: `new-${key}@example.invalid` },
  });
  expect(await db.challenge.count({ where: { userId: user.id } })).toBe(2);
  const raw = token();
  await db.challenge.create({
    data: {
      userId: user.id,
      kind: "EMAIL",
      tokenHash: hash(raw),
      expiresAt: new Date(Date.now() + 60000),
    },
  });
  const verify = () =>
    page.request.post("/api/auth", {
      headers: { Origin: "http://localhost:3002" },
      data: { action: "verify", token: raw },
    });
  expect((await verify()).status()).toBe(200);
  expect((await verify()).status()).toBe(400);
});

test("public and authenticated pages have no automated WCAG A/AA violations", async ({
  page,
}) => {
  const f = await browserFixture(true);
  const violations: unknown[] = [];
  for (const path of ["/", "/auth", `/rooms?property=${f.property.id}`]) {
    await page.goto(path);
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
      .analyze();
    violations.push(
      ...results.violations.map((v) => ({
        path,
        id: v.id,
        nodes: v.nodes.map((n) => n.target),
      })),
    );
  }
  await authenticate(page, f);
  for (const path of [
    "/portal",
    "/workspace/overview",
    "/workspace/reports",
    "/workspace/finance",
    "/workspace/security",
  ]) {
    await page.goto(path);
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
      .analyze();
    violations.push(
      ...results.violations.map((v) => ({
        path,
        id: v.id,
        nodes: v.nodes.map((n) => n.target),
      })),
    );
  }
  expect(violations).toEqual([]);
});

test("resident reads, electronically signs and downloads the exact scanned agreement", async ({
  page,
}) => {
  const f = await browserFixture();
  f.secret = newTotpSecret();
  await db.user.update({
    where: { id: f.user.id },
    data: { mfaSecret: encrypt(f.secret), mfaConfirmed: true },
  });
  const manager = await browserFixture(true);
  await db.membership.create({
    data: { userId: manager.user.id, propertyId: f.property.id, role: "ADMIN" },
  });
  const { reserve } = await import("../../src/domain/inventory"),
    { issueLease, executeLease } = await import("../../src/domain/leases");
  const a = await reserve(f.user, {
    bedId: f.room.beds[0].id,
    startAt: new Date(),
    endAt: new Date(Date.now() + 90 * 86400000),
    consent: true,
    termsVersion: "application-policy-v1",
  });
  await db.reservation.update({
    where: { id: a.reservation.id },
    data: { state: "CONFIRMED", expiresAt: null },
  });
  await db.application.update({
    where: { id: a.application.id },
    data: { status: "LEASE_SIGNING_PENDING" },
  });
  const body =
    "SYNTHETIC BROWSER TEST ONLY. This is a test agreement for an authenticator-backed signing journey, not a real tenancy.";
  const template = await db.leaseTemplate.create({
    data: {
      propertyId: f.property.id,
      version: 1,
      title: "Browser signing test",
      body,
      hash: hash(body),
      approvedAt: new Date(),
      approvedBy: manager.user.id,
      signingDisclosure:
        "TEST ONLY. I intend to electronically sign this exact synthetic agreement with my typed name and authenticator verification, subject to staff execution review.",
    },
  });
  const lease = await issueLease(manager.user, a.application.id, template.id);
  await authenticate(page, f);
  await page.getByText("Read agreement online", { exact: true }).click();
  await expect(page.getByText(body, { exact: false }).first()).toBeVisible();
  await page
    .getByRole("button", { name: "Review for electronic signing" })
    .click();
  if (process.env.LEGACY_CAPTURE_SCREENSHOTS === "true")
    await page.screenshot({
      path: "docs/USER_GUIDES/screenshots/electronic-lease-signing.png",
      fullPage: true,
      caret: "initial",
    });
  const signingAxe = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(
    signingAxe.violations.map((v) => ({
      id: v.id,
      nodes: v.nodes.map((n) => n.target),
    })),
  ).toEqual([]);
  await page
    .getByLabel("Full name as shown on the agreement")
    .fill(f.user.name);
  await page
    .getByLabel("Current authenticator code")
    .fill(totp(f.secret).generate());
  await page
    .getByLabel("I have reviewed this exact agreement", { exact: false })
    .check();
  await page
    .getByRole("button", { name: "Sign agreement electronically", exact: true })
    .click();
  await expect
    .poll(
      async () =>
        (await db.lease.findUniqueOrThrow({ where: { id: lease.id } })).status,
    )
    .toBe("REVIEW");
  const link = page.getByRole("link", { name: "Download signed lease copy" });
  await expect(link).toBeVisible();
  const result = await page.request.get((await link.getAttribute("href"))!);
  expect(result.status()).toBe(200);
  expect(hash(await result.body())).toBe(
    (await db.lease.findUniqueOrThrow({ where: { id: lease.id } })).signedHash,
  );
  await executeLease(
    manager.user,
    lease.id,
    "Browser fixture: independently reviewed exact signature evidence",
  );
  await page.reload();
  await expect(
    page.locator(".lease-card").getByText("executed", { exact: true }),
  ).toBeVisible();
});

test("staff sees source-record collection reports and completes a scoped security investigation", async ({
  page,
}) => {
  const f = await browserFixture(true);
  const { reserve } = await import("../../src/domain/inventory"),
    { issueCharge } = await import("../../src/domain/finance"),
    { securitySignal } = await import("../../src/lib/security-monitor");
  await reserve(f.user, {
    bedId: f.room.beds[0].id,
    startAt: new Date(),
    endAt: new Date(Date.now() + 90 * 86400000),
    consent: true,
    termsVersion: "application-policy-v1",
  });
  await issueCharge(f.user, {
    userId: f.user.id,
    propertyId: f.property.id,
    reference: `browser-rent-${randomUUID()}`,
    category: "RENT",
    description: "Synthetic outstanding rent",
    amount: "100.00",
    dueAt: new Date(Date.now() - 86400000),
  });
  for (let i = 0; i < 5; i++)
    await securitySignal({
      kind: "ACCESS_DENIED",
      subject: `browser-${f.user.id}`,
      propertyId: f.property.id,
    });
  await authenticate(page, f);
  await page.goto(`/workspace/reports?property=${f.property.id}`);
  await expect(
    page.getByRole("heading", {
      name: "Collections, debtors & reconciliation",
    }),
  ).toBeVisible();
  await expect(
    page.getByText("Overdue rental debt", { exact: true }),
  ).toBeVisible();
  const report = await page.request.get(
    (await page
      .getByRole("link", { name: "Download reconciliation CSV" })
      .getAttribute("href"))!,
  );
  expect(report.status()).toBe(200);
  expect(await report.text()).toContain('"received_minor"');
  await page.goto(`/workspace/security?property=${f.property.id}`);
  const card = page
    .locator(".record-card")
    .filter({ has: page.getByText("ACCESS DENIED", { exact: true }) })
    .first();
  await expect(card).toContainText("HIGH");
  if (process.env.LEGACY_CAPTURE_SCREENSHOTS === "true")
    await page.screenshot({
      path: "docs/USER_GUIDES/screenshots/security-monitoring.png",
      fullPage: true,
      caret: "initial",
    });
  await card.getByLabel("Review status").selectOption("RESOLVED");
  await card
    .getByLabel("Investigation / resolution")
    .fill("Synthetic browser investigation completed; access remains denied.");
  await card.getByRole("button", { name: "Record security review" }).click();
  await expect(
    page.getByText(
      "Synthetic browser investigation completed; access remains denied.",
    ),
  ).toBeVisible();
});

test("staff capabilities remain specific to the selected property across mixed roles", async ({
  page,
}) => {
  const f = await browserFixture(true),
    finance = await browserFixture(),
    audit = await browserFixture();
  await db.membership.updateMany({
    where: { userId: f.user.id, propertyId: f.property.id },
    data: { role: "PROPERTY_MANAGER" },
  });
  await db.property.update({
    where: { id: finance.property.id },
    data: { name: "Restricted finance-only property" },
  });
  await db.membership.createMany({
    data: [
      { userId: f.user.id, propertyId: finance.property.id, role: "FINANCE" },
      { userId: f.user.id, propertyId: audit.property.id, role: "AUDITOR" },
    ],
  });
  await authenticate(page, f);
  await page.goto(`/workspace/overview?property=${finance.property.id}`);
  await expect(page.locator("main")).not.toContainText(
    "Restricted finance-only property",
  );
  await page.goto(`/workspace/overview?property=${f.property.id}`);
  await expect(page.getByRole("table")).toHaveCount(0);
  await page.goto(`/workspace/finance?property=${audit.property.id}`);
  await expect(
    page.getByRole("heading", { name: "Resident accounts" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: "Record received cash for independent verification",
    }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Issue invoice / charge" }),
  ).toHaveCount(0);
});
