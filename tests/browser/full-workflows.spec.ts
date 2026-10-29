import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { db } from "../../src/lib/db";
import {
  fullFixture,
  actorContext,
  api,
  submit,
  uploadViaUi,
  reserveViaUi,
  origin,
  testPdf,
} from "./support";
import { totp, hash } from "../../src/lib/security";
test.skip(
  process.env.LEGACY_FULL_E2E !== "true",
  "Run the guarded HTTPS/worker/provider-boundary full suite",
);
test.setTimeout(180000);

test("F01 real UI application → scanned KYC → independent bank verification → manual lease → move-in → tickets → turnover", async ({
  browser,
}) => {
  const f = await fullFixture(),
    resident = await actorContext(browser, f, "RESIDENT"),
    admissions = await actorContext(browser, f, "ADMISSIONS"),
    kyc = await actorContext(browser, f, "KYC"),
    finance = await actorContext(browser, f, "FINANCE"),
    admin = await actorContext(browser, f, "ADMIN"),
    caretaker = await actorContext(browser, f, "CARETAKER");
  const page = await resident.newPage(),
    a = await reserveViaUi(page, f);
  await api(
    admissions,
    "application.review",
    { id: a.id, decision: "APPROVED", reason: "Premature approval must fail" },
    "KYC_INCOMPLETE",
  );
  for (const kind of [
    "IDENTITY",
    "RESIDENCE",
    "REGISTRATION",
    "SPONSOR",
    "MEDICAL",
  ]) {
    const d = await uploadViaUi(page, f.property.id, kind);
    if (kind === "MEDICAL") {
      await api(
        kyc,
        "document.review",
        {
          id: d.id,
          decision: "APPROVED",
          reason: "KYC must not see medical evidence",
        },
        "FORBIDDEN",
      );
      expect((await kyc.request.get(`/api/documents/${d.id}`)).status()).toBe(
        403,
      );
    } else
      await api(kyc, "document.review", {
        id: d.id,
        decision: "APPROVED",
        reason: "Synthetic evidence independently checked",
      });
  }
  const ap = await admissions.newPage();
  await ap.goto(`/workspace/admissions?property=${f.property.id}`);
  await submit(
    ap,
    "application.review",
    { decision: "APPROVED", reason: "All required synthetic evidence checked" },
    a.id,
  );
  const charge = await db.charge.findUniqueOrThrow({
    where: { reference: `DEP-${a.id}` },
  });
  expect(charge.amountMinor).toBe(3000n);
  const proof = await uploadViaUi(page, f.property.id, "PAYMENT_PROOF");
  const payment = await api(resident, "payment", {
    propertyId: f.property.id,
    userId: f.people.RESIDENT.id,
    amount: "40.00",
    method: "BANK",
    proofDocumentId: proof.id,
    bankReference: `BANK-${f.run}`,
    idempotencyKey: `bank-${f.run}`,
  });
  expect(payment.status).toBe("PROOF_REVIEW");
  expect(await db.receipt.count({ where: { paymentId: payment.id } })).toBe(0);
  await api(
    caretaker,
    "proof.review",
    {
      id: payment.id,
      decision: "APPROVE",
      reason: "Caretaker must not post funds",
    },
    "FORBIDDEN",
  );
  const fp = await finance.newPage();
  await fp.goto(`/workspace/finance?property=${f.property.id}`);
  await submit(
    fp,
    "proof.review",
    {
      decision: "APPROVE",
      reason: "TEST ONLY verified bank reference and amount",
    },
    payment.id,
  );
  const receipt = await db.receipt.findUniqueOrThrow({
    where: { paymentId: payment.id },
  });
  expect(
    (
      await resident.request.get(`/api/financial/receipt/${receipt.id}`)
    ).status(),
  ).toBe(200);
  expect(
    (await db.application.findUniqueOrThrow({ where: { id: a.id } })).status,
  ).toBe("LEASE_SIGNING_PENDING");
  const invoices = [];
  for (const category of ["RENT", "UTILITIES", "PENALTY", "OTHER"]) {
    invoices.push(
      await api(finance, "charge", {
        propertyId: f.property.id,
        userId: f.people.RESIDENT.id,
        category,
        reference: `${category}-${f.run}`,
        description: `Synthetic ${category}`,
        amount: "2.00",
        dueAt: f.start.toISOString(),
      }),
    );
  }
  expect(
    (
      await api(resident, "credit.apply", {
        userId: f.people.RESIDENT.id,
        propertyId: f.property.id,
      })
    ).appliedMinor,
  ).toBe("800");
  expect(
    (
      await api(resident, "credit.apply", {
        userId: f.people.RESIDENT.id,
        propertyId: f.property.id,
      })
    ).appliedMinor,
  ).toBe("0");
  const correction = await api(finance, "charge", {
    propertyId: f.property.id,
    userId: f.people.RESIDENT.id,
    category: "OTHER",
    reference: `CORRECTION-${f.run}`,
    description: "Synthetic invoice correction",
    amount: "1.00",
    dueAt: f.start.toISOString(),
  });
  await api(finance, "credit", {
    id: correction.id,
    amount: "1.00",
    reference: `CREDIT-${f.run}`,
    reason: "Synthetic erroneous invoice fully corrected",
  });
  await api(finance, "refund", {
    id: payment.id,
    amount: "1.00",
    reference: `REFUND-${f.run}`,
    reason: "TEST ONLY externally verified excess funds returned",
  });
  await api(
    finance,
    "refund",
    {
      id: payment.id,
      amount: "999.00",
      reference: `OVER-${f.run}`,
      reason: "Synthetic excessive refund must fail",
    },
    "INVALID_REFUND",
  );
  expect(
    (
      await resident.request.get(`/api/financial/invoice/${invoices[0].id}`)
    ).status(),
  ).toBe(200);
  expect(
    (
      await resident.request.get(`/api/financial/statement/${f.property.id}`)
    ).status(),
  ).toBe(200);
  const template = await api(admin, "template", {
    propertyId: f.property.id,
    title: "Synthetic full lifecycle terms",
    body: "TEST ONLY. This synthetic agreement is used solely to verify the complete manual lease workflow. It is not an operative agreement or a real tenancy.",
    legalApproval: "on",
  });
  const lease = await api(admissions, "lease.issue", {
    applicationId: a.id,
    templateId: template.id,
  });
  const signed = await uploadViaUi(page, f.property.id, "SIGNED_LEASE");
  await page.reload();
  await submit(
    page,
    "lease.sign",
    { documentId: signed.id, consent: true },
    lease.id,
  );
  const lp = await admissions.newPage();
  await lp.goto(`/workspace/leases?property=${f.property.id}`);
  await submit(
    lp,
    "lease.return",
    { reason: "Synthetic copy needs a complete signature" },
    lease.id,
  );
  expect(
    (await db.lease.findUniqueOrThrow({ where: { id: lease.id } })).status,
  ).toBe("AWAITING_SIGNATURE");
  const replacement = await uploadViaUi(page, f.property.id, "SIGNED_LEASE");
  await page.reload();
  await submit(
    page,
    "lease.sign",
    { documentId: replacement.id, consent: true },
    lease.id,
  );
  await lp.reload();
  await submit(
    lp,
    "lease.execute",
    { reason: "Independent signer and exact replacement hash checked" },
    lease.id,
  );
  await lp.reload();
  await submit(lp, "checkin", {}, lease.id);
  expect(
    (await db.application.findUniqueOrThrow({ where: { id: a.id } })).status,
  ).toBe("ACTIVE");
  expect(
    hash(
      await (
        await resident.request.get(`/api/documents/${replacement.id}`)
      ).body(),
    ),
  ).toBe(replacement.hash);
  for (const type of ["MAINTENANCE", "COMPLAINT", "COMPLIMENT", "SUPPORT"]) {
    await page.goto("/portal#support");
    await submit(page, "ticket", {
      type,
      category: "Synthetic service",
      priority: "URGENT",
      subject: `${type} ${f.run}`,
      body: "Synthetic complete service lifecycle request.",
    });
  }
  const ticket = await db.ticket.findFirstOrThrow({
    where: { propertyId: f.property.id, type: "MAINTENANCE" },
  });
  await api(caretaker, "ticket.update", {
    id: ticket.id,
    status: "IN_PROGRESS",
    body: "Synthetic first response",
    assignedTo: f.people.CARETAKER.id,
  });
  await api(caretaker, "ticket.update", {
    id: ticket.id,
    status: "RESOLVED",
    body: "Synthetic repair completed",
  });
  await api(resident, "ticket.update", {
    id: ticket.id,
    status: "OPEN",
    body: "Synthetic issue reoccurred, please reopen",
  });
  expect(
    (await db.ticket.findUniqueOrThrow({ where: { id: ticket.id } }))
      .firstResponseAt,
  ).not.toBeNull();
  await page.goto("/portal");
  await submit(
    page,
    "exit",
    { reason: "Synthetic resident gives notice to leave" },
    lease.id,
  );
  await lp.reload();
  await submit(
    lp,
    "checkout",
    {
      reason:
        "Synthetic move-out inspection complete; deposit finance review recorded",
    },
    lease.id,
  );
  expect(
    (await db.bed.findUniqueOrThrow({ where: { id: f.room.beds[0].id } }))
      .blocked,
  ).toBe(true);
  await api(admin, "bed.block", {
    id: f.room.beds[0].id,
    blocked: false,
    reason: "Turnover inspection complete",
  });
  for (const c of [resident, admissions, kyc, finance, admin, caretaker])
    await c.close();
});

test("F02 hosted Paynow boundary → signed callback → worker polling → partial/failed/refunded ledger states", async ({
  browser,
}) => {
  const f = await fullFixture(),
    resident = await actorContext(browser, f, "RESIDENT"),
    finance = await actorContext(browser, f, "FINANCE"),
    page = await resident.newPage();
  await reserveViaUi(page, f);
  await api(finance, "charge", {
    propertyId: f.property.id,
    userId: f.people.RESIDENT.id,
    reference: `RENT-${f.run}`,
    category: "RENT",
    description: "Synthetic gateway rent",
    amount: "100.00",
    dueAt: new Date().toISOString(),
  });
  const initiate = await api(resident, "payment", {
    propertyId: f.property.id,
    userId: f.people.RESIDENT.id,
    method: "PAYNOW",
    amount: "40.00",
    idempotencyKey: `gateway-${f.run}`,
  });
  expect(initiate.redirect).toMatch(/^https:\/\/www.paynow.co.zw\//);
  const p = await db.payment.findUniqueOrThrow({
    where: { idempotencyKey: `gateway-${f.run}` },
  });
  await page.route("https://www.paynow.co.zw/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<h1>TEST ONLY hosted checkout boundary</h1>",
    }),
  );
  await page.goto(initiate.redirect);
  await expect(page.getByRole("heading")).toHaveText(
    "TEST ONLY hosted checkout boundary",
  );
  const control = await resident.request.post("http://127.0.0.1:3410/control", {
      data: { reference: p.reference, status: "paid", outage: "true" },
    }),
    fields = await control.json();
  const bad = await resident.request.post(`${origin}/api/v1/paynow/result`, {
    form: { ...fields, hash: "0".repeat(128) },
  });
  expect(bad.status()).toBe(400);
  const callback = () =>
    resident.request.post(`${origin}/api/v1/paynow/result`, { form: fields });
  expect((await callback()).status()).toBe(200);
  expect((await callback()).status()).toBe(200);
  expect(await db.receipt.count({ where: { paymentId: p.id } })).toBe(0);
  await expect
    .poll(
      async () =>
        await db.outboxEvent.count({
          where: {
            type: "paynow.reconcile",
            state: "PENDING",
            lastError: { not: null },
            payload: { path: ["paymentId"], equals: p.id },
          },
        }),
      { timeout: 25000 },
    )
    .toBe(1);
  await resident.request.post("http://127.0.0.1:3410/control", {
    data: { reference: p.reference, outage: "false" },
  });
  await api(finance, "payment.reconcile", { id: p.id });
  await api(finance, "payment.reconcile", { id: p.id });
  expect(await db.receipt.count({ where: { paymentId: p.id } })).toBe(1);
  expect(
    (await db.payment.findUniqueOrThrow({ where: { id: p.id } })).status,
  ).toBe("PAID");
  const refund = await resident.request.post("http://127.0.0.1:3410/control", {
    data: { reference: p.reference, status: "refunded" },
  });
  expect(
    (
      await resident.request.post(`${origin}/api/v1/paynow/result`, {
        form: await refund.json(),
      })
    ).status(),
  ).toBe(200);
  await api(finance, "payment.reconcile", { id: p.id });
  await api(finance, "payment.reconcile", { id: p.id });
  expect(
    (await db.payment.findUniqueOrThrow({ where: { id: p.id } })).status,
  ).toBe("REFUNDED");
  expect(await db.refund.count({ where: { paymentId: p.id } })).toBe(1);
  const second = await api(resident, "payment", {
    propertyId: f.property.id,
    userId: f.people.RESIDENT.id,
    method: "PAYNOW",
    amount: "20.00",
    idempotencyKey: `failed-${f.run}`,
  });
  expect(second.redirect).toContain("paynow.co.zw");
  const p2 = await db.payment.findUniqueOrThrow({
    where: { idempotencyKey: `failed-${f.run}` },
  });
  await resident.request.post("http://127.0.0.1:3410/control", {
    data: { reference: p2.reference, status: "failed" },
  });
  await api(finance, "payment.reconcile", { id: p2.id });
  expect(
    (await db.payment.findUniqueOrThrow({ where: { id: p2.id } })).status,
  ).toBe("FAILED");
  await resident.close();
  await finance.close();
});

test("F03 identity delivery, verification, recovery, MFA, cookies, sessions and self export through actual routes", async ({
  browser,
}) => {
  const f = await fullFixture(),
    context = await browser.newContext({
      baseURL: origin,
      ignoreHTTPSErrors: true,
    }),
    page = await context.newPage(),
    email = `registered-${f.run}@example.invalid`,
    phone = `+26377${Date.now().toString().slice(-7)}`;
  await page.goto("/auth");
  await page.getByRole("button", { name: "Register", exact: true }).click();
  await page.getByLabel("Full name").fill("Synthetic registered student");
  await page.getByLabel("Mobile number").fill(phone);
  await page.getByLabel("Resident type").selectOption("STUDENT");
  await page.getByLabel("Institution").fill("Synthetic institution");
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(f.password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("status")).toContainText("Account created");
  async function code(channel: string, recipient: string, previous = "") {
    let value = "";
    await expect
      .poll(
        async () => {
          const messages = await (
            await context.request.get("http://127.0.0.1:3410/messages")
          ).json();
          value =
            messages
              .filter(
                (m: { channel: string; recipient: string; text: string }) =>
                  m.channel === channel &&
                  m.recipient === recipient &&
                  m.text.startsWith(
                    channel === "email"
                      ? "Enter this single-use code"
                      : "Legacy Heights verification",
                  ),
              )
              .at(-1)
              ?.text?.split(": ")
              .at(-1) || "";
          return value !== previous ? value : "";
        },
        { timeout: 40000 },
      )
      .not.toBe("");
    return value;
  }
  let emailCode = "";
  for (const [channel, recipient] of [
    ["email", email],
    ["sms", phone.slice(1)],
  ]) {
    const token = await code(channel, recipient);
    if (channel === "email") emailCode = token;
    await page.getByRole("button", { name: "Verify", exact: true }).click();
    await page
      .getByLabel("Single-use verification or recovery code")
      .fill(token);
    await page.getByRole("button", { name: "Verify code" }).click();
    await expect(page.getByRole("status")).toContainText(
      "Verification complete",
    );
  }
  await page.getByRole("button", { name: "MFA", exact: true }).click();
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(f.password);
  await page.getByRole("button", { name: "Set up authenticator" }).click();
  const secret = await page.locator("code.secret").textContent();
  expect(secret).toBeTruthy();
  await page.getByLabel("Authenticator code").fill(totp(secret!).generate());
  await page.getByRole("button", { name: "Confirm authenticator" }).click();
  await expect(page.getByRole("status")).toContainText(
    "Authenticator confirmed",
  );
  await page
    .getByRole("button", { name: "Sign in", exact: true })
    .first()
    .click();
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(f.password);
  await page.getByLabel("Authenticator code").fill(totp(secret!).generate());
  await page
    .getByRole("button", { name: /Sign in/ })
    .last()
    .click();
  await expect(page).toHaveURL(/\/portal/);
  const cookies = await context.cookies();
  const session = cookies.find((c) => c.name === "legacy_session")!;
  expect(session.httpOnly).toBe(true);
  expect(session.secure).toBe(true);
  expect(session.sameSite).toBe("Strict");
  const exported = await (
    await context.request.get("/api/v1/me-export")
  ).json();
  expect(exported.user.email).toBe(email);
  expect(JSON.stringify(exported)).not.toMatch(
    /passwordHash|mfaSecret|tokenHash/,
  );
  await context.request.post("/api/auth", {
    headers: { Origin: origin },
    data: { action: "forgot", email },
  });
  const recovery = await code("email", email, emailCode);
  const reset = await context.request.post("/api/auth", {
    headers: { Origin: origin },
    data: {
      action: "verify",
      token: recovery,
      password: "New synthetic recovered password 2026!",
    },
  });
  expect(reset.status()).toBe(200);
  expect((await context.request.get("/api/v1/me-export")).status()).toBe(401);
  expect(
    (
      await context.request.post("/api/auth", {
        headers: { Origin: origin },
        data: { action: "verify", token: recovery, password: f.password },
      })
    ).status(),
  ).toBe(400);
  await context.close();
});

test("F04 administration, inventory/categories, rates, publication, templates, grants, scoped keys and exchange", async ({
  browser,
}) => {
  const f = await fullFixture();
  await db.membership.createMany({
    data: (await db.property.findMany({ select: { id: true } })).map((p) => ({
      userId: f.people.ADMIN.id,
      propertyId: p.id,
      role: "ADMIN",
    })),
    skipDuplicates: true,
  });
  const admin = await actorContext(browser, f, "ADMIN"),
    p = await api(admin, "property.create", {
      name: `New workflow ${f.run.slice(0, 8)}`,
      slug: `new-${f.run}`,
      legalEntity: "SYNTHETIC TEST ENTITY",
      description: "SYNTHETIC inventory administration workflow test only",
      location: "Test location",
      currency: "USD",
      deposit: "0.00",
      holdMinutes: 30,
    });
  await api(
    admin,
    "property.publish",
    { propertyId: p.id, approved: "on" },
    "ADD_VERIFIED_INVENTORY_FIRST",
  );
  for (const category of ["SINGLE", "SHARED", "PREMIUM", "ACCESSIBLE"])
    await api(admin, "inventory.add", {
      propertyId: p.id,
      building: "Test block",
      floor: "Ground",
      level: 0,
      room: category,
      category,
      beds: category === "SHARED" ? 2 : 1,
      monthly: "100.00",
    });
  await api(admin, "property.publish", { propertyId: p.id, approved: "on" });
  const room = await db.room.findFirstOrThrow({
    where: {
      floor: { building: { propertyId: p.id } },
      category: "ACCESSIBLE",
    },
    include: { beds: true },
  });
  expect(room.accessible).toBe(true);
  await api(admin, "rateplan", {
    propertyId: p.id,
    roomId: room.id,
    title: "Synthetic dated rule",
    startAt: f.start.toISOString(),
    endAt: f.end.toISOString(),
    minNights: 1,
    priority: 10,
    amount: "45.00",
  });
  await api(admin, "bed.block", {
    id: room.beds[0].id,
    blocked: true,
    reason: "Synthetic inspection block",
  });
  await api(admin, "bed.block", {
    id: room.beds[0].id,
    blocked: false,
    reason: "Synthetic inspection complete",
  });
  const page = await admin.newPage();
  await page.goto(`/rooms?property=${p.id}`);
  for (const c of ["SINGLE", "SHARED", "PREMIUM", "ACCESSIBLE"])
    await expect(
      page.getByRole("heading", { name: `Room ${c}` }),
    ).toBeVisible();
  const template = await api(admin, "template", {
    propertyId: p.id,
    title: "Synthetic approved terms",
    body: "TEST ONLY. This approved synthetic template tests versioning and tenancy condition display. It must never be used for real legal agreements.",
    legalApproval: "on",
    signingDisclosure:
      "TEST ONLY. I intend to use authenticator verification and my typed name to sign this synthetic agreement.",
  });
  expect(template.version).toBe(1);
  await api(admin, "announcement", {
    propertyId: f.property.id,
    title: "Synthetic resident notice",
    body: "This is a synthetic property announcement for testing.",
  });
  for (const provider of ["ACCOUNTING_CSV", "PMS_CSV", "SIS_CSV"]) {
    const result = await api(admin, "connector.test", {
      propertyId: f.property.id,
      provider,
    });
    expect(result.status).toBe("LOCAL_VALIDATED");
    expect(
      (
        await admin.request.get(
          `/api/v1/exchange?propertyId=${f.property.id}&provider=${provider}`,
        )
      ).status(),
    ).toBe(200);
  }
  const issued = await admin.request.post("/api/keys", {
    headers: { Origin: origin },
    data: {
      propertyId: f.property.id,
      name: "Synthetic delegated reader",
      scopes: ["inventory"],
    },
  });
  expect(issued.status()).toBe(200);
  const key = await issued.json();
  const anonymous = await browser.newContext({
    baseURL: origin,
    ignoreHTTPSErrors: true,
  });
  expect(
    (
      await anonymous.request.get(
        `/api/v1/inventory?propertyId=${f.property.id}`,
        { headers: { Authorization: `Bearer ${key.token}` } },
      )
    ).status(),
  ).toBe(200);
  expect(
    (
      await anonymous.request.get(
        `/api/v1/payments?propertyId=${f.property.id}`,
        { headers: { Authorization: `Bearer ${key.token}` } },
      )
    ).status(),
  ).toBe(403);
  await api(admin, "api_key.revoke", { id: key.id });
  expect(
    (
      await anonymous.request.get(
        `/api/v1/inventory?propertyId=${f.property.id}`,
        { headers: { Authorization: `Bearer ${key.token}` } },
      )
    ).status(),
  ).toBe(401);
  await api(
    admin,
    "membership",
    { propertyId: f.property.id, userId: f.people.OTHER.id, role: "FINANCE" },
    "STAFF_MUST_ENROLL_MFA_FIRST",
  );
  const enroll = await anonymous.request.post("/api/auth", {
      headers: { Origin: origin },
      data: {
        action: "enroll",
        email: f.people.OTHER.email,
        password: f.password,
      },
    }),
    secret = (await enroll.json()).secret;
  expect(
    (
      await anonymous.request.post("/api/auth", {
        headers: { Origin: origin },
        data: {
          action: "confirm",
          email: f.people.OTHER.email,
          password: f.password,
          code: totp(secret).generate(),
        },
      })
    ).status(),
  ).toBe(200);
  f.people.OTHER.secret = secret;
  const membership = await api(admin, "membership", {
      propertyId: f.property.id,
      userId: f.people.OTHER.id,
      role: "FINANCE",
    }),
    delegate = await actorContext(browser, f, "OTHER");
  expect(
    (
      await delegate.request.get(`/api/v1/invoices?propertyId=${f.property.id}`)
    ).status(),
  ).toBe(200);
  await api(admin, "membership.revoke", { id: membership.id });
  expect(
    (
      await delegate.request.get(`/api/v1/invoices?propertyId=${f.property.id}`)
    ).status(),
  ).toBe(401);
  await anonymous.close();
  await delegate.close();
  await admin.close();
});

test("F05 occupied-room waitlist priority, worker expiry, consented offer, decline, reselection and withdrawal", async ({
  browser,
}) => {
  const f = await fullFixture(),
    resident = await actorContext(browser, f, "RESIDENT"),
    other = await actorContext(browser, f, "OTHER"),
    admin = await actorContext(browser, f, "ADMIN"),
    page = await resident.newPage(),
    app = await reserveViaUi(page, f);
  for (const bed of f.room.beds.slice(1))
    await api(admin, "bed.block", {
      id: bed.id,
      blocked: true,
      reason: "Close extra spaces for synthetic full-room test",
    });
  await api(
    admin,
    "bed.block",
    {
      id: f.room.beds[0].id,
      blocked: true,
      reason: "Must not block live commitments",
    },
    "BED_HAS_ACTIVE_COMMITMENTS",
  );
  const w = await api(other, "waitlist", {
    propertyId: f.property.id,
    startAt: f.start.toISOString(),
    endAt: f.end.toISOString(),
  });
  await api(admin, "waitlist.priority", {
    id: w.id,
    priority: 7,
    reason: "Synthetic approved priority policy",
  });
  const held = await db.reservation.findFirstOrThrow({
    where: { applicationId: app.id },
  });
  await db.reservation.update({
    where: { id: held.id },
    data: { expiresAt: new Date(0) },
  });
  await expect
    .poll(
      async () =>
        (await db.waitlist.findUniqueOrThrow({ where: { id: w.id } })).state,
      { timeout: 30000 },
    )
    .toBe("OFFERED");
  const op = await other.newPage();
  await op.goto("/portal");
  await submit(op, "waitlist.accept", { consent: true }, w.id);
  const otherApp = await db.application.findFirstOrThrow({
    where: { propertyId: f.property.id, userId: f.people.OTHER.id },
  });
  await api(admin, "application.review", {
    id: otherApp.id,
    decision: "DECLINED",
    reason: "Synthetic applicant declines offered conditions",
  });
  await api(resident, "reselect", { id: app.id, bedId: f.room.beds[0].id });
  await page.goto("/portal");
  await page.getByText("Withdraw application", { exact: true }).click();
  await submit(
    page,
    "application.withdraw",
    { reason: "Synthetic resident withdraws before tenancy" },
    app.id,
  );
  expect(
    (await db.application.findUniqueOrThrow({ where: { id: app.id } })).status,
  ).toBe("WITHDRAWN");
  expect(
    await db.reservation.count({
      where: { applicationId: app.id, state: { in: ["HOLD", "CONFIRMED"] } },
    }),
  ).toBe(0);
  await resident.close();
  await other.close();
  await admin.close();
});

test("F06 privacy/profile/preferences, institution consent and client-admin review preserve retention boundaries", async ({
  browser,
}) => {
  const f = await fullFixture(),
    resident = await actorContext(browser, f, "RESIDENT"),
    admin = await actorContext(browser, f, "ADMIN"),
    page = await resident.newPage();
  await reserveViaUi(page, f);
  await page.goto("/portal#profile");
  await submit(page, "profile", {
    emergencyName: "Synthetic updated emergency",
    emergencyPhone: "+263770000011",
  });
  await submit(page, "preferences", { email: true, sms: true });
  await api(resident, "consent.sis");
  await api(resident, "privacy.request", {
    type: "ERASURE",
    reason: "Synthetic erasure request subject to lawful retention",
  });
  const request = await db.privacyRequest.findFirstOrThrow({
    where: { userId: f.people.RESIDENT.id, type: "ERASURE" },
  });
  await api(
    admin,
    "privacy.review",
    {
      id: request.id,
      state: "ON_HOLD",
      reason: "Partial admin must not review client-wide data",
    },
    "ORGANISATION_ADMIN_REQUIRED",
  );
  await db.membership.createMany({
    data: (await db.property.findMany({ select: { id: true } })).map((p) => ({
      userId: f.people.ADMIN.id,
      propertyId: p.id,
      role: "ADMIN",
    })),
    skipDuplicates: true,
  });
  await api(admin, "privacy.review", {
    id: request.id,
    state: "IN_REVIEW",
    reason: "Synthetic privacy officer reviewing approved policy",
  });
  await api(admin, "privacy.review", {
    id: request.id,
    state: "ON_HOLD",
    reason: "Synthetic legal retention requirement needs client review",
  });
  expect(
    (await db.privacyRequest.findUniqueOrThrow({ where: { id: request.id } }))
      .state,
  ).toBe("ON_HOLD");
  expect(await db.user.count({ where: { id: f.people.RESIDENT.id } })).toBe(1);
  await api(
    admin,
    "privacy.review",
    {
      id: request.id,
      state: "FULFILLED",
      reason: "Must not claim erased records",
    },
    "COMMAND_REJECTED",
  );
  const exported = await resident.request.get("/api/v1/me-export");
  expect(exported.status()).toBe(200);
  expect((await exported.json()).user.emergencyName).toBe(
    "Synthetic updated emergency",
  );
  await api(resident, "sessions.revoke");
  expect((await resident.request.get("/api/v1/me-export")).status()).toBe(401);
  await resident.close();
  await admin.close();
});

test("F07 every staff role and API collection enforces its independent property capability", async ({
  browser,
}) => {
  const f = await fullFixture(),
    foreign = await fullFixture();
  const expected: Record<string, string[]> = {
    ADMIN: [
      "inventory",
      "applications",
      "leases",
      "invoices",
      "payments",
      "tickets",
      "analytics",
      "integrations",
    ],
    ADMISSIONS: ["applications", "leases", "tickets"],
    FINANCE: ["invoices", "payments"],
    PROPERTY_MANAGER: ["inventory", "leases", "tickets", "analytics"],
    CARETAKER: ["tickets"],
    KYC: [],
    MEDICAL_REVIEWER: [],
    AUDITOR: ["invoices", "payments", "analytics"],
    MAINTENANCE_OFFICER: ["tickets"],
    LEASING_OFFICER: ["leases"],
    FINANCE_APPROVER: ["invoices", "payments"],
    PLATFORM_OPERATOR: [],
    RESIDENT: [],
    OTHER: [],
  };
  for (const [role, allowed] of Object.entries(expected)) {
    const context = await actorContext(browser, f, role);
    for (const resource of expected.ADMIN) {
      expect(
        (
          await context.request.get(
            `/api/v1/${resource}?propertyId=${f.property.id}`,
          )
        ).status(),
        `${role} ${resource}`,
      ).toBe(allowed.includes(resource) ? 200 : 403);
      expect(
        (
          await context.request.get(
            `/api/v1/${resource}?propertyId=${foreign.property.id}`,
          )
        ).status(),
        `${role} crossing ${resource}`,
      ).toBe(403);
    }
    await context.close();
  }
  const anon = await browser.newContext({
    baseURL: origin,
    ignoreHTTPSErrors: true,
  });
  expect((await anon.request.get("/api/v1/openapi")).status()).toBe(200);
  expect(
    (
      await anon.request.get(`/api/v1/invoices?propertyId=${f.property.id}`)
    ).status(),
  ).toBe(401);
  await anon.close();
});

test("F08 renewal and transfer preserve the executed source, require independent review and issue new agreements", async ({
  browser,
}) => {
  const f = await fullFixture(),
    resident = await actorContext(browser, f, "RESIDENT"),
    admin = await actorContext(browser, f, "ADMIN"),
    admissions = await actorContext(browser, f, "ADMISSIONS");
  // A known pre-existing tenancy is fixture data; every change below uses the real HTTP command boundary.
  await db.room.update({
    where: { id: f.room.id },
    data: { monthlyMinor: 0n },
  });
  const application = await db.application.create({
    data: {
      userId: f.people.RESIDENT.id,
      propertyId: f.property.id,
      status: "ACTIVE",
    },
  });
  const reservation = await db.reservation.create({
    data: {
      userId: f.people.RESIDENT.id,
      propertyId: f.property.id,
      applicationId: application.id,
      bedId: f.room.beds[0].id,
      state: "ACTIVE",
      startAt: f.start,
      endAt: f.end,
    },
  });
  const template = await api(admin, "template", {
    propertyId: f.property.id,
    title: "Synthetic tenancy change terms",
    body: "TEST ONLY. Synthetic terms to verify renewal and transfer, independent review, a fresh agreement and preservation of the executed source. Not an operative agreement.",
    legalApproval: "on",
  });
  const snapshot = JSON.stringify({
    terms: template.body,
    resident: f.people.RESIDENT.name,
    property: f.property.name,
    startAt: f.start.toISOString(),
    endAt: f.end.toISOString(),
    version: 1,
  });
  const original = await db.lease.create({
    data: {
      userId: f.people.RESIDENT.id,
      propertyId: f.property.id,
      applicationId: application.id,
      reservationId: reservation.id,
      templateId: template.id,
      status: "EXECUTED",
      documentSnapshot: snapshot,
      documentHash: hash(snapshot),
      executedAt: new Date(),
    },
  });
  const renewalInput = {
    leaseId: original.id,
    type: "RENEWAL",
    targetBedId: f.room.beds[0].id,
    startAt: f.end.toISOString(),
    endAt: new Date(f.end.getTime() + 30 * 86400000).toISOString(),
    reason: "Synthetic resident requests another month",
  };
  const declined = await api(resident, "tenancy.request", renewalInput);
  await api(admissions, "tenancy.review", {
    id: declined.id,
    decision: "DECLINED",
    reason: "Synthetic requested dates need revision",
  });
  expect(
    (await db.tenancyRequest.findUniqueOrThrow({ where: { id: declined.id } }))
      .state,
  ).toBe("DECLINED");
  const renewal = await api(resident, "tenancy.request", renewalInput);
  await api(
    resident,
    "tenancy.review",
    {
      id: renewal.id,
      decision: "APPROVED",
      reason: "Resident may not approve their own request",
    },
    "FORBIDDEN",
  );
  const renewed = await api(admissions, "tenancy.review", {
    id: renewal.id,
    decision: "APPROVED",
    reason: "Synthetic account clear and future space checked",
  });
  const newLease = await api(admissions, "lease.issue", {
    applicationId: renewed.id,
    templateId: template.id,
  });
  const bytes = await testPdf("SYNTHETIC RENEWAL SIGNED COPY");
  const uploaded = await resident.request.post("/api/actions", {
    headers: { Origin: origin },
    multipart: {
      action: "upload",
      next: "/portal",
      propertyId: f.property.id,
      applicationId: renewed.id,
      kind: "SIGNED_LEASE",
      file: { name: "renewal.pdf", mimeType: "application/pdf", buffer: bytes },
    },
  });
  expect(uploaded.url()).not.toContain("error=");
  const doc = await db.document.findFirstOrThrow({
    where: { applicationId: renewed.id, kind: "SIGNED_LEASE" },
  });
  await expect
    .poll(
      async () =>
        (await db.document.findUniqueOrThrow({ where: { id: doc.id } })).state,
      { timeout: 30000 },
    )
    .toBe("CLEAN");
  await api(resident, "lease.sign", {
    id: newLease.id,
    documentId: doc.id,
    consent: true,
  });
  await api(admissions, "lease.execute", {
    id: newLease.id,
    reason: "Synthetic renewal signature independently checked",
  });
  const transferDate = new Date(f.start.getTime() + 2 * 86400000);
  const transfer = await api(resident, "tenancy.request", {
    ...renewalInput,
    type: "TRANSFER",
    startAt: transferDate.toISOString(),
    endAt: f.end.toISOString(),
    targetBedId: f.room.beds[1].id,
    reason: "Synthetic resident requests another space",
  });
  const transferred = await api(admissions, "tenancy.review", {
    id: transfer.id,
    decision: "APPROVED",
    reason: "Synthetic transfer date and account checked",
  });
  const transferredLease = await api(admissions, "lease.issue", {
    applicationId: transferred.id,
    templateId: template.id,
  });
  expect(transferredLease.status).toBe("AWAITING_SIGNATURE");
  const after = await db.lease.findUniqueOrThrow({
    where: { id: original.id },
  });
  expect(after.documentHash).toBe(original.documentHash);
  expect(after.documentSnapshot).toBe(snapshot);
  expect(
    (await db.reservation.findUniqueOrThrow({ where: { id: reservation.id } }))
      .endAt,
  ).toEqual(transferDate);
  expect(
    (
      await resident.request.get(`/api/financial/lease/${newLease.id}`)
    ).status(),
  ).toBe(200);
  await resident.close();
  await admin.close();
  await admissions.close();
});

test("F09 hostile uploads, resubmission, file/invoice/statement ID substitution, CSRF, XSS and security triage", async ({
  browser,
}) => {
  const f = await fullFixture(),
    resident = await actorContext(browser, f, "RESIDENT"),
    other = await actorContext(browser, f, "OTHER"),
    kyc = await actorContext(browser, f, "KYC"),
    admin = await actorContext(browser, f, "ADMIN"),
    finance = await actorContext(browser, f, "FINANCE");
  const page = await resident.newPage(),
    a = await reserveViaUi(page, f);
  const upload = (buffer: Buffer, name = "synthetic.pdf", kind = "IDENTITY") =>
    resident.request.post("/api/actions", {
      headers: { Origin: origin },
      multipart: {
        action: "upload",
        next: "/portal",
        propertyId: f.property.id,
        applicationId: a.id,
        kind,
        file: { name, mimeType: "application/pdf", buffer },
      },
      maxRedirects: 0,
    });
  for (const [bytes, message] of [
    [Buffer.from("<script>alert(1)</script>"), "ONLY_PDF_PNG_JPEG"],
    [Buffer.alloc(10 * 1024 * 1024 + 1, 1), "FILE_SIZE_LIMIT_10MB"],
  ] as const) {
    const response = await upload(bytes);
    expect(response.status()).toBe(303);
    expect(response.headers().location).toContain(message);
  }
  const malformed = await upload(
    Buffer.from("%PDF-1.7\nThis is not a valid PDF document."),
  );
  expect(malformed.headers().location).not.toContain("error=");
  const rejected = await db.document.findFirstOrThrow({
    where: { applicationId: a.id },
    orderBy: { createdAt: "desc" },
  });
  expect(
    (await resident.request.get(`/api/documents/${rejected.id}`)).status(),
  ).toBe(403);
  await expect
    .poll(
      async () =>
        (await db.document.findUniqueOrThrow({ where: { id: rejected.id } }))
          .state,
      { timeout: 30000 },
    )
    .toBe("REJECTED");
  const clean = await uploadViaUi(page, f.property.id, "IDENTITY");
  expect(clean.version).toBe(2);
  await api(kyc, "document.review", {
    id: clean.id,
    decision: "REJECTED",
    reason: "Synthetic evidence needs a clearer copy",
  });
  const replacement = await uploadViaUi(page, f.property.id, "IDENTITY");
  expect(replacement.version).toBe(3);
  await api(kyc, "document.review", {
    id: replacement.id,
    decision: "APPROVED",
    reason: "Synthetic replacement independently checked",
  });
  expect(
    (await other.request.get(`/api/documents/${replacement.id}`)).status(),
  ).toBe(403);
  expect(
    (await resident.request.get(`/api/documents/${replacement.id}`)).headers()[
      "cache-control"
    ],
  ).toContain("no-store");
  await db.document.update({
    where: { id: clean.id },
    data: {
      state: "SCAN_FAILED",
      scanResult: "SYNTHETIC_TRANSIENT_FAILURE",
      scanAttempts: 5,
    },
  });
  await api(kyc, "document.retry", {
    id: clean.id,
    reason: "Synthetic scanner failure resolved",
  });
  await expect
    .poll(
      async () =>
        (await db.document.findUniqueOrThrow({ where: { id: clean.id } }))
          .state,
      { timeout: 30000 },
    )
    .toBe("CLEAN");
  const invoice = await api(finance, "charge", {
    propertyId: f.property.id,
    userId: f.people.RESIDENT.id,
    category: "OTHER",
    reference: `IDOR-${f.run}`,
    description: "Synthetic boundary invoice",
    amount: "4.00",
    dueAt: f.start.toISOString(),
  });
  for (const path of [
    `/api/financial/invoice/${invoice.id}`,
    `/api/financial/statement/${f.property.id}?userId=${f.people.RESIDENT.id}`,
  ])
    expect((await other.request.get(path)).status()).toBe(403);
  const csrf = await resident.request.post("/api/v1/commands", {
    headers: { Origin: "https://attacker.invalid" },
    data: { action: "preferences", email: "on", sms: "on" },
  });
  expect(csrf.status()).toBe(400);
  expect((await csrf.json()).error).toBe("CSRF_ORIGIN_REJECTED");
  const redirect = await resident.request.post("/api/actions", {
    headers: { Origin: origin },
    form: { action: "preferences", next: "//attacker.invalid", email: "on" },
    maxRedirects: 0,
  });
  expect(new URL(redirect.headers().location).origin).toBe(origin);
  expect(new URL(redirect.headers().location).pathname).toBe("/portal");
  const payload =
    '<img src=x onerror="window.syntheticXss=true"><script>window.syntheticXss=true</script>';
  await api(resident, "ticket", {
    propertyId: f.property.id,
    type: "SUPPORT",
    category: "Synthetic XSS",
    priority: "NORMAL",
    subject: `Hostile text ${f.run}`,
    body: payload,
  });
  await page.goto("/portal");
  await expect(page.getByText(payload, { exact: true })).toBeVisible();
  expect(
    await page.evaluate(
      () => (window as unknown as { syntheticXss?: boolean }).syntheticXss,
    ),
  ).toBeUndefined();
  const response = await page.goto("/rooms");
  expect(response!.headers()["content-security-policy"]).toMatch(/nonce-[^']+/);
  expect(response!.headers()["strict-transport-security"]).toContain(
    "max-age=",
  );
  expect(response!.headers()["x-content-type-options"]).toBe("nosniff");
  const alert = await db.securityAlert.create({
    data: {
      dedupeKey: `synthetic-${f.run}`,
      propertyId: f.property.id,
      kind: "SYNTHETIC_REVIEW",
      severity: "HIGH",
      subjectHash: hash(f.run),
    },
  });
  await api(admin, "security.review", {
    id: alert.id,
    state: "ACKNOWLEDGED",
    reason: "Synthetic security alert triaged",
  });
  await api(admin, "security.review", {
    id: alert.id,
    state: "RESOLVED",
    reason: "Synthetic alert investigation complete",
  });
  expect(
    (await db.securityAlert.findUniqueOrThrow({ where: { id: alert.id } }))
      .state,
  ).toBe("RESOLVED");
  const job = await db.outboxEvent.create({
    data: {
      propertyId: f.property.id,
      userId: f.people.RESIDENT.id,
      type: "synthetic.retry",
      payload: {},
      traceId: randomUUID(),
      state: "DEAD",
      attempts: 5,
    },
  });
  await api(admin, "job.retry", { id: job.id });
  await expect
    .poll(
      async () =>
        (await db.outboxEvent.findUniqueOrThrow({ where: { id: job.id } }))
          .state,
      { timeout: 30000 },
    )
    .toBe("DELIVERED");
  for (const c of [resident, other, kyc, admin, finance]) await c.close();
});
