import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { randomUUID, randomBytes } from "node:crypto";
import { PDFDocument } from "pdf-lib";
import { db } from "../src/lib/db";
import {
  passwordHash,
  hash,
  encrypt,
  decrypt,
  token,
} from "../src/lib/security";
import {
  reserve,
  expireHolds,
  reviewApplication,
} from "../src/domain/inventory";
import { permit } from "../src/domain/access";
import {
  issueCharge,
  settleProvider,
  account,
  refund,
  minor,
  reviewProof,
  proposePayment,
} from "../src/domain/finance";
import {
  upload,
  scanDocument,
  scanBytes,
  reviewDocument,
  download,
} from "../src/domain/documents";
import { createTicket, updateTicket } from "../src/domain/operations";
import {
  issueLease,
  submitSignedLease,
  executeLease,
  checkIn,
  checkOut,
} from "../src/domain/leases";
import {
  login,
  session,
  consumeChallenge,
  register,
} from "../src/domain/identity";
import {
  paynowHash,
  verifyPaynow,
  trustedPaynowUrl,
} from "../src/domain/paynow";
if (!/\/legacy_test(?:\?|$)/.test(process.env.DATABASE_URL || ""))
  throw new Error("Tests require dedicated legacy_test database");
process.env.DATA_KEY ||= randomBytes(32).toString("hex");
process.env.FILE_KEY ||= randomBytes(32).toString("hex");
process.env.STORAGE_ROOT = ".data/test-private";
const run = randomUUID();
let serial = 0;
async function fixture() {
  const key = `${run}-${serial++}`;
  const users = await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      db.user.create({
        data: {
          email: `test-${key}-${i}@example.invalid`,
          phone: `+999${Date.now()}${serial}${i}`,
          name: `Test person ${i}`,
          passwordHash: "unused",
          emailVerifiedAt: new Date(),
          phoneVerifiedAt: new Date(),
          emergencyName: "Test contact",
          emergencyPhone: "+263770000099",
        },
      }),
    ),
  );
  const property = await db.property.create({
    data: {
      slug: `test-${key}`,
      name: "Synthetic test property",
      description: "Test only",
      location: "Test",
      published: true,
      holdMinutes: 60,
      depositMinor: 3000n,
    },
  });
  await db.membership.createMany({
    data: [
      { userId: users[0].id, propertyId: property.id, role: "ADMIN" },
      { userId: users[1].id, propertyId: property.id, role: "CARETAKER" },
      { userId: users[2].id, propertyId: property.id, role: "FINANCE" },
      { userId: users[3].id, propertyId: property.id, role: "KYC" },
    ],
  });
  const building = await db.building.create({
      data: { propertyId: property.id, name: "Test building" },
    }),
    floor = await db.floor.create({
      data: { buildingId: building.id, name: "Ground", level: 0 },
    }),
    room = await db.room.create({
      data: {
        floorId: floor.id,
        name: "101",
        category: "SHARED",
        monthlyMinor: 10000n,
        beds: { create: [{ label: "A" }, { label: "B" }] },
      },
      include: { beds: true },
    });
  return {
    users,
    property,
    room,
    admin: users[0],
    caretaker: users[1],
    finance: users[2],
    kyc: users[3],
    resident: users[4],
    other: users[5],
  };
}
const dates = () => ({
  startAt: new Date(Date.now() - 1000),
  endAt: new Date(Date.now() + 90 * 86400000),
});
const hold = (bedId: string) => ({
  bedId,
  ...dates(),
  consent: true,
  termsVersion: "application-policy-v1",
});
async function pdf() {
  const p = await PDFDocument.create();
  p.addPage();
  return Buffer.from(await p.save());
}
async function payment(
  f: Awaited<ReturnType<typeof fixture>>,
  amountMinor: bigint,
  userId = f.resident.id,
) {
  const reference = `pay-${randomUUID()}`;
  return db.payment.create({
    data: {
      userId,
      propertyId: f.property.id,
      reference,
      idempotencyKey: reference,
      amountMinor,
      currency: "USD",
      method: "PAYNOW",
      providerId: reference,
    },
  });
}
beforeAll(async () => {
  await db.$queryRaw`SELECT 1`;
});
afterAll(() => db.$disconnect());
describe("identity and property authorization", () => {
  it("rejects staff access across properties and finance access by caretakers", async () => {
    const a = await fixture(),
      b = await fixture();
    await expect(permit(a.admin, b.property.id, "finance")).rejects.toThrow(
      "FORBIDDEN",
    );
    await expect(permit(a.caretaker, a.property.id, "finance")).rejects.toThrow(
      "FORBIDDEN",
    );
    await permit(a.finance, a.property.id, "finance");
  });
  it("hashes sessions, revokes them after reset, and consumes recovery tokens once", async () => {
    const f = await fixture(),
      password = "A secure test password 49!";
    await db.user.update({
      where: { id: f.resident.id },
      data: { passwordHash: await passwordHash(password) },
    });
    const raw = await login(f.resident.email, password);
    expect((await session(raw))?.id).toBe(f.resident.id);
    expect(await db.session.count({ where: { tokenHash: raw } })).toBe(0);
    const reset = token();
    await db.challenge.create({
      data: {
        userId: f.resident.id,
        kind: "RESET",
        tokenHash: hash(reset),
        expiresAt: new Date(Date.now() + 60000),
      },
    });
    await consumeChallenge(reset, "Another secure password 51!");
    expect(await session(raw)).toBeNull();
    await expect(
      consumeChallenge(reset, "Another secure password 52!"),
    ).rejects.toThrow("INVALID_OR_EXPIRED_TOKEN");
  });
  it("requires staff MFA, verifies passwords, and blocks unverified contacts from booking", async () => {
    const f = await fixture();
    await db.user.update({
      where: { id: f.admin.id },
      data: { passwordHash: await passwordHash("Staff password 99!") },
    });
    await expect(login(f.admin.email, "Staff password 99!")).rejects.toThrow(
      "STAFF_MFA",
    );
    await db.user.update({
      where: { id: f.resident.id },
      data: { phoneVerifiedAt: null },
    });
    await expect(reserve(f.resident, hold(f.room.beds[0].id))).rejects.toThrow(
      "VERIFY_EMAIL_AND_PHONE",
    );
  });
  it("does not accept student registration without institution", async () => {
    await expect(
      register({
        name: "Test student",
        email: "invalidstudent@example.invalid",
        phone: "+263770123456",
        password: "Very secure password 99!",
        residentType: "STUDENT",
      }),
    ).rejects.toThrow();
  });
  it("encrypts private payloads with authentication", () => {
    const packed = encrypt("private medical payload");
    expect(packed).not.toContain("private");
    expect(decrypt(packed).toString()).toBe("private medical payload");
    const b = Buffer.from(packed, "base64");
    b[15] ^= 1;
    expect(() => decrypt(b.toString("base64"))).toThrow();
  });
});
describe("bed-level date concurrency", () => {
  it("allows exactly one winner under simultaneous submissions on one bed", async () => {
    const f = await fixture(),
      r = await Promise.allSettled(
        f.users.slice(4).map((u) => reserve(u, hold(f.room.beds[0].id))),
      );
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(
      await db.reservation.count({
        where: { bedId: f.room.beds[0].id, state: "HOLD" },
      }),
    ).toBe(1);
  });
  it("leaves the second bed available in a shared room", async () => {
    const f = await fixture();
    await reserve(f.resident, hold(f.room.beds[0].id));
    await reserve(f.other, hold(f.room.beds[1].id));
    expect(
      await db.reservation.count({
        where: { propertyId: f.property.id, state: "HOLD" },
      }),
    ).toBe(2);
  });
  it("database rejects direct overlapping inserts, including another bed for the same resident", async () => {
    const f = await fixture();
    await reserve(f.resident, hold(f.room.beds[0].id));
    await expect(
      db.reservation.create({
        data: {
          propertyId: f.property.id,
          userId: f.other.id,
          bedId: f.room.beds[0].id,
          ...dates(),
          expiresAt: new Date(Date.now() + 60000),
        },
      }),
    ).rejects.toThrow();
    await expect(
      db.reservation.create({
        data: {
          propertyId: f.property.id,
          userId: f.resident.id,
          bedId: f.room.beds[1].id,
          ...dates(),
          expiresAt: new Date(Date.now() + 60000),
        },
      }),
    ).rejects.toThrow();
  });
  it("expires holds idempotently and recovers availability after worker downtime", async () => {
    const f = await fixture(),
      r = await reserve(f.resident, hold(f.room.beds[0].id));
    await db.reservation.update({
      where: { id: r.reservation.id },
      data: { expiresAt: new Date(Date.now() - 10000) },
    });
    await expireHolds();
    await expireHolds();
    expect(
      (
        await db.reservation.findUniqueOrThrow({
          where: { id: r.reservation.id },
        })
      ).state,
    ).toBe("EXPIRED");
    await reserve(f.other, hold(f.room.beds[0].id));
    expect(
      await db.auditEvent.count({
        where: { objectId: r.reservation.id, action: "hold.expired" },
      }),
    ).toBe(1);
  });
});
describe("money, settlement, audit and corrections", () => {
  it("parses decimal strings without binary rounding and refuses negative/scientific amounts", () => {
    expect(minor("0.29")).toBe(29n);
    expect(minor("9999999999.99")).toBe(999999999999n);
    expect(() => minor("1e3")).toThrow();
    expect(() => minor("-2")).toThrow();
  });
  it("concurrent settlements never over-allocate and replays produce one receipt", async () => {
    const f = await fixture();
    await reserve(f.resident, hold(f.room.beds[0].id));
    await issueCharge(f.finance, {
      userId: f.resident.id,
      propertyId: f.property.id,
      reference: `INV-${randomUUID()}`,
      category: "RENT",
      description: "Test rent",
      amount: "10.00",
      dueAt: new Date(),
    });
    const [p1, p2] = await Promise.all([payment(f, 700n), payment(f, 700n)]);
    await Promise.all([
      settleProvider(p1.id, p1.providerId!, "verified-test"),
      settleProvider(p2.id, p2.providerId!, "verified-test"),
    ]);
    await Promise.all([
      settleProvider(p1.id, p1.providerId!, "verified-test"),
      settleProvider(p1.id, p1.providerId!, "verified-test"),
    ]);
    const t = await account(f.resident.id, f.property.id);
    expect(t.outstanding).toBe(0n);
    expect(t.credit).toBe(400n);
    expect(await db.receipt.count({ where: { paymentId: p1.id } })).toBe(1);
    expect(
      await db.auditEvent.count({
        where: { action: "payment.settled", objectId: p1.id },
      }),
    ).toBe(1);
  });
  it("partial refund reopens debt and retains immutable receipt and allocation evidence", async () => {
    const f = await fixture();
    await reserve(f.resident, hold(f.room.beds[0].id));
    await issueCharge(f.finance, {
      userId: f.resident.id,
      propertyId: f.property.id,
      reference: `INV-${randomUUID()}`,
      category: "RENT",
      description: "Test rent",
      amount: "10.01",
      dueAt: new Date(),
    });
    const p = await payment(f, 1001n);
    await settleProvider(p.id, p.providerId!, "verified-test");
    await refund(
      f.finance,
      p.id,
      "3.01",
      "Verified test bank refund",
      `REF-${randomUUID()}`,
    );
    expect((await account(f.resident.id, f.property.id)).outstanding).toBe(
      301n,
    );
    expect(await db.allocation.count({ where: { paymentId: p.id } })).toBe(1);
    const receipt = await db.receipt.findUniqueOrThrow({
      where: { paymentId: p.id },
    });
    await expect(
      db.receipt.update({
        where: { id: receipt.id },
        data: { snapshot: { tampered: true } },
      }),
    ).rejects.toThrow("Immutable");
  });
  it("proof uploads never settle automatically and maker cannot approve own proposal", async () => {
    const f = await fixture();
    await reserve(f.resident, hold(f.room.beds[0].id));
    await issueCharge(f.finance, {
      userId: f.resident.id,
      propertyId: f.property.id,
      reference: `INV-${randomUUID()}`,
      category: "RENT",
      description: "Test rent",
      amount: "10.00",
      dueAt: new Date(),
    });
    const doc = await db.document.create({
      data: {
        userId: f.resident.id,
        propertyId: f.property.id,
        kind: "PAYMENT_PROOF",
        filename: "synthetic.pdf",
        mime: "application/pdf",
        bytes: 100,
        hash: hash(randomUUID()),
        storageKey: randomUUID(),
        state: "CLEAN",
        scanResult: "CLEAN",
      },
    });
    const p = await proposePayment(f.finance, {
      userId: f.resident.id,
      propertyId: f.property.id,
      method: "BANK",
      proofDocumentId: doc.id,
      bankReference: `bank-${randomUUID()}`,
      amount: "10.00",
      idempotencyKey: randomUUID(),
    });
    expect(p.status).toBe("PROOF_REVIEW");
    expect((await account(f.resident.id, f.property.id)).outstanding).toBe(
      1000n,
    );
    await expect(
      reviewProof(f.finance, p.id, "APPROVE", "Verified in bank"),
    ).rejects.toThrow("MAKER_CHECKER");
    await reviewProof(f.admin, p.id, "APPROVE", "Verified bank statement test");
    expect((await account(f.resident.id, f.property.id)).outstanding).toBe(0n);
  });
  it("rolls back settlement when its mandatory audit cannot persist", async () => {
    const f = await fixture(),
      p = await payment(f, 100n);
    await db.$executeRawUnsafe(
      `CREATE FUNCTION test_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='payment.settled' THEN RAISE EXCEPTION 'forced audit failure'; END IF; RETURN NEW; END; $$`,
    );
    await db.$executeRawUnsafe(
      `CREATE TRIGGER test_audit_failure BEFORE INSERT ON "AuditEvent" FOR EACH ROW EXECUTE FUNCTION test_audit_failure()`,
    );
    try {
      await expect(
        settleProvider(p.id, p.providerId!, "verified-test"),
      ).rejects.toThrow();
      expect(
        (await db.payment.findUniqueOrThrow({ where: { id: p.id } })).status,
      ).toBe("PENDING");
      expect(await db.receipt.count({ where: { paymentId: p.id } })).toBe(0);
    } finally {
      await db.$executeRawUnsafe(
        'DROP TRIGGER test_audit_failure ON "AuditEvent"',
      );
      await db.$executeRawUnsafe("DROP FUNCTION test_audit_failure()");
    }
  });
});
describe("private KYC, lease evidence and support journeys", () => {
  it("quarantines files, runs ClamAV, restricts medical access and detects malware", async () => {
    const f = await fixture(),
      a = await reserve(f.resident, hold(f.room.beds[0].id));
    const d = await upload(f.resident, {
      propertyId: f.property.id,
      applicationId: a.application.id,
      kind: "MEDICAL",
      medicalConsent: true,
      filename: "../../private.pdf",
      bytes: await pdf(),
    });
    expect(d.state).toBe("QUARANTINED");
    await expect(download(f.resident, d.id)).rejects.toThrow("QUARANTINED");
    await scanDocument(d.id);
    await expect(download(f.kyc, d.id)).rejects.toThrow("FORBIDDEN");
    await download(f.admin, d.id);
    await expect(
      upload(f.resident, {
        propertyId: f.property.id,
        kind: "IDENTITY",
        filename: "bad.svg",
        bytes: Buffer.from("<svg><script>alert(1)</script></svg>"),
      }),
    ).rejects.toThrow("ONLY_PDF");
    const eicar = Buffer.from(
      "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*",
    );
    expect(await scanBytes(eicar)).toBe("INFECTED");
  });
  it("completes review → deposit → immutable signed lease → check-in → support → turnover", async () => {
    const f = await fixture(),
      a = await reserve(f.resident, hold(f.room.beds[0].id));
    for (const kind of ["IDENTITY", "RESIDENCE"]) {
      const d = await upload(f.resident, {
        propertyId: f.property.id,
        applicationId: a.application.id,
        kind,
        filename: `${kind}.pdf`,
        bytes: await pdf(),
      });
      await scanDocument(d.id);
      await reviewDocument(f.kyc, d.id, true, "Synthetic evidence checked");
    }
    await reviewApplication(
      f.admin,
      a.application.id,
      "APPROVED",
      "Requirements checked",
    );
    const p = await payment(f, 3000n);
    await settleProvider(p.id, p.providerId!, "verified-test");
    expect(
      (
        await db.reservation.findUniqueOrThrow({
          where: { id: a.reservation.id },
        })
      ).state,
    ).toBe("CONFIRMED");
    const body = "TEST ONLY approved synthetic terms";
    const t = await db.leaseTemplate.create({
      data: {
        propertyId: f.property.id,
        title: "Test",
        body,
        hash: hash(body),
        version: 1,
        approvedAt: new Date(),
        approvedBy: f.admin.id,
      },
    });
    const l = await issueLease(f.admin, a.application.id, t.id);
    const d = await upload(f.resident, {
      propertyId: f.property.id,
      applicationId: a.application.id,
      kind: "SIGNED_LEASE",
      filename: "signed.pdf",
      bytes: await pdf(),
    });
    await scanDocument(d.id);
    await submitSignedLease(f.resident, l.id, d.id, true);
    await executeLease(
      f.admin,
      l.id,
      "Signed copy and resident identity checked",
    );
    await expect(
      db.lease.update({
        where: { id: l.id },
        data: { documentSnapshot: "tampered" },
      }),
    ).rejects.toThrow("immutable");
    await checkIn(f.admin, l.id);
    const ticket = await createTicket(f.resident, {
      propertyId: f.property.id,
      type: "COMPLAINT",
      category: "Noise",
      priority: "NORMAL",
      subject: "Test complaint",
      body: "Synthetic issue for lifecycle verification.",
    });
    await updateTicket(f.caretaker, ticket.id, {
      status: "IN_PROGRESS",
      body: "Investigating synthetic complaint",
    });
    await updateTicket(f.caretaker, ticket.id, {
      status: "RESOLVED",
      body: "Synthetic issue resolved",
    });
    expect(
      (await db.ticket.findUniqueOrThrow({ where: { id: ticket.id } }))
        .firstResponseAt,
    ).not.toBeNull();
    const other = await fixture();
    await expect(
      updateTicket(other.caretaker, ticket.id, {
        status: "RESOLVED",
        body: "Forged crossing attempt",
      }),
    ).rejects.toThrow("FORBIDDEN");
    await checkOut(
      f.admin,
      l.id,
      "Synthetic inspection complete; no damages; deposit review pending",
    );
    expect(
      (await db.bed.findUniqueOrThrow({ where: { id: f.room.beds[0].id } }))
        .blocked,
    ).toBe(true);
  });
});
describe("Paynow verification boundaries", () => {
  it("rejects forged and missing hashes, and disallows SSRF provider URLs", () => {
    const fields = { reference: "LH-test", amount: "12.34", status: "paid" };
    expect(
      verifyPaynow(
        { ...fields, hash: paynowHash(fields, "test-key") },
        "test-key",
      ),
    ).toBe(true);
    expect(
      verifyPaynow(
        { ...fields, amount: "99.00", hash: paynowHash(fields, "test-key") },
        "test-key",
      ),
    ).toBe(false);
    expect(verifyPaynow(fields, "test-key")).toBe(false);
    for (const u of [
      "http://www.paynow.co.zw/poll",
      "https://127.0.0.1/poll",
      "https://www.paynow.co.zw.evil.test/poll",
      "https://user:pass@www.paynow.co.zw/poll",
    ])
      expect(() => trustedPaynowUrl(u)).toThrow();
  });
});

describe("renewal, waitlist and integration scopes", () => {
  it("waitlist offers expire and move the next applicant forward without overbooking", async () => {
    const { joinWaitlist, offerWaitlist } =
      await import("../src/domain/inventory");
    const f = await fixture();
    await db.bed.update({
      where: { id: f.room.beds[1].id },
      data: { blocked: true },
    });
    const first = await joinWaitlist(f.resident, {
        propertyId: f.property.id,
        ...dates(),
      }),
      second = await joinWaitlist(f.other, {
        propertyId: f.property.id,
        ...dates(),
      });
    await offerWaitlist();
    const offered = await db.waitlist.findUniqueOrThrow({
      where: { id: first.id },
    });
    expect(offered.state).toBe("OFFERED");
    expect(
      (await db.waitlist.findUniqueOrThrow({ where: { id: second.id } })).state,
    ).toBe("WAITING");
    await db.reservation.update({
      where: { id: offered.offeredReservationId! },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await expireHolds();
    await offerWaitlist();
    expect(
      (await db.waitlist.findUniqueOrThrow({ where: { id: second.id } })).state,
    ).toBe("OFFERED");
    expect(
      await db.reservation.count({
        where: { propertyId: f.property.id, state: "HOLD" },
      }),
    ).toBe(1);
  });
  it("read-only API keys enforce delegated capabilities and property boundaries", async () => {
    const { issueApiKey, apiActor } = await import("../src/domain/api-keys");
    const f = await fixture(),
      b = await fixture();
    const k = await issueApiKey(
      f.admin,
      f.property.id,
      "Test accounting export",
      ["finance.read"],
    );
    const a = await apiActor(k.token);
    await permit(a, f.property.id, "finance.read");
    await expect(permit(a, f.property.id, "finance")).rejects.toThrow(
      "FORBIDDEN",
    );
    await expect(permit(a, b.property.id, "finance.read")).rejects.toThrow(
      "FORBIDDEN",
    );
    await db.apiKey.update({ where: { id: k.id }, data: { active: false } });
    await expect(apiActor(k.token)).rejects.toThrow("INVALID_API_KEY");
  });
  it("records a non-overlapping renewal and bills monthly rent only once", async () => {
    const { requestTenancyChange, reviewTenancyChange, billCurrentMonth } =
      await import("../src/domain/tenancy");
    const f = await fixture(),
      a = await reserve(f.resident, hold(f.room.beds[0].id));
    await db.reservation.update({
      where: { id: a.reservation.id },
      data: { state: "ACTIVE", expiresAt: null },
    });
    await db.application.update({
      where: { id: a.application.id },
      data: { status: "ACTIVE" },
    });
    const t = await db.leaseTemplate.create({
      data: {
        propertyId: f.property.id,
        version: 1,
        title: "Test renewal terms",
        body: "Synthetic approved test terms only",
        hash: hash("test"),
        approvedAt: new Date(),
      },
    });
    const l = await db.lease.create({
      data: {
        propertyId: f.property.id,
        userId: f.resident.id,
        applicationId: a.application.id,
        reservationId: a.reservation.id,
        templateId: t.id,
        status: "EXECUTED",
        documentSnapshot: "Test only",
        documentHash: hash("Test only"),
        executedAt: new Date(),
      },
    });
    await billCurrentMonth();
    await billCurrentMonth();
    expect(
      await db.charge.count({
        where: { userId: f.resident.id, category: "RENT" },
      }),
    ).toBe(1);
    const charge = await db.charge.findFirstOrThrow({
        where: { userId: f.resident.id, category: "RENT" },
      }),
      p = await payment(f, charge.amountMinor);
    await settleProvider(p.id, p.providerId!, "verified-test");
    const change = await requestTenancyChange(f.resident, {
      leaseId: l.id,
      type: "RENEWAL",
      targetBedId: f.room.beds[0].id,
      startAt: a.reservation.endAt,
      endAt: new Date(a.reservation.endAt.getTime() + 90 * 86400000),
      reason: "Synthetic request to extend tenancy",
    });
    await reviewTenancyChange(
      f.admin,
      change.id,
      true,
      "Arrears clear, availability checked",
    );
    expect(
      (await db.tenancyRequest.findUniqueOrThrow({ where: { id: change.id } }))
        .state,
    ).toBe("APPROVED");
    expect(
      await db.reservation.count({
        where: {
          userId: f.resident.id,
          state: { in: ["ACTIVE", "CONFIRMED"] },
        },
      }),
    ).toBe(2);
  });
});

describe("dated room, bed and term prices", () => {
  it("applies dated bed overrides and preserves exact calendar fractions", async () => {
    const { quoteRates, quoteSlice } = await import("../src/domain/pricing");
    const base = {
      roomId: "room",
      bedId: "bed",
      baseMinor: 31000n,
      currency: "USD",
      startAt: new Date("2027-01-01"),
      endAt: new Date("2027-02-01"),
    };
    const rules = [
      {
        id: "bed-rule",
        propertyId: "property",
        roomId: null,
        bedId: "bed",
        title: "Bed-specific rate",
        startAt: new Date("2027-01-16"),
        endAt: new Date("2027-02-01"),
        minNights: 1,
        monthlyMinor: 62000n,
        priority: 0,
        createdAt: new Date(),
      },
    ];
    const snapshot = quoteRates(base, rules);
    expect(snapshot.totalMinor).toBe("47000");
    expect(
      quoteSlice(snapshot, new Date("2027-01-01"), new Date("2027-01-16")),
    ).toBe(15000n);
    expect(quoteRates({ ...base, bedId: "another" }, rules).totalMinor).toBe(
      "31000",
    );
  });
  it("waitlist acceptance creates an application only after versioned consent", async () => {
    const { joinWaitlist, offerWaitlist, acceptWaitlist } =
      await import("../src/domain/inventory");
    const f = await fixture(),
      entry = await joinWaitlist(f.resident, {
        propertyId: f.property.id,
        ...dates(),
      });
    await offerWaitlist();
    expect(
      await db.application.count({ where: { userId: f.resident.id } }),
    ).toBe(0);
    await expect(acceptWaitlist(f.resident, entry.id, false)).rejects.toThrow(
      "CONSENT",
    );
    await acceptWaitlist(f.resident, entry.id, true);
    expect(
      await db.application.count({ where: { userId: f.resident.id } }),
    ).toBe(1);
    expect(
      await db.consent.count({
        where: { userId: f.resident.id, purpose: "APPLICATION" },
      }),
    ).toBe(1);
  });
});

describe("Paynow contract and failure recovery", () => {
  it("matches the official SDK key-normalization rule", () => {
    const values = {
      reference: "LH-contract",
      amount: "10.00",
      status: "paid",
    };
    expect(paynowHash(values, "aBc-123")).toBe(paynowHash(values, "abc-123"));
  });
  it("polls signed confirmations, rejects mismatches and records a late full refund once", async () => {
    const { vi } = await import("vitest"),
      { reconcilePaynow, callback } = await import("../src/domain/paynow");
    const f = await fixture();
    await reserve(f.resident, hold(f.room.beds[0].id));
    await issueCharge(f.finance, {
      userId: f.resident.id,
      propertyId: f.property.id,
      reference: `INV-${randomUUID()}`,
      category: "RENT",
      description: "Provider contract test",
      amount: "10.00",
      dueAt: new Date(),
    });
    const p = await payment(f, 1000n);
    await db.payment.update({
      where: { id: p.id },
      data: { pollUrl: "https://www.paynow.co.zw/interface/poll/test" },
    });
    vi.stubEnv("PAYNOW_MODE", "live");
    vi.stubEnv("PAYNOW_INTEGRATION_ID", "fixture-id");
    vi.stubEnv("PAYNOW_INTEGRATION_KEY", "Fixture-Key");
    vi.stubEnv("PAYNOW_CURRENCY", "USD");
    vi.stubEnv("APP_URL", "https://example.invalid");
    const response = (status: string, amount = "10.0") => {
      const fields = {
        reference: p.reference,
        paynowreference: p.providerId!,
        amount,
        status,
        pollurl: "https://www.paynow.co.zw/interface/poll/test",
      };
      return { ...fields, hash: paynowHash(fields, "Fixture-Key") };
    };
    try {
      vi.stubGlobal(
        "fetch",
        async () =>
          new Response(new URLSearchParams(response("paid", "99.00"))),
      );
      await expect(reconcilePaynow(p.id)).rejects.toThrow("MISMATCH");
      expect(
        (await db.payment.findUniqueOrThrow({ where: { id: p.id } })).status,
      ).toBe("PENDING");
      vi.stubGlobal(
        "fetch",
        async () => new Response(new URLSearchParams(response("paid"))),
      );
      await reconcilePaynow(p.id);
      await callback(response("paid"));
      await callback(response("paid"));
      expect(await db.receipt.count({ where: { paymentId: p.id } })).toBe(1);
      vi.stubGlobal(
        "fetch",
        async () => new Response(new URLSearchParams(response("refunded"))),
      );
      await reconcilePaynow(p.id);
      await reconcilePaynow(p.id);
      expect(
        (await db.payment.findUniqueOrThrow({ where: { id: p.id } })).status,
      ).toBe("REFUNDED");
      expect(await db.refund.count({ where: { paymentId: p.id } })).toBe(1);
      expect((await account(f.resident.id, f.property.id)).outstanding).toBe(
        1000n,
      );
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });
  it("preserves ambiguous initiation and refuses a replacement intent", async () => {
    const { vi } = await import("vitest"),
      { initiatePaynow } = await import("../src/domain/paynow");
    const f = await fixture();
    await reserve(f.resident, hold(f.room.beds[0].id));
    await issueCharge(f.finance, {
      userId: f.resident.id,
      propertyId: f.property.id,
      reference: `INV-${randomUUID()}`,
      category: "RENT",
      description: "Provider ambiguity test",
      amount: "10.00",
      dueAt: new Date(),
    });
    const input = {
      userId: f.resident.id,
      propertyId: f.property.id,
      amount: "10.00",
      method: "PAYNOW",
      idempotencyKey: randomUUID(),
    };
    const p = await proposePayment(f.resident, input);
    vi.stubEnv("PAYNOW_MODE", "live");
    vi.stubEnv("PAYNOW_INTEGRATION_ID", "fixture-id");
    vi.stubEnv("PAYNOW_INTEGRATION_KEY", "fixture-key");
    vi.stubEnv("PAYNOW_CURRENCY", "USD");
    vi.stubEnv("APP_URL", "https://example.invalid");
    vi.stubGlobal("fetch", async () => {
      throw new Error("Simulated provider timeout");
    });
    try {
      await expect(initiatePaynow(f.resident, p.id)).rejects.toThrow(
        "Simulated",
      );
      expect(
        (await db.payment.findUniqueOrThrow({ where: { id: p.id } })).status,
      ).toBe("INITIATION_UNKNOWN");
      expect(
        (
          await proposePayment(f.resident, {
            ...input,
            idempotencyKey: randomUUID(),
          })
        ).id,
      ).toBe(p.id);
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });
});

describe("client administration and local exchange contracts", () => {
  it("denies a property administrator client-wide actions until every property is explicitly granted", async () => {
    const { permitClientAdmin } = await import("../src/domain/access"),
      { command } = await import("../src/domain/commands");
    const f = await fixture();
    await expect(permitClientAdmin(f.admin)).rejects.toThrow(
      "CLIENT_ADMIN_REQUIRED",
    );
    const properties = await db.property.findMany({ select: { id: true } });
    await db.membership.createMany({
      data: properties.map((p) => ({
        userId: f.admin.id,
        propertyId: p.id,
        role: "ADMIN",
      })),
      skipDuplicates: true,
    });
    await permitClientAdmin(f.admin);
    const p = (await command(f.admin, "property.create", {
      name: "Additional synthetic property",
      slug: `new-${randomUUID()}`,
      legalEntity: "Synthetic test entity",
      description:
        "Synthetic property created by the scoped client administrator test.",
      location: "Test only",
      currency: "USD",
      deposit: "30.00",
      holdMinutes: "15",
    })) as { id: string; published: boolean };
    expect(p.published).toBe(false);
    await permit(f.admin, p.id, "settings");
  });
  it("exports actual accounting/inventory rows and excludes SIS metadata without separate consent", async () => {
    const { accountingCsv, pmsCsv, sisCsv, testConnector } =
      await import("../src/integrations");
    const f = await fixture();
    await reserve(f.resident, hold(f.room.beds[0].id));
    await issueCharge(f.finance, {
      userId: f.resident.id,
      propertyId: f.property.id,
      reference: `INV-${randomUUID()}`,
      category: "RENT",
      description: "CSV contract test",
      amount: "10.01",
      dueAt: new Date(),
    });
    const data = await accountingCsv.export(f.finance, f.property.id);
    expect(data.rows).toHaveLength(1);
    expect(data.rows[0][3]).toBe("1001");
    expect((await pmsCsv.export(f.admin, f.property.id)).rows).toHaveLength(2);
    await expect(
      accountingCsv.export(f.caretaker, f.property.id),
    ).rejects.toThrow("FORBIDDEN");
    await db.user.update({
      where: { id: f.resident.id },
      data: {
        residentType: "STUDENT",
        institution: "Synthetic Test Institution",
      },
    });
    expect((await sisCsv.export(f.admin, f.property.id)).rows).toHaveLength(0);
    await db.consent.create({
      data: {
        userId: f.resident.id,
        purpose: "SIS_EXCHANGE",
        version: "v1",
        documentHash: hash("Synthetic consent"),
      },
    });
    expect((await sisCsv.export(f.admin, f.property.id)).rows).toHaveLength(1);
    expect(
      (await testConnector(f.admin, f.property.id, "ACCOUNTING_CSV")).status,
    ).toBe("LOCAL_VALIDATED");
  });
});

describe("zero-deposit admission and reusable verified credit", () => {
  it("advances approved zero-deposit applications without a fake payment", async () => {
    const f = await fixture(),
      a = await reserve(f.resident, hold(f.room.beds[0].id));
    await db.property.update({
      where: { id: f.property.id },
      data: { depositMinor: 0n },
    });
    for (const kind of ["IDENTITY", "RESIDENCE"])
      await db.document.create({
        data: {
          userId: f.resident.id,
          propertyId: f.property.id,
          applicationId: a.application.id,
          kind,
          filename: "synthetic.pdf",
          mime: "application/pdf",
          bytes: 100,
          hash: hash(randomUUID()),
          storageKey: randomUUID(),
          state: "APPROVED",
          scanResult: "CLEAN",
        },
      });
    await reviewApplication(
      f.admin,
      a.application.id,
      "APPROVED",
      "No-deposit policy and synthetic evidence checked",
    );
    expect(
      (
        await db.application.findUniqueOrThrow({
          where: { id: a.application.id },
        })
      ).status,
    ).toBe("LEASE_SIGNING_PENDING");
    expect(
      (
        await db.reservation.findUniqueOrThrow({
          where: { id: a.reservation.id },
        })
      ).state,
    ).toBe("CONFIRMED");
    expect(await db.payment.count({ where: { userId: f.resident.id } })).toBe(
      0,
    );
  });
  it("applies existing verified excess funds to later invoices once without another receipt", async () => {
    const { applyAvailableCredit } = await import("../src/domain/finance");
    const f = await fixture();
    await reserve(f.resident, hold(f.room.beds[0].id));
    await issueCharge(f.finance, {
      userId: f.resident.id,
      propertyId: f.property.id,
      reference: `INV-${randomUUID()}`,
      category: "RENT",
      description: "Initial charge",
      amount: "10.00",
      dueAt: new Date(),
    });
    const p = await payment(f, 1500n);
    await settleProvider(p.id, p.providerId!, "Synthetic verified funds");
    await issueCharge(f.finance, {
      userId: f.resident.id,
      propertyId: f.property.id,
      reference: `INV-${randomUUID()}`,
      category: "RENT",
      description: "Later charge",
      amount: "4.00",
      dueAt: new Date(),
    });
    await applyAvailableCredit(f.resident, f.resident.id, f.property.id);
    await applyAvailableCredit(f.resident, f.resident.id, f.property.id);
    const balance = await account(f.resident.id, f.property.id);
    expect(balance.outstanding).toBe(0n);
    expect(balance.credit).toBe(100n);
    expect(await db.receipt.count({ where: { paymentId: p.id } })).toBe(1);
  });
});
