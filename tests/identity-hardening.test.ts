import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { db } from "../src/lib/db";
import { assertTestDatabase } from "./safety";
import {
  hash,
  passwordHash,
  newTotpSecret,
  encrypt,
  totp,
  verifyTotp,
  token,
} from "../src/lib/security";
import {
  confirmMfa,
  enrollMfa,
  recoverMfa,
  regenerateRecoveryCodes,
  login,
  session,
  consumeChallenge,
  createInvitation,
  acceptInvitation,
  revokeInvitation,
  listInvitations,
} from "../src/domain/identity";
assertTestDatabase();
process.env.DATA_KEY ||= randomBytes(32).toString("hex");
const password = "Isolated identity regression password 2026!";
let digest = "",
  serial = 0;
beforeAll(async () => {
  digest = await passwordHash(password);
});
afterAll(async () => {
  await db.$disconnect();
});
async function fixture() {
  const key = randomUUID();
  const property = await db.property.create({
    data: {
      name: "Synthetic identity test",
      slug: `identity-${key}`,
      description: "Synthetic identity regression property",
      location: "Test only",
    },
  });
  async function person(label: string, mfa = false) {
    const secret = newTotpSecret();
    const user = await db.user.create({
      data: {
        email: `${label}-${key}@example.invalid`,
        name: `Synthetic ${label}`,
        phone: `+2637${Date.now().toString().slice(-7)}${String(serial++).padStart(3, "0")}`,
        passwordHash: digest,
        emailVerifiedAt: new Date(),
        phoneVerifiedAt: new Date(),
        ...(mfa ? { mfaConfirmed: true, mfaSecret: encrypt(secret) } : {}),
      },
    });
    return { ...user, secret };
  }
  const admin = await person("admin", true),
    resident = await person("resident"),
    other = await person("other", true);
  await db.membership.create({
    data: { userId: admin.id, propertyId: property.id, role: "ADMIN" },
  });
  return { property, admin, resident, other };
}
async function configure(user: { email: string }) {
  const enrollment = await enrollMfa(user.email, password);
  const result = await confirmMfa(
    user.email,
    password,
    totp(enrollment.secret).generate(),
  );
  return { secret: enrollment.secret, codes: result.recoveryCodes };
}
function invalidTotp(secret: string) {
  for (let value = 0; value < 10; value++) {
    const candidate = value.toString().padStart(6, "0");
    if (!verifyTotp(secret, candidate)) return candidate;
  }
  throw new Error("Unable to construct an invalid test authenticator code");
}
async function invitation(
  f: Awaited<ReturnType<typeof fixture>>,
  email = f.other.email,
) {
  return createInvitation(f.admin, {
    propertyId: f.property.id,
    email,
    role: "FINANCE",
    reason: "Synthetic approved staffing requirement",
  });
}
function acceptance(f: Awaited<ReturnType<typeof fixture>>, raw: string) {
  return {
    email: f.other.email,
    password,
    code: totp(f.other.secret).generate(),
    token: raw,
  };
}

describe("MFA recovery and session security", () => {
  it("issues ten hashed recovery codes once, requires current factors to rotate and invalidates old codes and sessions", async () => {
    const f = await fixture(),
      mfa = await configure(f.resident);
    expect(mfa.codes).toHaveLength(10);
    expect(new Set(mfa.codes).size).toBe(10);
    const stored = await db.challenge.findMany({
      where: { userId: f.resident.id, kind: "MFA_RECOVERY" },
    });
    expect(stored).toHaveLength(10);
    expect(stored.every((c) => /^[a-f0-9]{64}$/.test(c.tokenHash))).toBe(true);
    for (const code of mfa.codes)
      expect(JSON.stringify(stored)).not.toContain(code);
    const raw = await login(
      f.resident.email,
      password,
      totp(mfa.secret).generate(),
    );
    await expect(
      regenerateRecoveryCodes(
        f.resident.email,
        "Wrong regression password",
        totp(mfa.secret).generate(),
      ),
    ).rejects.toThrow("MFA_VERIFICATION_FAILED");
    await expect(
      regenerateRecoveryCodes(
        f.resident.email,
        password,
        invalidTotp(mfa.secret),
      ),
    ).rejects.toThrow("MFA_VERIFICATION_FAILED");
    const replacement = await regenerateRecoveryCodes(
      f.resident.email,
      password,
      totp(mfa.secret).generate(),
    );
    expect(replacement.recoveryCodes).toHaveLength(10);
    expect(await session(raw)).toBeNull();
    await expect(
      recoverMfa(f.resident.email, password, mfa.codes[0]),
    ).rejects.toThrow("MFA_RECOVERY_DENIED");
    expect(
      await db.challenge.count({
        where: {
          userId: f.resident.id,
          kind: "MFA_RECOVERY",
          consumedAt: null,
        },
      }),
    ).toBe(10);
    expect(
      await db.auditEvent.count({
        where: {
          actorId: f.resident.id,
          action: "identity.mfa_recovery_codes_replaced",
        },
      }),
    ).toBe(1);
  });
  it("recovers a lost second factor only with password and saved code, revokes all sessions and requires staff re-enrollment", async () => {
    const f = await fixture(),
      mfa = await configure(f.resident);
    await db.membership.create({
      data: {
        userId: f.resident.id,
        propertyId: f.property.id,
        role: "CARETAKER",
      },
    });
    const stolen = await login(
      f.resident.email,
      password,
      totp(mfa.secret).generate(),
    );
    await expect(
      recoverMfa(f.resident.email, "Wrong regression password", mfa.codes[0]),
    ).rejects.toThrow("MFA_RECOVERY_DENIED");
    await expect(
      recoverMfa(
        f.resident.email,
        password,
        "00000000-00000000-00000000-00000000",
      ),
    ).rejects.toThrow("MFA_RECOVERY_DENIED");
    expect(await session(stolen)).not.toBeNull();
    await recoverMfa(f.resident.email, password, mfa.codes[0]);
    expect(await session(stolen)).toBeNull();
    const current = await db.user.findUniqueOrThrow({
      where: { id: f.resident.id },
    });
    expect(current.mfaConfirmed).toBe(false);
    expect(current.mfaSecret).toBeNull();
    expect(
      await db.challenge.count({
        where: { userId: current.id, kind: "MFA_RECOVERY", consumedAt: null },
      }),
    ).toBe(0);
    await expect(login(current.email, password)).rejects.toThrow(
      "STAFF_MFA_ENROLLMENT_REQUIRED",
    );
    const replacement = await configure(current);
    await expect(
      recoverMfa(current.email, password, mfa.codes[1]),
    ).rejects.toThrow("MFA_RECOVERY_DENIED");
    expect(
      await session(
        await login(
          current.email,
          password,
          totp(replacement.secret).generate(),
        ),
      ),
    ).not.toBeNull();
  });
  it("allows only one concurrent recovery and prevents ordinary challenge verification from consuming recovery factors", async () => {
    const f = await fixture(),
      mfa = await configure(f.resident);
    await expect(consumeChallenge(mfa.codes[0])).rejects.toThrow(
      "INVALID_OR_EXPIRED_TOKEN",
    );
    const results = await Promise.allSettled([
      recoverMfa(f.resident.email, password, mfa.codes[0]),
      recoverMfa(f.resident.email, password, mfa.codes[0]),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(
      await db.auditEvent.count({
        where: { actorId: f.resident.id, action: "identity.mfa_recovered" },
      }),
    ).toBe(1);
  });
  it("rejects forged, expired, inactive and revoked sessions and issues a distinct token on each sign-in", async () => {
    const f = await fixture(),
      first = await login(f.resident.email, password),
      second = await login(f.resident.email, password);
    expect(first).not.toBe(second);
    expect(await session(token())).toBeNull();
    expect(await session("x".repeat(101))).toBeNull();
    expect(await session(first)).not.toBeNull();
    await db.session.updateMany({
      where: { tokenHash: hash(first) },
      data: { expiresAt: new Date(0) },
    });
    expect(await session(first)).toBeNull();
    await db.user.update({
      where: { id: f.resident.id },
      data: { active: false },
    });
    expect(await session(second)).toBeNull();
    await db.user.update({
      where: { id: f.resident.id },
      data: { active: true },
    });
    await db.session.deleteMany({ where: { userId: f.resident.id } });
    expect(await session(second)).toBeNull();
  });
  it("requires confirmed MFA for organisation-only administrators and platform operators, including previously issued sessions", async () => {
    const f = await fixture(),
      raw = await login(f.resident.email, password);
    await db.organisationMembership.create({
      data: { organisationId: "mipf", userId: f.resident.id, role: "ADMIN" },
    });
    expect(await session(raw)).toBeNull();
    await expect(login(f.resident.email, password)).rejects.toThrow(
      "STAFF_MFA_ENROLLMENT_REQUIRED",
    );
    const mfa = await configure(f.resident);
    expect(
      await session(
        await login(f.resident.email, password, totp(mfa.secret).generate()),
      ),
    ).not.toBeNull();
    const platformRaw = await login(
      f.other.email,
      password,
      totp(f.other.secret).generate(),
    );
    await db.platformGrant.create({
      data: { userId: f.other.id, role: "OPERATOR" },
    });
    await db.user.update({
      where: { id: f.other.id },
      data: { mfaConfirmed: false },
    });
    expect(await session(platformRaw)).toBeNull();
    await expect(login(f.other.email, password)).rejects.toThrow(
      "STAFF_MFA_ENROLLMENT_REQUIRED",
    );
  });
  it("invalidates every older password-reset token after a password change", async () => {
    const f = await fixture(),
      first = token(),
      second = token();
    await db.challenge.createMany({
      data: [first, second].map((raw) => ({
        userId: f.resident.id,
        kind: "RESET",
        tokenHash: hash(raw),
        expiresAt: new Date(Date.now() + 60000),
      })),
    });
    const previous = await login(f.resident.email, password);
    await consumeChallenge(
      first,
      "A replaced strong regression password 2026!",
    );
    expect(await session(previous)).toBeNull();
    await expect(consumeChallenge(second, password)).rejects.toThrow(
      "INVALID_OR_EXPIRED_TOKEN",
    );
    expect(
      await db.challenge.count({
        where: { userId: f.resident.id, kind: "RESET", consumedAt: null },
      }),
    ).toBe(0);
  });
  it("rejects expired recovery factors without changing identity or consuming another code", async () => {
    const f = await fixture(),
      mfa = await configure(f.resident);
    await db.challenge.updateMany({
      where: { userId: f.resident.id, tokenHash: hash(mfa.codes[0]) },
      data: { expiresAt: new Date(0) },
    });
    await expect(
      recoverMfa(f.resident.email, password, mfa.codes[0]),
    ).rejects.toThrow("MFA_RECOVERY_DENIED");
    expect(
      (await db.user.findUniqueOrThrow({ where: { id: f.resident.id } }))
        .mfaConfirmed,
    ).toBe(true);
    expect(
      await db.challenge.count({
        where: {
          userId: f.resident.id,
          kind: "MFA_RECOVERY",
          consumedAt: null,
        },
      }),
    ).toBe(10);
  });
});

describe("single-use property staff invitations", () => {
  it("stores only the invitation hash and enforces property administration on creation, listing and revocation", async () => {
    const a = await fixture(),
      b = await fixture();
    await expect(
      createInvitation(a.other, {
        propertyId: a.property.id,
        email: a.resident.email,
        role: "FINANCE",
        reason: "Unauthorised synthetic invitation",
      }),
    ).rejects.toThrow("FORBIDDEN");
    await expect(
      createInvitation(a.admin, {
        propertyId: b.property.id,
        email: a.resident.email,
        role: "FINANCE",
        reason: "Cross-property synthetic invitation",
      }),
    ).rejects.toThrow("FORBIDDEN");
    const issued = await invitation(a),
      row = await db.accountInvitation.findUniqueOrThrow({
        where: { id: issued.id },
      });
    expect(row.tokenHash).toBe(hash(issued.token));
    expect(JSON.stringify(row)).not.toContain(issued.token);
    const listed = await listInvitations(a.admin, a.property.id);
    expect(listed.map((i) => i.id)).toContain(row.id);
    expect(JSON.stringify(listed)).not.toContain(row.tokenHash);
    await expect(listInvitations(b.admin, a.property.id)).rejects.toThrow(
      "FORBIDDEN",
    );
    await expect(
      revokeInvitation(b.admin, row.id, "Cross-property revocation must fail"),
    ).rejects.toThrow("FORBIDDEN");
    await expect(
      createInvitation(a.admin, {
        propertyId: a.property.id,
        email: a.admin.email,
        role: "FINANCE",
        reason: "Self elevation invitation must fail",
      }),
    ).rejects.toThrow("SELF_INVITATION_DENIED");
  });
  it("requires matching email, both verified contacts, password and confirmed TOTP before atomically granting a role", async () => {
    const f = await fixture(),
      issued = await invitation(f);
    await expect(
      acceptInvitation({
        ...acceptance(f, issued.token),
        email: f.admin.email,
        code: totp(f.admin.secret).generate(),
      }),
    ).rejects.toThrow("INVITATION_INVALID_OR_EXPIRED");
    await expect(
      acceptInvitation({
        ...acceptance(f, issued.token),
        password: "Wrong regression password",
      }),
    ).rejects.toThrow("INVITATION_VERIFIED_MFA_ACCOUNT_REQUIRED");
    await expect(
      acceptInvitation({
        ...acceptance(f, issued.token),
        code: invalidTotp(f.other.secret),
      }),
    ).rejects.toThrow("INVITATION_VERIFIED_MFA_ACCOUNT_REQUIRED");
    await db.user.update({
      where: { id: f.other.id },
      data: { phoneVerifiedAt: null },
    });
    await expect(acceptInvitation(acceptance(f, issued.token))).rejects.toThrow(
      "INVITATION_VERIFIED_MFA_ACCOUNT_REQUIRED",
    );
    await db.user.update({
      where: { id: f.other.id },
      data: { phoneVerifiedAt: new Date() },
    });
    const previous = await login(
      f.other.email,
      password,
      totp(f.other.secret).generate(),
    );
    await acceptInvitation(acceptance(f, issued.token));
    expect(await session(previous)).toBeNull();
    expect(
      await db.membership.count({
        where: {
          userId: f.other.id,
          propertyId: f.property.id,
          role: "FINANCE",
        },
      }),
    ).toBe(1);
    const row = await db.accountInvitation.findUniqueOrThrow({
      where: { id: issued.id },
    });
    expect(row.acceptedBy).toBe(f.other.id);
    expect(row.acceptedAt).not.toBeNull();
    expect(
      await db.auditEvent.count({
        where: { objectId: issued.id, action: "identity.invitation_accepted" },
      }),
    ).toBe(1);
    await expect(acceptInvitation(acceptance(f, issued.token))).rejects.toThrow(
      "INVITATION_INVALID_OR_EXPIRED",
    );
  });
  it("deduplicates simultaneous acceptance and revokes superseded or explicitly revoked invitations", async () => {
    const f = await fixture(),
      superseded = await invitation(f),
      current = await invitation(f);
    await expect(
      acceptInvitation(acceptance(f, superseded.token)),
    ).rejects.toThrow("INVITATION_INVALID_OR_EXPIRED");
    const results = await Promise.allSettled([
      acceptInvitation(acceptance(f, current.token)),
      acceptInvitation(acceptance(f, current.token)),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(
      await db.membership.count({
        where: {
          userId: f.other.id,
          propertyId: f.property.id,
          role: "FINANCE",
        },
      }),
    ).toBe(1);
    const revoked = await invitation(f, f.resident.email);
    await revokeInvitation(
      f.admin,
      revoked.id,
      "Recipient no longer needs synthetic staff access",
    );
    const mfa = await configure(f.resident);
    await expect(
      acceptInvitation({
        email: f.resident.email,
        password,
        code: totp(mfa.secret).generate(),
        token: revoked.token,
      }),
    ).rejects.toThrow("INVITATION_INVALID_OR_EXPIRED");
  });
  it("rejects expired invitations and invitations whose creator no longer has administration authority", async () => {
    const f = await fixture(),
      expired = await invitation(f);
    await db.accountInvitation.update({
      where: { id: expired.id },
      data: {
        createdAt: new Date(Date.now() - 3 * 86400000),
        expiresAt: new Date(Date.now() - 86400000),
      },
    });
    await expect(
      acceptInvitation(acceptance(f, expired.token)),
    ).rejects.toThrow("INVITATION_INVALID_OR_EXPIRED");
    const revokedGrant = await invitation(f);
    await db.membership.deleteMany({
      where: { userId: f.admin.id, propertyId: f.property.id },
    });
    await expect(
      acceptInvitation(acceptance(f, revokedGrant.token)),
    ).rejects.toThrow("FORBIDDEN");
    expect(
      await db.membership.count({
        where: { userId: f.other.id, propertyId: f.property.id },
      }),
    ).toBe(0);
  });
});
