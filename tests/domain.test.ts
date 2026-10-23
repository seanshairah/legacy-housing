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
    const attachment = await upload(f.caretaker, {
      propertyId: f.property.id,
      kind: "SUPPORT",
      filename: "staff-response.pdf",
      bytes: await pdf(),
    });
    await scanDocument(attachment.id);
    await expect(download(f.resident, attachment.id)).rejects.toThrow(
      "FORBIDDEN",
    );
    await updateTicket(f.caretaker, ticket.id, {
      status: "RESOLVED",
      body: "Scanned resolution evidence",
      documentId: attachment.id,
    });
    await download(f.resident, attachment.id);
    await expect(download(f.other, attachment.id)).rejects.toThrow("FORBIDDEN");
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

it("audits authenticator activation and revokes sessions created before MFA", async () => {
  const { enrollMfa, confirmMfa } = await import("../src/domain/identity"),
    { totp } = await import("../src/lib/security");
  const f = await fixture(),
    password = "Authenticator activation test 49!";
  await db.user.update({
    where: { id: f.resident.id },
    data: { passwordHash: await passwordHash(password) },
  });
  const previous = await login(f.resident.email, password);
  const setup = await enrollMfa(f.resident.email.toUpperCase(), password);
  await confirmMfa(f.resident.email, password, totp(setup.secret).generate());
  expect(await session(previous)).toBeNull();
  await expect(login(f.resident.email, password)).rejects.toThrow(
    "MFA_CODE_REQUIRED",
  );
  expect(
    await db.auditEvent.count({
      where: { actorId: f.resident.id, action: "identity.mfa_enabled" },
    }),
  ).toBe(1);
});

it("fails closed and dead-letters exhausted scans instead of starving the queue", async () => {
  const { vi } = await import("vitest"),
    { command } = await import("../src/domain/commands");
  const f = await fixture();
  await reserve(f.resident, hold(f.room.beds[0].id));
  const d = await upload(f.resident, {
    propertyId: f.property.id,
    kind: "IDENTITY",
    filename: "retry.pdf",
    bytes: await pdf(),
  });
  await db.document.update({ where: { id: d.id }, data: { scanAttempts: 4 } });
  vi.stubEnv("CLAMAV_PORT", "1");
  try {
    await expect(scanDocument(d.id)).rejects.toThrow();
    expect(
      (await db.document.findUniqueOrThrow({ where: { id: d.id } })).state,
    ).toBe("SCAN_FAILED");
    await expect(download(f.resident, d.id)).rejects.toThrow("QUARANTINED");
    await expect(
      command(f.other, "document.retry", { id: d.id, reason: "Forged retry" }),
    ).rejects.toThrow("FORBIDDEN");
    await command(f.kyc, "document.retry", {
      id: d.id,
      reason: "Scanner restored and resource issue reviewed",
    });
    expect(
      (await db.document.findUniqueOrThrow({ where: { id: d.id } }))
        .scanAttempts,
    ).toBe(0);
  } finally {
    vi.unstubAllEnvs();
  }
});

it("quotes exactly the sum of independently rounded calendar-month invoices", async () => {
  const { quoteRates, quoteSlice } = await import("../src/domain/pricing");
  const snapshot = quoteRates(
    {
      roomId: "round-room",
      bedId: "round-bed",
      baseMinor: 10001n,
      currency: "USD",
      startAt: new Date("2027-01-17"),
      endAt: new Date("2027-03-18"),
    },
    [],
  );
  const total =
    quoteSlice(snapshot, new Date("2027-01-17"), new Date("2027-02-01")) +
    quoteSlice(snapshot, new Date("2027-02-01"), new Date("2027-03-01")) +
    quoteSlice(snapshot, new Date("2027-03-01"), new Date("2027-03-18"));
  expect(BigInt(snapshot.totalMinor)).toBe(total);
});

it("requires staff and independent approval for cash while retaining excess funds", async () => {
  const f = await fixture();
  await reserve(f.resident, hold(f.room.beds[0].id));
  await issueCharge(f.finance, {
    userId: f.resident.id,
    propertyId: f.property.id,
    reference: `INV-${randomUUID()}`,
    category: "RENT",
    description: "Cash tender test",
    amount: "10.00",
    dueAt: new Date(),
  });
  const data = {
    propertyId: f.property.id,
    userId: f.resident.id,
    amount: "15.00",
    method: "CASH",
    bankReference: `CASH-${randomUUID()}`,
    idempotencyKey: randomUUID(),
  };
  await expect(proposePayment(f.resident, data)).rejects.toThrow("FORBIDDEN");
  const p = await proposePayment(f.finance, data);
  expect(p.status).toBe("PROOF_REVIEW");
  await expect(
    reviewProof(f.finance, p.id, "APPROVE", "Counted own proposal"),
  ).rejects.toThrow("MAKER_CHECKER");
  await reviewProof(
    f.admin,
    p.id,
    "APPROVE",
    "Synthetic voucher independently counted",
  );
  expect((await account(f.resident.id, f.property.id)).credit).toBe(500n);
});

describe("original Word scope completion", () => {
  async function signable() {
    const f = await fixture(),
      a = await reserve(f.resident, hold(f.room.beds[0].id));
    await db.reservation.update({
      where: { id: a.reservation.id },
      data: { state: "CONFIRMED", expiresAt: null },
    });
    await db.application.update({
      where: { id: a.application.id },
      data: { status: "LEASE_SIGNING_PENDING" },
    });
    const disclosure =
      "TEST ONLY: I intend my typed name and authenticator confirmation to sign this exact synthetic agreement electronically. Management reviews execution separately.";
    const template = await db.leaseTemplate.create({
      data: {
        propertyId: f.property.id,
        version: 1,
        title: "Synthetic electronic terms",
        body: "Synthetic lease test terms only",
        hash: hash("Synthetic lease test terms only"),
        signingDisclosure: disclosure,
        approvedAt: new Date(),
        approvedBy: f.admin.id,
      },
    });
    const lease = await issueLease(f.admin, a.application.id, template.id);
    const { newTotpSecret } = await import("../src/lib/security");
    const secret = newTotpSecret();
    await db.user.update({
      where: { id: f.resident.id },
      data: { mfaSecret: encrypt(secret), mfaConfirmed: true },
    });
    return { f, lease, secret };
  }
  it("signs the exact agreement with MFA, preserves the scanned signed PDF and requires independent execution", async () => {
    const { beginElectronicSigning, signElectronically } =
      await import("../src/domain/e-signature");
    const { totp } = await import("../src/lib/security");
    const { f, lease, secret } = await signable();
    await expect(beginElectronicSigning(f.other, lease.id)).rejects.toThrow(
      "AUTHENTICATOR",
    );
    const review = await beginElectronicSigning(f.resident, lease.id),
      code = totp(secret).generate();
    const input = {
      leaseId: lease.id,
      challenge: review.challenge,
      documentHash: review.documentHash,
      name: f.resident.name,
      code,
      consent: true,
    };
    await expect(
      signElectronically(f.resident, {
        ...input,
        documentHash: "0".repeat(64),
      }),
    ).rejects.toThrow("MISMATCH");
    await expect(
      signElectronically(f.resident, { ...input, name: "Someone Else" }),
    ).rejects.toThrow("MISMATCH");
    await expect(
      signElectronically(f.resident, { ...input, consent: false }),
    ).rejects.toThrow();
    const result = await signElectronically(f.resident, input);
    expect(result.status).toBe("REVIEW");
    const signed = await download(f.resident, result.documentId);
    expect(hash(signed.bytes)).toBe(
      (await db.lease.findUniqueOrThrow({ where: { id: lease.id } }))
        .signedHash,
    );
    expect(signed.bytes.subarray(0, 5).toString()).toBe("%PDF-");
    await expect(signElectronically(f.resident, input)).rejects.toThrow(
      "LEASE_SIGNATURE_DENIED",
    );
    const e = await db.leaseEvent.findFirstOrThrow({
      where: { leaseId: lease.id, type: "ELECTRONICALLY_SIGNED" },
    });
    expect(JSON.stringify(e.evidence)).toContain(review.documentHash);
    expect(JSON.stringify(e.evidence)).not.toContain(review.challenge);
    await executeLease(
      f.admin,
      lease.id,
      "Test signer and exact signed PDF independently checked",
    );
    await expect(
      db.leaseEvent.update({ where: { id: e.id }, data: { type: "FORGED" } }),
    ).rejects.toThrow(/immutable/i);
  });
  it("rejects expired signing challenges, another verified signer and alteration of the issued source", async () => {
    const { beginElectronicSigning, signElectronically } =
        await import("../src/domain/e-signature"),
      { totp } = await import("../src/lib/security");
    const { f, lease, secret } = await signable();
    const review = await beginElectronicSigning(f.resident, lease.id);
    await db.leaseSigningChallenge.update({
      where: { tokenHash: hash(review.challenge) },
      data: { expiresAt: new Date(0) },
    });
    await expect(
      signElectronically(f.resident, {
        leaseId: lease.id,
        challenge: review.challenge,
        documentHash: review.documentHash,
        name: f.resident.name,
        code: totp(secret).generate(),
        consent: true,
      }),
    ).rejects.toThrow("EXPIRED_OR_USED");
    await db.user.update({
      where: { id: f.other.id },
      data: { mfaSecret: encrypt(secret), mfaConfirmed: true },
    });
    await expect(beginElectronicSigning(f.other, lease.id)).rejects.toThrow(
      "LEASE_SIGNATURE_DENIED",
    );
    await expect(
      db.lease.update({
        where: { id: lease.id },
        data: { documentSnapshot: "Changed after issue" },
      }),
    ).rejects.toThrow("immutable");
  });
  it("blocks rejected signing evidence and supports audited return and replacement before execution", async () => {
    const { f, lease } = await signable(),
      { returnSignedLease } = await import("../src/domain/leases");
    const doc = await upload(f.resident, {
      propertyId: f.property.id,
      applicationId: lease.applicationId,
      kind: "SIGNED_LEASE",
      filename: "first-signed.pdf",
      bytes: await pdf(),
    });
    await scanDocument(doc.id);
    await submitSignedLease(f.resident, lease.id, doc.id, true);
    await reviewDocument(
      f.admin,
      doc.id,
      false,
      "Synthetic signature evidence was incomplete",
    );
    await expect(
      executeLease(f.admin, lease.id, "Attempt to use rejected evidence"),
    ).rejects.toThrow("SIGNED_COPY_INVALID");
    await returnSignedLease(
      f.admin,
      lease.id,
      "Please provide a complete signed agreement",
    );
    const replacement = await upload(f.resident, {
      propertyId: f.property.id,
      applicationId: lease.applicationId,
      kind: "SIGNED_LEASE",
      filename: "replacement-signed.pdf",
      bytes: await pdf(),
    });
    await scanDocument(replacement.id);
    await submitSignedLease(f.resident, lease.id, replacement.id, true);
    await executeLease(
      f.admin,
      lease.id,
      "Replacement copy independently checked",
    );
    expect(replacement.version).toBe(2);
    expect(
      await db.leaseEvent.count({
        where: { leaseId: lease.id, type: "SIGNATURE_RETURNED" },
      }),
    ).toBe(1);
  });
  it("commits one signature and one downloadable artifact under competing submissions", async () => {
    const { beginElectronicSigning, signElectronically } =
        await import("../src/domain/e-signature"),
      { totp } = await import("../src/lib/security");
    const { f, lease, secret } = await signable(),
      review = await beginElectronicSigning(f.resident, lease.id);
    const input = {
      leaseId: lease.id,
      challenge: review.challenge,
      documentHash: review.documentHash,
      name: f.resident.name,
      code: totp(secret).generate(),
      consent: true,
    };
    const results = await Promise.allSettled([
      signElectronically(f.resident, input),
      signElectronically(f.resident, input),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(
      await db.document.count({
        where: { applicationId: lease.applicationId, kind: "SIGNED_LEASE" },
      }),
    ).toBe(1);
    expect(
      await db.leaseEvent.count({
        where: { leaseId: lease.id, type: "ELECTRONICALLY_SIGNED" },
      }),
    ).toBe(1);
  });
  it("calculates rental debt, net allocations after refunds and finance-only reconciliation from source records", async () => {
    const { financialReconciliation } = await import("../src/domain/reporting");
    const f = await fixture();
    await reserve(f.resident, hold(f.room.beds[0].id));
    await issueCharge(f.finance, {
      userId: f.resident.id,
      propertyId: f.property.id,
      reference: `scope-${randomUUID()}`,
      category: "RENT",
      description: "Synthetic due rent",
      amount: "100.00",
      dueAt: new Date(Date.now() - 86400000),
    });
    const p = await payment(f, 4000n);
    await settleProvider(p.id, p.providerId!, "scope-test");
    await refund(
      f.finance,
      p.id,
      "10.00",
      "Externally verified test refund",
      `refund-${randomUUID()}`,
    );
    const r = await financialReconciliation(f.finance, f.property.id);
    expect(r.netDue).toBe(10000n);
    expect(r.collected).toBe(3000n);
    expect(r.overdueRent).toBe(7000n);
    expect(r.collectionPercent).toBe(30);
    expect(r.transactions[0].refunded).toBe(1000n);
    expect(r.exceptions).toBe(0);
    await expect(
      financialReconciliation(f.caretaker, f.property.id),
    ).rejects.toThrow("FORBIDDEN");
    await expect(
      financialReconciliation(f.finance, f.property.id, { from: "bad" }),
    ).rejects.toThrow("INVALID_REPORT_PERIOD");
  });
  it("reports a defined renewal cohort and complaint trend with room/property scope", async () => {
    const { operationalAnalytics } = await import("../src/domain/reporting");
    const { f, lease } = await signable();
    await db.lease.update({
      where: { id: lease.id },
      data: { status: "EXECUTED", executedAt: new Date() },
    });
    await db.tenancyRequest.create({
      data: {
        leaseId: lease.id,
        userId: f.resident.id,
        propertyId: f.property.id,
        type: "RENEWAL",
        state: "APPROVED",
        targetBedId: f.room.beds[0].id,
        startAt: new Date(Date.now() + 120 * 86400000),
        endAt: new Date(Date.now() + 180 * 86400000),
        reason: "Synthetic cohort test",
      },
    });
    await createTicket(f.resident, {
      propertyId: f.property.id,
      type: "COMPLAINT",
      category: "Noise",
      priority: "NORMAL",
      subject: "Synthetic recurring noise",
      body: "Synthetic complaint trend verification",
    });
    const r = await operationalAnalytics(f.admin, f.property.id, {
      from: new Date(Date.now() - 86400000).toISOString(),
      to: new Date(Date.now() + 200 * 86400000).toISOString(),
    });
    expect(r.renewalPercent).toBe(100);
    expect(r.eligibleLeases).toBe(1);
    expect(r.trends[0].complaints).toBe(1);
    const empty = await operationalAnalytics(f.admin, f.property.id, {
      room: "another-property-room",
    });
    expect(empty.rooms).toHaveLength(0);
    expect(empty.trends).toHaveLength(0);
  });
  it("detects repeated attacks without logging identifiers and restricts alert response by property", async () => {
    const { securitySignal } = await import("../src/lib/security-monitor"),
      { visibleSecurityAlerts, reviewSecurityAlert } =
        await import("../src/domain/monitoring");
    const f = await fixture();
    const subject = `private-${randomUUID()}@example.invalid`;
    for (let n = 0; n < 5; n++)
      await securitySignal({
        kind: "AUTH_FAILURE",
        subject,
        propertyId: f.property.id,
      });
    const alerts = await visibleSecurityAlerts(f.admin, f.property.id),
      a = alerts.find((a) => a.subjectHash === hash(subject))!;
    expect(a.severity).toBe("HIGH");
    expect(a.occurrences).toBe(5);
    expect(JSON.stringify(a)).not.toContain(subject);
    await reviewSecurityAlert(
      f.admin,
      a.id,
      "RESOLVED",
      "Synthetic incident investigated and resolved",
    );
    await securitySignal({
      kind: "AUTH_FAILURE",
      subject,
      propertyId: f.property.id,
    });
    expect(
      (await db.securityAlert.findUniqueOrThrow({ where: { id: a.id } })).state,
    ).toBe("OPEN");
    const other = await fixture();
    await expect(
      reviewSecurityAlert(
        other.admin,
        a.id,
        "RESOLVED",
        "Forged cross-property response",
      ),
    ).rejects.toThrow("FORBIDDEN");
    expect(
      await db.auditEvent.count({
        where: { objectId: a.id, action: "security.alert_reviewed" },
      }),
    ).toBe(1);
    await securitySignal({
      kind: "AUTH_FAILURE",
      subject: `global-${subject}`,
    });
    expect(
      (await visibleSecurityAlerts(f.admin, f.property.id)).every(
        (a) => a.propertyId === f.property.id,
      ),
    ).toBe(true);
  });
});

it("requires renewed consent when published tenancy conditions change before submission", async () => {
  const f = await fixture(),
    body =
      "Synthetic published tenancy conditions for a versioned application consent test.";
  const t = await db.leaseTemplate.create({
    data: {
      propertyId: f.property.id,
      version: 1,
      title: "Test conditions",
      body,
      hash: hash(body),
      approvedAt: new Date(),
    },
  });
  await expect(reserve(f.resident, hold(f.room.beds[0].id))).rejects.toThrow(
    "TENANCY_TERMS_CHANGED",
  );
  await reserve(f.resident, {
    ...hold(f.room.beds[0].id),
    tenancyTermsHash: hash(body),
  });
  expect(
    await db.consent.count({
      where: {
        userId: f.resident.id,
        purpose: "TENANCY_CONDITIONS",
        documentHash: hash(body),
        version: `template-${t.id}-v1`,
      },
    }),
  ).toBe(1);
});
