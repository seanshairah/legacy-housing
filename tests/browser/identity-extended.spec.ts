import { test, expect } from "@playwright/test";
import { fullFixture, actorContext, origin } from "./support";
import { totp } from "../../src/lib/security";
import { db } from "../../src/lib/db";

test.skip(
  process.env.LEGACY_FULL_E2E !== "true",
  "Requires guarded HTTPS full workflow fixture",
);
test.setTimeout(180000);

test("F10 real MFA recovery-code UI and staff invitation creation → acceptance → session revocation → authenticator replacement", async ({
  browser,
}) => {
  const f = await fullFixture(),
    admin = await actorContext(browser, f, "ADMIN"),
    resident = await browser.newContext({
      baseURL: origin,
      ignoreHTTPSErrors: true,
    }),
    page = await resident.newPage();
  async function credentials() {
    await page.getByLabel("Email address").fill(f.people.RESIDENT.email);
    await page.getByLabel("Password", { exact: true }).fill(f.password);
  }
  async function enroll() {
    await page.getByRole("button", { name: "MFA", exact: true }).click();
    await credentials();
    await page.getByRole("button", { name: "Set up authenticator" }).click();
    const secret = await page.locator("code.secret").innerText();
    await page.getByLabel("Authenticator code").fill(totp(secret).generate());
    await page.getByRole("button", { name: "Confirm authenticator" }).click();
    await expect(page.getByRole("status")).toContainText(
      "Authenticator confirmed",
    );
    const codes = await page
      .getByLabel("New authenticator recovery codes")
      .locator("li code")
      .allTextContents();
    expect(codes).toHaveLength(10);
    return { secret, codes };
  }
  await page.goto("/auth");
  const initial = await enroll();
  await page
    .getByRole("button", { name: "Sign in", exact: true })
    .first()
    .click();
  await credentials();
  await page
    .getByLabel("Authenticator code")
    .fill(totp(initial.secret).generate());
  await page
    .getByRole("button", { name: /Sign in/ })
    .last()
    .click();
  await expect(page).toHaveURL(/\/portal/);
  expect((await resident.request.get("/api/v1/me-export")).status()).toBe(200);

  const unauthorized = await resident.request.post("/api/auth", {
    headers: { Origin: origin },
    data: {
      action: "invitation.create",
      propertyId: f.property.id,
      email: f.people.OTHER.email,
      role: "ADMIN",
      reason: "Resident privilege escalation attempt must fail",
    },
  });
  expect(unauthorized.status()).toBe(400);
  expect((await unauthorized.json()).error).toBe("FORBIDDEN");
  expect(
    await db.accountInvitation.count({ where: { propertyId: f.property.id } }),
  ).toBe(0);
  const management = await admin.newPage();
  await management.goto(`/workspace/settings?property=${f.property.id}`);
  const invitations = management.getByRole("region", {
    name: "Staff invitations",
    exact: true,
  });
  await invitations.getByLabel("Staff email").fill(f.people.RESIDENT.email);
  await invitations.getByLabel("Granted role").selectOption("FINANCE");
  await invitations
    .getByLabel("Invitation reason")
    .fill("Synthetic approved invitation for complete browser testing");
  await invitations
    .getByRole("button", { name: "Create staff invitation" })
    .click();
  const invitationCode = await invitations.locator(".notice code").innerText();
  expect(invitationCode.length).toBeGreaterThan(30);
  await expect(invitations).toContainText(f.people.RESIDENT.email);
  await page.goto("/auth");
  await page
    .getByRole("button", { name: "Accept invitation", exact: true })
    .click();
  await credentials();
  await page.getByLabel("Staff invitation code").fill(invitationCode);
  await page
    .getByLabel("Authenticator code")
    .fill(totp(initial.secret).generate());
  await page.getByRole("button", { name: "Accept staff invitation" }).click();
  await expect(page.getByRole("status")).toContainText("Invitation accepted");
  expect((await resident.request.get("/api/v1/me-export")).status()).toBe(401);
  expect(
    await db.membership.count({
      where: {
        userId: f.people.RESIDENT.id,
        propertyId: f.property.id,
        role: "FINANCE",
      },
    }),
  ).toBe(1);
  const replay = await resident.request.post("/api/auth", {
    headers: { Origin: origin },
    data: {
      action: "invitation.accept",
      email: f.people.RESIDENT.email,
      password: f.password,
      code: totp(initial.secret).generate(),
      token: invitationCode,
    },
  });
  expect(replay.status()).toBe(400);
  await page
    .getByRole("button", { name: "Sign in", exact: true })
    .first()
    .click();
  await credentials();
  await page
    .getByLabel("Authenticator code")
    .fill(totp(initial.secret).generate());
  await page
    .getByRole("button", { name: /Sign in/ })
    .last()
    .click();
  await expect(page).toHaveURL(/\/portal/);
  expect(
    (
      await resident.request.get(`/api/v1/invoices?propertyId=${f.property.id}`)
    ).status(),
  ).toBe(200);

  await page.goto("/auth");
  await page
    .getByRole("button", { name: "Lost authenticator", exact: true })
    .click();
  await credentials();
  await page
    .getByLabel("Saved authenticator recovery code")
    .fill(initial.codes[0]);
  await page.getByRole("button", { name: "Recover authenticator" }).click();
  await expect(page.getByRole("status")).toContainText(
    "Lost authenticator removed",
  );
  expect((await resident.request.get("/api/v1/me-export")).status()).toBe(401);
  const denied = await resident.request.post("/api/auth", {
    headers: { Origin: origin },
    data: {
      action: "login",
      email: f.people.RESIDENT.email,
      password: f.password,
    },
  });
  expect(denied.status()).toBe(400);
  expect((await denied.json()).error).toBe("STAFF_MFA_ENROLLMENT_REQUIRED");
  const replacement = await enroll();
  const oldCode = await resident.request.post("/api/auth", {
    headers: { Origin: origin },
    data: {
      action: "mfa-recover",
      email: f.people.RESIDENT.email,
      password: f.password,
      recoveryCode: initial.codes[1],
    },
  });
  expect(oldCode.status()).toBe(400);
  await page
    .getByRole("button", { name: "Recovery codes", exact: true })
    .click();
  await credentials();
  await page
    .getByLabel("Authenticator code")
    .fill(totp(replacement.secret).generate());
  await page.getByRole("button", { name: "Replace recovery codes" }).click();
  await expect(page.getByRole("status")).toContainText(
    "Recovery codes replaced",
  );
  const rotated = await page
    .getByLabel("New authenticator recovery codes")
    .locator("li code")
    .allTextContents();
  expect(rotated).toHaveLength(10);
  expect(rotated.some((code) => replacement.codes.includes(code))).toBe(false);

  await invitations.getByLabel("Staff email").fill(f.people.OTHER.email);
  await invitations
    .getByRole("button", { name: "Create staff invitation" })
    .click();
  await expect(invitations).toContainText(f.people.OTHER.email);
  const pending = invitations
    .locator("div")
    .filter({ has: management.locator("form input[name=reason]") })
    .last();
  await pending
    .getByLabel("Revocation reason")
    .fill("Synthetic onboarding invitation revoked before acceptance");
  await pending.getByRole("button", { name: "Revoke invitation" }).click();
  await expect(invitations.getByRole("status")).toContainText(
    "Invitation revoked",
  );
  expect(
    (
      await db.accountInvitation.findFirstOrThrow({
        where: { propertyId: f.property.id, email: f.people.OTHER.email },
        orderBy: { createdAt: "desc" },
      })
    ).revokedAt,
  ).not.toBeNull();
  await resident.close();
  await admin.close();
});
