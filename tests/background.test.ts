import { it, expect, afterEach, vi } from "vitest";
import { randomUUID, randomBytes } from "node:crypto";
import { db } from "../src/lib/db";
import { fullFixture } from "./browser/support";
import { workOnce } from "../src/domain/worker";
import { scheduledReminders } from "../src/domain/scheduler";
import { issueChallenge } from "../src/domain/identity";
import { command } from "../src/domain/commands";
import { propertyMetrics } from "../src/domain/operations";
import { encrypt, hash, assertSameOrigin, safeText } from "../src/lib/security";
process.env.DATA_KEY ||= randomBytes(32).toString("hex");
process.env.FILE_KEY ||= randomBytes(32).toString("hex");
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it("worker executes configured email/SMS contracts once, recovers abandoned claims and respects preferences", async () => {
  const f = await fullFixture(),
    calls: { url: string; id: string }[] = [];
  vi.stubEnv("RESEND_API_KEY", "unit-fixture-key");
  vi.stubEnv("EMAIL_FROM", "test@example.invalid");
  vi.stubEnv("SMSPOP_API_KEY", "unit-fixture-key");
  vi.stubEnv("SMSPOP_SENDER_ID", "TEST");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: URL | string, init: RequestInit) => {
      const target = String(url);
      if (
        ![
          "https://api.resend.com/emails",
          "https://smspop.co.zw/api/campaigns",
        ].includes(target)
      )
        return new Response("fixture rejects unknown provider", {
          status: 503,
        });
      calls.push({
        url: target,
        id: new Headers(init.headers).get("idempotency-key") || "",
      });
      return new Response('{"accepted":true}', { status: 200 });
    }),
  );
  await db.notificationPreference.create({
    data: { userId: f.people.RESIDENT.id, email: true, sms: true },
  });
  const job = await db.outboxEvent.create({
    data: {
      type: "service_request.updated",
      propertyId: f.property.id,
      userId: f.people.RESIDENT.id,
      payload: { objectId: "synthetic" },
      traceId: randomUUID(),
      state: "PROCESSING",
      lockedAt: new Date(0),
      createdAt: new Date(0),
    },
  });
  await workOnce();
  expect(
    (await db.outboxEvent.findUniqueOrThrow({ where: { id: job.id } })).state,
  ).toBe("DELIVERED");
  expect(calls.filter((c) => c.id === job.id)).toHaveLength(2);
  await workOnce();
  expect(calls.filter((c) => c.id === job.id)).toHaveLength(2);
  await db.notificationPreference.update({
    where: { userId: f.people.RESIDENT.id },
    data: { email: false, sms: false },
  });
  const noSend = await db.outboxEvent.create({
    data: {
      type: "application.approved",
      propertyId: f.property.id,
      userId: f.people.RESIDENT.id,
      payload: {},
      traceId: randomUUID(),
      createdAt: new Date(0),
    },
  });
  await workOnce();
  expect(
    (await db.outboxEvent.findUniqueOrThrow({ where: { id: noSend.id } }))
      .state,
  ).toBe("DELIVERED");
  expect(calls.filter((c) => c.id === noSend.id)).toHaveLength(0);
});

it("worker records provider outage/backoff, dead-letters repeated failure and supports authorized retry", async () => {
  const f = await fullFixture();
  vi.stubEnv("RESEND_API_KEY", "fixture");
  vi.stubEnv("EMAIL_FROM", "test@example.invalid");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("simulated outage", { status: 503 })),
  );
  const job = await db.outboxEvent.create({
    data: {
      type: "payment.confirmed",
      propertyId: f.property.id,
      userId: f.people.RESIDENT.id,
      payload: {},
      traceId: randomUUID(),
      createdAt: new Date(0),
    },
  });
  await workOnce();
  let current = await db.outboxEvent.findUniqueOrThrow({
    where: { id: job.id },
  });
  expect(current.state).toBe("PENDING");
  expect(current.attempts).toBe(1);
  expect(current.availableAt.getTime()).toBeGreaterThan(Date.now());
  await db.outboxEvent.update({
    where: { id: job.id },
    data: { attempts: 4, availableAt: new Date(0) },
  });
  await workOnce();
  current = await db.outboxEvent.findUniqueOrThrow({ where: { id: job.id } });
  expect(current.state).toBe("DEAD");
  expect(current.lastError).toContain("EMAIL_DELIVERY_FAILED");
  await expect(
    command(f.people.CARETAKER, "job.retry", { id: job.id }),
  ).rejects.toThrow("FORBIDDEN");
  await command(f.people.ADMIN, "job.retry", { id: job.id });
  expect(
    (await db.outboxEvent.findUniqueOrThrow({ where: { id: job.id } }))
      .attempts,
  ).toBe(0);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{}", { status: 200 })),
  );
  await workOnce();
  expect(
    (await db.outboxEvent.findUniqueOrThrow({ where: { id: job.id } })).state,
  ).toBe("DELIVERED");
});

it("identity delivery decrypts only the challenge envelope, sends real transport payload shape and fails closed when unconfigured", async () => {
  const f = await fullFixture(),
    recipient = f.people.OTHER;
  vi.stubEnv("RESEND_API_KEY", "");
  vi.stubEnv("EMAIL_FROM", "");
  const job = await db.outboxEvent.create({
    data: {
      type: "identity.reset",
      userId: recipient.id,
      payload: { encrypted: encrypt("test-one-use-code") },
      traceId: randomUUID(),
      createdAt: new Date(0),
    },
  });
  await workOnce();
  expect(
    (await db.outboxEvent.findUniqueOrThrow({ where: { id: job.id } }))
      .lastError,
  ).toContain("NOT_CONFIGURED");
  const messages: string[] = [];
  vi.stubEnv("RESEND_API_KEY", "fixture");
  vi.stubEnv("EMAIL_FROM", "test@example.invalid");
  vi.stubEnv("SMSPOP_API_KEY", "fixture");
  vi.stubEnv("SMSPOP_SENDER_ID", "TEST");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: URL | string, init: RequestInit) => {
      messages.push(String(init.body));
      return new Response("{}", { status: 200 });
    }),
  );
  await expect(
    command(f.people.ADMIN, "job.retry", { id: job.id }),
  ).rejects.toThrow("IDENTITY_JOBS_REQUIRE_SECURE_OPERATOR_RECOVERY");
  await issueChallenge(recipient.id, "EMAIL");
  await issueChallenge(recipient.id, "PHONE");
  const jobs = await db.outboxEvent.findMany({
    where: {
      userId: recipient.id,
      type: { in: ["identity.email", "identity.phone"] },
    },
  });
  await db.outboxEvent.updateMany({
    where: { id: { in: jobs.map((j) => j.id) } },
    data: { createdAt: new Date(0) },
  });
  await workOnce();
  expect(messages.some((m) => m.includes("single-use code"))).toBe(true);
  expect(messages.some((m) => m.includes("Legacy Heights verification"))).toBe(
    true,
  );
  expect(JSON.stringify(jobs)).not.toContain("test-one-use-code");
});

it("daily scheduler does not starve an overdue request beyond its first 100 records and deduplicates retries", async () => {
  const f = await fullFixture();
  await db.ticket.createMany({
    data: Array.from({ length: 105 }, (_, n) => ({
      propertyId: f.property.id,
      userId: f.people.RESIDENT.id,
      type: "MAINTENANCE",
      category: "Synthetic batch",
      priority: "URGENT",
      subject: `batch ${n}`,
      body: "Synthetic overdue request",
      dueAt: new Date(0),
    })),
  });
  await scheduledReminders();
  await scheduledReminders();
  expect(
    await db.auditEvent.count({
      where: {
        propertyId: f.property.id,
        action: "service_request.sla_escalated",
      },
    }),
  ).toBe(105);
  const metrics = await propertyMetrics(f.people.ADMIN, f.property.id);
  expect(metrics.openTickets).toBe(105);
  expect(metrics.overdueTickets).toBe(105);
});

it("request origin and output text reject foreign origins and escape active markup", () => {
  vi.stubEnv("APP_URL", "https://localhost:3443");
  expect(() =>
    assertSameOrigin(
      new Request("https://localhost:3443/api/actions", {
        headers: { Origin: "https://evil.invalid" },
      }),
    ),
  ).toThrow("CSRF");
  assertSameOrigin(
    new Request("https://localhost:3443/api/actions", {
      headers: { Origin: "https://localhost:3443" },
    }),
  );
  expect(safeText('<script x="&">')).toBe("&lt;script x=&quot;&amp;&quot;&gt;");
  expect(hash("a")).not.toBe(hash("b"));
});

it("lease expiry reminders traverse more than 100 leases and daily replays create no duplicate events", async () => {
  const f = await fullFixture(),
    template = await db.leaseTemplate.create({
      data: {
        propertyId: f.property.id,
        version: 1,
        title: "Synthetic reminder fixture",
        body: "Synthetic pre-existing agreement",
        hash: hash("fixture"),
        approvedAt: new Date(),
      },
    });
  const now = new Date(),
    end = new Date(now.getTime() + 15 * 86400000);
  const rows = Array.from({ length: 105 }, (_, i) => ({
    userId: randomUUID(),
    applicationId: randomUUID(),
    reservationId: randomUUID(),
    bedId: randomUUID(),
    leaseId: randomUUID(),
    index: i,
  }));
  await db.user.createMany({
    data: rows.map((r) => ({
      id: r.userId,
      email: `expiry-${r.userId}@example.invalid`,
      phone: `+999${r.userId.replaceAll("-", "")}`,
      name: "Synthetic reminder resident",
      passwordHash: "not-used",
    })),
  });
  await db.bed.createMany({
    data: rows.map((r) => ({
      id: r.bedId,
      roomId: f.room.id,
      label: `reminder-${r.index}`,
    })),
  });
  await db.application.createMany({
    data: rows.map((r) => ({
      id: r.applicationId,
      propertyId: f.property.id,
      userId: r.userId,
      status: "ACTIVE",
    })),
  });
  await db.reservation.createMany({
    data: rows.map((r) => ({
      id: r.reservationId,
      propertyId: f.property.id,
      userId: r.userId,
      bedId: r.bedId,
      applicationId: r.applicationId,
      startAt: now,
      endAt: end,
      state: "ACTIVE",
    })),
  });
  await db.lease.createMany({
    data: rows.map((r) => ({
      id: r.leaseId,
      propertyId: f.property.id,
      userId: r.userId,
      applicationId: r.applicationId,
      reservationId: r.reservationId,
      templateId: template.id,
      status: "EXECUTED",
      documentSnapshot: "Synthetic fixture",
      documentHash: hash(r.leaseId),
      executedAt: now,
    })),
  });
  await scheduledReminders(now);
  const replay = await scheduledReminders(now);
  expect(replay.leaseReminders).toBe(0);
  expect(
    await db.auditEvent.count({
      where: { propertyId: f.property.id, action: "lease.expiry_reminder" },
    }),
  ).toBe(105);
});
