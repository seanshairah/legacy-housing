import { afterEach, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { db } from "../src/lib/db";
import { fullFixture } from "./browser/support";
import { workOnce } from "../src/domain/worker";
import {
  assertNotificationVersion,
  identityNotification,
  notificationTemplate,
} from "../src/domain/notification-templates";
import { operationalErrorCode, operationalLog } from "../src/lib/logger";

process.env.DATA_KEY ||= randomBytes(32).toString("hex");
process.env.FILE_KEY ||= randomBytes(32).toString("hex");
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("versioned messages describe real next actions without interpolating event payloads", () => {
  const expected = [
    ["application.approved", /deposit and agreement/],
    ["payment.initiated", /pending verification/],
    ["payment.settled", /independently verified/],
    ["lease.signed_electronically", /Independent agreement execution/],
    ["service_request.updated", /confirm resolution or reopen/],
    ["announcement.available", /complete notice/],
  ] as const;
  for (const [type, instruction] of expected) {
    const template = notificationTemplate(
      type,
      1,
      "https://example.invalid/base?ignored=1",
    );
    expect(template.id).toBe(type);
    expect(template.version).toBe(1);
    expect(template.email).toMatch(instruction);
    expect(template.email).toContain("https://example.invalid/portal");
    expect(template.email).not.toContain("ignored=1");
    expect(template.sms).toContain("Sign in");
  }
  expect(() => assertNotificationVersion(2)).toThrow(
    "UNSUPPORTED_NOTIFICATION_TEMPLATE_VERSION",
  );
  expect(() =>
    notificationTemplate("payment.settled", 0, "https://example.invalid"),
  ).toThrow("UNSUPPORTED_NOTIFICATION_TEMPLATE_VERSION");
});

it("unknown and inherited event names use a safe generic template", () => {
  for (const type of [
    "unrecognised.event",
    "constructor",
    "toString",
    "__proto__",
    '<script>alert("x")</script>',
  ]) {
    const template = notificationTemplate(type, 1, "https://example.invalid");
    expect(template.id).toBe("accommodation.update");
    expect(template.subject).toBe("Legacy Heights: Accommodation update");
    expect(template.email).not.toContain(type);
  }
});

it("notification destinations require HTTPS except explicit local development and reject embedded credentials", () => {
  for (const url of [
    "http://example.invalid",
    "javascript:alert(1)",
    "file:///etc/passwd",
    "https://username:secret@example.invalid",
    "ftp://example.invalid",
  ]) {
    expect(() => notificationTemplate("application.submitted", 1, url)).toThrow(
      "APP_URL_REQUIRES_HTTPS",
    );
  }
  for (const url of [
    "http://localhost:3001",
    "http://127.0.0.1:3001",
    "https://example.invalid",
  ]) {
    expect(
      notificationTemplate("application.submitted", 1, url).email,
    ).toContain("/portal");
  }
});

it("identity templates preserve one-use delivery contracts and reject malformed or misrouted codes", () => {
  const code = "synthetic-one-use-code-123456";
  const email = identityNotification("identity.email", 1, code),
    sms = identityNotification("identity.phone", 1, code);
  expect(email.email).toBe(
    `Enter this single-use code on the verification page: ${code}`,
  );
  expect(sms.sms).toBe(`Legacy Heights verification: ${code}`);
  expect(identityNotification("identity.reset", 1, code).subject).toContain(
    "account recovery",
  );
  for (const invalid of [
    "short",
    "<script>bad</script>",
    "code\ninjection",
    "a".repeat(101),
  ])
    expect(() => identityNotification("identity.email", 1, invalid)).toThrow(
      "INVALID_IDENTITY_NOTIFICATION",
    );
  expect(() => identityNotification("payment.settled", 1, code)).toThrow(
    "INVALID_IDENTITY_NOTIFICATION",
  );
  expect(() => identityNotification("identity.email", 2, code)).toThrow(
    "UNSUPPORTED_NOTIFICATION_TEMPLATE_VERSION",
  );
});

it("operational logs allow only structured safe fields and never include raw provider errors or unrecognised values", () => {
  vi.stubEnv("LEGACY_LOG_TESTS", "true");
  const output = vi.spyOn(console, "error").mockImplementation(() => {});
  const secret = "synthetic-secret token=private@example.invalid";
  expect(operationalErrorCode(new Error(secret))).toBe("DELIVERY_FAILED");
  expect(operationalErrorCode(new Error("SMS_DELIVERY_FAILED"))).toBe(
    "SMS_DELIVERY_FAILED",
  );
  expect(
    operationalErrorCode(new Error("PROVIDER_CONFIRMATION_MISMATCH")),
  ).toBe("PROVIDER_CONFIRMATION_MISMATCH");
  expect(operationalErrorCode(new Error("PAYNOW_READY_FOR_CREDENTIALS"))).toBe(
    "PAYNOW_READY_FOR_CREDENTIALS",
  );
  expect(
    operationalErrorCode(
      Object.assign(new Error(secret), { name: "TimeoutError" }),
    ),
  ).toBe("PROVIDER_TIMEOUT");
  expect(operationalErrorCode(null, secret)).toBe("OPERATION_FAILED");
  expect(operationalErrorCode(null, "UPPERCASE_SECRET_VALUE")).toBe(
    "OPERATION_FAILED",
  );
  const record = operationalLog(
    "worker.outbox_failed",
    {
      jobId: "job_synthetic",
      type: "payment.settled",
      propertyId: "property_synthetic",
      attempt: 2,
      outcome: "retry",
      errorCode: operationalErrorCode(new Error(secret)),
      durationMs: 15,
      ...({ payload: secret, email: secret, password: secret } as Record<
        string,
        string
      >),
    },
    "error",
  );
  expect(record).toMatchObject({
    event: "worker.outbox_failed",
    jobId: "job_synthetic",
    attempt: 2,
    outcome: "retry",
    errorCode: "DELIVERY_FAILED",
  });
  expect(JSON.stringify(record)).not.toContain(secret);
  expect(output).toHaveBeenCalledOnce();
  expect(JSON.parse(output.mock.calls[0][0])).toEqual(record);
  const rejected = operationalLog(
    "event\nsecret",
    {
      jobId: secret,
      type: "bad event",
      propertyId: secret,
      traceId: secret,
      attempt: Number.NaN,
      durationMs: -1,
      errorCode: secret,
      outcome: secret as "retry",
    },
    secret as "error",
  );
  expect(rejected.event).toBe("operation.unknown");
  expect(rejected.level).toBe("info");
  expect(JSON.stringify(rejected)).not.toContain(secret);
  expect(rejected).not.toHaveProperty("outcome");
  expect(rejected).not.toHaveProperty("jobId");
  expect(
    operationalLog("worker.failure", { errorCode: "UPPERCASE_SECRET_VALUE" }),
  ).not.toHaveProperty("errorCode");
});

it("announcement fanout traverses more than 100 recipients, stays in its property and deduplicates retries", async () => {
  const f = await fullFixture(),
    foreign = await fullFixture(),
    run = randomUUID(),
    stamp = Date.now().toString().slice(-7);
  const recipients = Array.from({ length: 105 }, (_, n) => ({
    id: randomUUID(),
    email: `notice-${run}-${n}@example.invalid`,
    phone: `+2637${stamp}${String(n).padStart(3, "0")}`,
    name: `Synthetic notice recipient ${n}`,
    passwordHash: "unused",
    active: true,
  }));
  await db.user.createMany({ data: recipients });
  await db.application.createMany({
    data: recipients.map((u) => ({
      userId: u.id,
      propertyId: f.property.id,
      status: "SUBMITTED",
    })),
  });
  await db.membership.create({
    data: {
      userId: recipients[0].id,
      propertyId: f.property.id,
      role: "CARETAKER",
    },
  });
  const excluded: string[] = [];
  for (const [n, status] of [
    "DECLINED",
    "WITHDRAWN",
    "ENDED",
    "SUBMITTED",
  ].entries()) {
    const user = await db.user.create({
      data: {
        email: `excluded-${run}-${n}@example.invalid`,
        phone: `+2638${stamp}${String(n).padStart(3, "0")}`,
        name: "Synthetic excluded recipient",
        passwordHash: "unused",
        active: n !== 3,
      },
    });
    await db.application.create({
      data: { userId: user.id, propertyId: f.property.id, status },
    });
    excluded.push(user.id);
  }
  const expectedIds = [
    ...recipients.map((u) => u.id),
    ...Object.entries(f.people)
      .filter(([role]) => !["RESIDENT", "OTHER"].includes(role))
      .map(([, u]) => u.id),
  ].sort();
  await db.notificationPreference.createMany({
    data: expectedIds.map((userId) => ({ userId, email: false, sms: false })),
    skipDuplicates: true,
  });
  const announcement = await db.announcement.create({
    data: {
      propertyId: f.property.id,
      title: "Synthetic announcement",
      body: "PRIVATE BODY MUST NOT APPEAR IN OUTBOUND TRANSPORT",
    },
  });
  const job = await db.outboxEvent.create({
    data: {
      propertyId: f.property.id,
      type: "announcement.published",
      payload: { objectId: announcement.id },
      traceId: randomUUID(),
      createdAt: new Date(0),
    },
  });
  const fetch = vi.fn(async (_url: string | URL, _init?: RequestInit) => {
    throw new Error(
      "No provider transport should run for opted-out recipients",
    );
  });
  vi.stubGlobal("fetch", fetch);
  await workOnce();
  expect(
    (await db.outboxEvent.findUniqueOrThrow({ where: { id: job.id } })).state,
  ).toBe("DELIVERED");
  const children = await db.outboxEvent.findMany({
    where: { propertyId: f.property.id, type: "announcement.available" },
  });
  expect(children.map((e) => e.userId).sort()).toEqual(expectedIds);
  expect(new Set(children.map((e) => e.id)).size).toBe(expectedIds.length);
  expect(children.some((e) => excluded.includes(e.userId!))).toBe(false);
  expect(
    children.some((e) =>
      Object.values(foreign.people).some((u) => u.id === e.userId),
    ),
  ).toBe(false);
  expect(JSON.stringify(children)).not.toContain(announcement.body);
  expect(
    await db.notification.count({
      where: { id: { in: children.map((e) => e.id) } },
    }),
  ).toBe(expectedIds.length);
  await db.outboxEvent.update({
    where: { id: job.id },
    data: { state: "PENDING", availableAt: new Date(0) },
  });
  await workOnce();
  expect(
    await db.outboxEvent.count({
      where: { propertyId: f.property.id, type: "announcement.available" },
    }),
  ).toBe(expectedIds.length);
  expect(
    await db.notification.count({
      where: { id: { in: children.map((e) => e.id) } },
    }),
  ).toBe(expectedIds.length);
  const childIds = new Set(children.map((e) => e.id));
  expect(
    fetch.mock.calls.filter(([, init]) =>
      childIds.has(new Headers(init?.headers).get("idempotency-key") || ""),
    ),
  ).toHaveLength(0);
});

it("announcement scope substitution and unsupported persisted template versions fail closed before delivery", async () => {
  const f = await fullFixture(),
    foreign = await fullFixture();
  const announcement = await db.announcement.create({
    data: {
      propertyId: foreign.property.id,
      title: "Foreign notice",
      body: "Synthetic foreign body",
    },
  });
  const denied = await db.outboxEvent.create({
    data: {
      propertyId: f.property.id,
      type: "announcement.published",
      payload: { objectId: announcement.id },
      traceId: randomUUID(),
      createdAt: new Date(0),
    },
  });
  const unknown = await db.outboxEvent.create({
    data: {
      propertyId: f.property.id,
      userId: f.people.RESIDENT.id,
      type: "invoice.issued",
      version: 999,
      attempts: 4,
      payload: {},
      traceId: randomUUID(),
      createdAt: new Date(0),
    },
  });
  const fetch = vi.fn(
    async (_url: string | URL, _init?: RequestInit) =>
      new Response("{}", { status: 200 }),
  );
  vi.stubGlobal("fetch", fetch);
  await workOnce();
  expect(
    (await db.outboxEvent.findUniqueOrThrow({ where: { id: denied.id } }))
      .lastError,
  ).toBe("ANNOUNCEMENT_SCOPE_MISMATCH");
  const failed = await db.outboxEvent.findUniqueOrThrow({
    where: { id: unknown.id },
  });
  expect(failed.state).toBe("DEAD");
  expect(failed.lastError).toBe("UNSUPPORTED_NOTIFICATION_TEMPLATE_VERSION");
  expect(
    await db.outboxEvent.count({
      where: { propertyId: f.property.id, type: "announcement.available" },
    }),
  ).toBe(0);
  expect(
    fetch.mock.calls.filter(([, init]) =>
      [denied.id, unknown.id].includes(
        new Headers(init?.headers).get("idempotency-key") || "",
      ),
    ),
  ).toHaveLength(0);
});

it("partial email/SMS delivery retries with the same idempotency key and does not expose sensitive event payloads", async () => {
  const f = await fullFixture();
  vi.stubEnv("APP_URL", "https://example.invalid");
  vi.stubEnv("RESEND_API_KEY", "synthetic-key");
  vi.stubEnv("EMAIL_FROM", "test@example.invalid");
  vi.stubEnv("SMSPOP_API_KEY", "synthetic-key");
  vi.stubEnv("SMSPOP_SENDER_ID", "TEST");
  await db.notificationPreference.create({
    data: { userId: f.people.RESIDENT.id, email: true, sms: true },
  });
  const job = await db.outboxEvent.create({
    data: {
      propertyId: f.property.id,
      userId: f.people.RESIDENT.id,
      type: "payment.settled",
      payload: { rawSensitiveProof: "SYNTHETIC PRIVATE DOCUMENT CONTENT" },
      traceId: randomUUID(),
      createdAt: new Date(0),
    },
  });
  let outage = true;
  const calls: { url: string; id: string; body: string }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init: RequestInit) => {
      const target = String(url);
      expect([
        "https://api.resend.com/emails",
        "https://smspop.co.zw/api/campaigns",
      ]).toContain(target);
      const id = new Headers(init.headers).get("idempotency-key") || "";
      calls.push({ url: target, id, body: String(init.body) });
      return new Response("{}", {
        status: outage && target.includes("smspop") ? 503 : 200,
      });
    }),
  );
  await workOnce();
  const failed = await db.outboxEvent.findUniqueOrThrow({
    where: { id: job.id },
  });
  expect(failed.state).toBe("PENDING");
  expect(failed.attempts).toBe(1);
  expect(failed.lastError).toBe("SMS_DELIVERY_FAILED");
  expect(failed.availableAt.getTime()).toBeGreaterThan(Date.now());
  expect(calls.filter((c) => c.id === job.id)).toHaveLength(2);
  outage = false;
  await db.outboxEvent.update({
    where: { id: job.id },
    data: { availableAt: new Date(0) },
  });
  await workOnce();
  const delivered = await db.outboxEvent.findUniqueOrThrow({
    where: { id: job.id },
  });
  expect(delivered.state).toBe("DELIVERED");
  expect(delivered.attempts).toBe(2);
  expect(calls.filter((c) => c.id === job.id)).toHaveLength(4);
  expect(
    calls
      .filter((c) => c.id === job.id)
      .every((c) => !c.body.includes("SYNTHETIC PRIVATE DOCUMENT CONTENT")),
  ).toBe(true);
  await workOnce();
  expect(calls.filter((c) => c.id === job.id)).toHaveLength(4);
});
