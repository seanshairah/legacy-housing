import {
  type Browser,
  type BrowserContext,
  type Page,
  expect,
} from "@playwright/test";
import { randomUUID } from "node:crypto";
import { PDFDocument } from "pdf-lib";
import { db } from "../../src/lib/db";
import {
  passwordHash,
  encrypt,
  newTotpSecret,
  totp,
} from "../../src/lib/security";
import { assertTestDatabase } from "../safety";
assertTestDatabase();
export const origin =
  process.env.LEGACY_E2E_BASE_URL || "http://localhost:3002";
export async function fullFixture(organisationId = "mipf") {
  const run = randomUUID(),
    password = "Complete workflow fixture 2026!",
    digest = await passwordHash(password);
  const property = await db.property.create({
    data: {
      name: `Workflow ${run.slice(0, 8)}`,
      organisationId,
      slug: `workflow-${run}`,
      description: "SYNTHETIC FULL WORKFLOW TEST PROPERTY",
      location: "Test only",
      published: true,
      holdMinutes: 120,
      depositMinor: 3000n,
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
      name: "T101",
      category: "SHARED",
      monthlyMinor: 12000n,
      beds: { create: [{ label: "A" }, { label: "B" }, { label: "C" }] },
    },
    include: { beds: true },
  });
  const people: Record<
    string,
    { id: string; name: string; email: string; phone: string; secret: string }
  > = {};
  for (const role of [
    "ADMIN",
    "ADMISSIONS",
    "FINANCE",
    "PROPERTY_MANAGER",
    "CARETAKER",
    "KYC",
    "MEDICAL_REVIEWER",
    "AUDITOR",
    "MAINTENANCE_OFFICER",
    "LEASING_OFFICER",
    "FINANCE_APPROVER",
    "PLATFORM_OPERATOR",
    "RESIDENT",
    "OTHER",
  ]) {
    const secret = newTotpSecret(),
      staff = !["RESIDENT", "OTHER"].includes(role);
    const u = await db.user.create({
      data: {
        name: `Synthetic ${role}`,
        email: `${role.toLowerCase()}-${run}@example.invalid`,
        phone: `+2637${Date.now().toString().slice(-7)}${String(Object.keys(people).length).padStart(2, "0")}`,
        passwordHash: digest,
        emailVerifiedAt: new Date(),
        phoneVerifiedAt: new Date(),
        emergencyName: "Synthetic emergency contact",
        emergencyPhone: "+263770000099",
        ...(staff ? { mfaSecret: encrypt(secret), mfaConfirmed: true } : {}),
      },
    });
    if (staff)
      await db.membership.create({
        data: { userId: u.id, propertyId: property.id, role },
      });
    people[role] = { ...u, secret: staff ? secret : "" };
  }
  const start = new Date(new Date().toISOString().slice(0, 10)),
    end = new Date(start.getTime() + 90 * 86400000);
  return { property, building, floor, room, people, password, start, end, run };
}
export async function actorContext(
  browser: Browser,
  f: Awaited<ReturnType<typeof fullFixture>>,
  role: string,
) {
  const context = await browser.newContext({
    baseURL: origin,
    ignoreHTTPSErrors: origin.startsWith("https:"),
  });
  const p = f.people[role];
  const response = await context.request.post("/api/auth", {
    headers: { Origin: origin },
    data: {
      action: "login",
      email: p.email,
      password: f.password,
      ...(p.secret ? { code: totp(p.secret).generate() } : {}),
    },
  });
  expect(response.status()).toBe(200);
  expect((await response.json()).ok).toBe(true);
  return context;
}
export async function api(
  context: BrowserContext,
  action: string,
  input: Record<string, unknown> = {},
  error?: string,
) {
  const response = await context.request.post("/api/v1/commands", {
    headers: { Origin: origin },
    data: { action, ...input },
  });
  const body = await response.json();
  if (error) {
    expect(response.status(), JSON.stringify(body)).toBe(400);
    expect(body.error).toContain(error);
    return body;
  }
  expect(response.status(), JSON.stringify(body)).toBe(200);
  return body.data;
}
export function form(page: Page, action: string, id?: string) {
  let f = page
    .locator("form")
    .filter({ has: page.locator(`input[name="action"][value="${action}"]`) });
  if (id)
    f = f.filter({ has: page.locator(`input[name="id"][value="${id}"]`) });
  return f;
}
export async function submit(
  page: Page,
  action: string,
  values: Record<string, string | boolean>,
  id?: string,
) {
  const f = form(page, action, id).first();
  await expect(f).toBeVisible();
  for (const [name, value] of Object.entries(values)) {
    const field = f.locator(`[name="${name}"]`);
    const tag = await field.evaluate((e) => e.tagName);
    if (typeof value === "boolean") await field.setChecked(value);
    else if (tag === "SELECT") await field.selectOption(value);
    else await field.fill(value);
  }
  await f.getByRole("button").last().click();
  await expect(page).not.toHaveURL(/error=/);
  await expect(page).toHaveURL(/success=/);
}
export async function testPdf(label = "SYNTHETIC WORKFLOW FILE") {
  const pdf = await PDFDocument.create();
  pdf.addPage().drawText(label, { x: 30, y: 700, size: 10 });
  return Buffer.from(await pdf.save());
}
export async function uploadViaUi(
  page: Page,
  propertyId: string,
  kind: string,
) {
  await page.goto("/portal#documents");
  const f = page
    .locator('form[enctype="multipart/form-data"]')
    .filter({ has: page.locator('select[name="kind"]') })
    .first();
  await f.locator('[name="kind"]').selectOption(kind);
  if (kind === "MEDICAL") await f.locator('[name="medicalConsent"]').check();
  await f.locator('input[type="file"]').setInputFiles({
    name: `synthetic-${kind}.pdf`,
    mimeType: "application/pdf",
    buffer: await testPdf(`SYNTHETIC ${kind}. NO REAL PERSONAL DATA.`),
  });
  await f.getByRole("button", { name: "Upload securely" }).click();
  await expect(page).not.toHaveURL(/error=/);
  const actor = await page.context().cookies();
  expect(actor.some((c) => c.name === "legacy_session")).toBe(true);
  const doc = await db.document.findFirstOrThrow({
    where: { propertyId, kind },
    orderBy: { createdAt: "desc" },
  });
  await expect
    .poll(
      async () =>
        (await db.document.findUniqueOrThrow({ where: { id: doc.id } })).state,
      { timeout: 30000 },
    )
    .toBe("CLEAN");
  return doc;
}
export async function reserveViaUi(
  page: Page,
  f: Awaited<ReturnType<typeof fullFixture>>,
) {
  await page.goto(
    `/rooms?property=${f.property.id}&startAt=${f.start.toISOString().slice(0, 10)}&endAt=${f.end.toISOString().slice(0, 10)}`,
  );
  const reserve = form(page, "reserve").first();
  await reserve.locator('[name="consent"]').check();
  await reserve.getByRole("button").click();
  await expect(page).toHaveURL(/success=/);
  return db.application.findFirstOrThrow({
    where: { userId: f.people.RESIDENT.id, propertyId: f.property.id },
  });
}
