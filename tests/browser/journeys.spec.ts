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
const url = "postgresql://postgres@127.0.0.1:5432/legacy_test";
if (process.env.DATABASE_URL !== url)
  throw new Error("Browser tests require legacy_test");
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
  for (const path of ["/portal", "/workspace/overview"]) {
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
