import { randomBytes } from "node:crypto";
import { type Actor, permit, rolePermissions } from "./access";
import { securitySignal } from "../lib/security-monitor";
import { z } from "zod";
import { db, transaction } from "../lib/db";
import {
  hash,
  token,
  passwordHash,
  passwordMatches,
  encrypt,
  decrypt,
  verifyTotp,
  newTotpSecret,
} from "../lib/security";
import { event } from "./events";
export const registrationSchema = z
  .object({
    name: z.string().trim().min(2).max(120),
    email: z
      .string()
      .email()
      .transform((v) => v.toLowerCase()),
    phone: z.string().regex(/^\+[1-9]\d{7,14}$/),
    password: z.string().min(12).max(128),
    residentType: z.enum(["STUDENT", "PRIVATE"]),
    institution: z.string().max(120).optional(),
  })
  .refine((v) => v.residentType !== "STUDENT" || !!v.institution?.trim(), {
    message: "Students must provide an institution",
  });
export async function rateLimit(key: string, limit = 8) {
  const rows = await db.$queryRaw<
    { count: number }[]
  >`INSERT INTO "RateLimit" (key,count,"resetAt") VALUES (${key},1,NOW()+interval '15 minutes') ON CONFLICT (key) DO UPDATE SET count=CASE WHEN "RateLimit"."resetAt"<NOW() THEN 1 ELSE "RateLimit".count+1 END,"resetAt"=CASE WHEN "RateLimit"."resetAt"<NOW() THEN NOW()+interval '15 minutes' ELSE "RateLimit"."resetAt" END RETURNING count`;
  if (rows[0].count > limit) {
    await securitySignal({ kind: "RATE_LIMIT", subject: key });
    throw new Error("RATE_LIMITED");
  }
}
export async function issueChallenge(
  userId: string,
  kind: "EMAIL" | "PHONE" | "RESET",
) {
  const raw = token();
  await transaction(async (tx) => {
    await tx.challenge.updateMany({
      where: { userId, kind, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    await tx.challenge.create({
      data: {
        userId,
        kind,
        tokenHash: hash(raw),
        expiresAt: new Date(Date.now() + 20 * 60000),
      },
    });
    await tx.outboxEvent.create({
      data: {
        type: `identity.${kind.toLowerCase()}`,
        userId,
        traceId: token(),
        payload: { encrypted: encrypt(raw) },
      },
    });
    await event(tx, userId, null, "identity.challenge_issued", userId, {
      kind,
    });
  });
}
export async function register(input: unknown) {
  const data = registrationSchema.parse(input);
  await rateLimit(`register:${data.email}`, 4);
  const { password, ...fields } = data;
  const digest = await passwordHash(password);
  return transaction(async (tx) => {
    const user = await tx.user.create({
      data: { ...fields, passwordHash: digest },
    });
    for (const kind of ["EMAIL", "PHONE"] as const) {
      const raw = token();
      await tx.challenge.create({
        data: {
          userId: user.id,
          kind,
          tokenHash: hash(raw),
          expiresAt: new Date(Date.now() + 20 * 60000),
        },
      });
      await tx.outboxEvent.create({
        data: {
          type: `identity.${kind.toLowerCase()}`,
          userId: user.id,
          traceId: token(),
          payload: { encrypted: encrypt(raw) },
        },
      });
    }
    await event(tx, user.id, null, "identity.registered", user.id);
    return user.id;
  });
}
export async function consumeChallenge(raw: string, newPassword?: string) {
  if (!raw || raw.length > 100) throw new Error("INVALID_OR_EXPIRED_TOKEN");
  const password = newPassword
    ? await passwordHash(z.string().min(12).max(128).parse(newPassword))
    : undefined;
  return transaction(async (tx) => {
    const c = await tx.challenge.findUnique({
      where: { tokenHash: hash(raw) },
    });
    if (
      !c ||
      !["EMAIL", "PHONE", "RESET"].includes(c.kind) ||
      c.consumedAt ||
      c.expiresAt < new Date() ||
      (c.kind === "RESET" && !password)
    )
      throw new Error("INVALID_OR_EXPIRED_TOKEN");
    const claimed = await tx.challenge.updateMany({
      where: { id: c.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    if (claimed.count !== 1) throw new Error("INVALID_OR_EXPIRED_TOKEN");
    await tx.user.update({
      where: { id: c.userId },
      data:
        c.kind === "EMAIL"
          ? { emailVerifiedAt: new Date() }
          : c.kind === "PHONE"
            ? { phoneVerifiedAt: new Date() }
            : { passwordHash: password },
    });
    if (c.kind === "RESET") {
      await tx.session.deleteMany({ where: { userId: c.userId } });
      await tx.challenge.updateMany({
        where: { userId: c.userId, kind: "RESET", consumedAt: null },
        data: { consumedAt: new Date() },
      });
    }
    await event(
      tx,
      c.userId,
      null,
      `identity.${c.kind.toLowerCase()}.verified`,
      c.userId,
    );
  });
}
export async function login(email: string, password: string, code?: string) {
  email = z.string().email().parse(email).toLowerCase();
  password = z.string().min(1).max(128).parse(password);
  await rateLimit(`login:${email}`);
  const u = await db.user.findUnique({
    where: { email },
    include: {
      memberships: true,
      organisationMemberships: true,
      platformGrant: true,
    },
  });
  const valid = await passwordMatches(password, u?.passwordHash || "");
  if (!u || !u.active || !valid) {
    await securitySignal({ kind: "AUTH_FAILURE", subject: email });
    throw new Error("INVALID_CREDENTIALS");
  }
  if (
    u.mfaConfirmed &&
    (!code || !verifyTotp(decrypt(u.mfaSecret!).toString(), code))
  ) {
    await securitySignal({ kind: "AUTH_FAILURE", subject: email });
    throw new Error("MFA_CODE_REQUIRED");
  }
  if (
    (u.memberships.length ||
      u.organisationMemberships.length ||
      u.platformGrant) &&
    !u.mfaConfirmed
  )
    throw new Error("STAFF_MFA_ENROLLMENT_REQUIRED");
  const upgradedDigest = !u.passwordHash.startsWith("scrypt$131072$8$1$")
    ? await passwordHash(password)
    : undefined;
  const raw = token();
  await transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "User" WHERE id=${u.id} FOR UPDATE`;
    const current = await tx.user.findUniqueOrThrow({
      where: { id: u.id },
      include: {
        memberships: true,
        organisationMemberships: true,
        platformGrant: true,
      },
    });
    if (
      !current.active ||
      current.passwordHash !== u.passwordHash ||
      current.mfaConfirmed !== u.mfaConfirmed ||
      current.mfaSecret !== u.mfaSecret ||
      ((current.memberships.length ||
        current.organisationMemberships.length ||
        current.platformGrant) &&
        !current.mfaConfirmed)
    )
      throw new Error("IDENTITY_CHANGED_SIGN_IN_AGAIN");
    if (upgradedDigest)
      await tx.user.update({
        where: { id: u.id },
        data: { passwordHash: upgradedDigest },
      });
    await tx.session.create({
      data: {
        userId: u.id,
        tokenHash: hash(raw),
        expiresAt: new Date(Date.now() + 12 * 60 * 60000),
      },
    });
    await event(tx, u.id, null, "session.created", u.id);
  });
  return raw;
}
export async function session(raw?: string) {
  if (!raw || raw.length > 100) return null;
  const s = await db.session.findUnique({
    where: { tokenHash: hash(raw) },
    include: {
      user: {
        include: {
          memberships: true,
          organisationMemberships: true,
          platformGrant: true,
        },
      },
    },
  });
  if (!s || s.expiresAt <= new Date() || !s.user.active) return null;
  if (
    (s.user.memberships.length ||
      s.user.organisationMemberships.length ||
      s.user.platformGrant) &&
    !s.user.mfaConfirmed
  )
    return null;
  return s.user;
}
export async function enrollMfa(email: string, password: string) {
  email = z.string().email().parse(email).toLowerCase();
  password = z.string().min(1).max(128).parse(password);
  await rateLimit(`mfa-enroll:${email}`, 5);
  const u = await db.user.findUnique({ where: { email } }),
    valid = await passwordMatches(password, u?.passwordHash || "");
  if (!u || !u.active || u.mfaConfirmed || !valid)
    throw new Error("ENROLLMENT_DENIED");
  const secret = newTotpSecret(),
    encrypted = encrypt(secret);
  await transaction(async (tx) => {
    const changed = await tx.user.updateMany({
      where: {
        id: u.id,
        active: true,
        passwordHash: u.passwordHash,
        mfaConfirmed: false,
      },
      data: { mfaSecret: encrypted },
    });
    if (changed.count !== 1) throw new Error("MFA_SETUP_CHANGED_REPEAT");
    await event(
      tx,
      u.id,
      null,
      "identity.mfa_enrollment_started",
      u.id,
      {},
      u.id,
    );
  });
  return { secret, email: u.email };
}
export async function confirmMfa(
  email: string,
  password: string,
  code: string,
) {
  email = z.string().email().parse(email).toLowerCase();
  password = z.string().min(1).max(128).parse(password);
  await rateLimit(`mfa-confirm:${email}`, 5);
  const u = await db.user.findUnique({ where: { email } }),
    valid = await passwordMatches(password, u?.passwordHash || "");
  if (
    !u ||
    !u.active ||
    !u.mfaSecret ||
    u.mfaConfirmed ||
    !valid ||
    !verifyTotp(decrypt(u.mfaSecret).toString(), code)
  )
    throw new Error("MFA_VERIFICATION_FAILED");
  const recoveryCodes = newRecoveryCodes();
  await transaction(async (tx) => {
    const changed = await tx.user.updateMany({
      where: {
        id: u.id,
        active: true,
        passwordHash: u.passwordHash,
        mfaConfirmed: false,
        mfaSecret: u.mfaSecret,
      },
      data: { mfaConfirmed: true },
    });
    if (changed.count !== 1) throw new Error("MFA_SETUP_CHANGED_REPEAT");
    await tx.session.deleteMany({ where: { userId: u.id } });
    await replaceRecoveryCodes(tx, u.id, recoveryCodes);
    await event(tx, u.id, null, "identity.mfa_enabled", u.id, {}, u.id);
  });
  return { recoveryCodes };
}

// Recovery codes are high-entropy, one-use second factors. Raw values are returned
// only when generated, never persisted in a profile, audit row or notification.
function newRecoveryCodes() {
  return Array.from({ length: 10 }, () =>
    randomBytes(16)
      .toString("hex")
      .match(/.{1,8}/g)!
      .join("-"),
  );
}
function recoveryCodeHash(value: string) {
  const normalized = z
    .string()
    .trim()
    .regex(/^[a-f0-9]{8}(?:-[a-f0-9]{8}){3}$/i)
    .parse(value);
  return hash(normalized.toLowerCase());
}
async function replaceRecoveryCodes(
  tx: import("../lib/db").Tx,
  userId: string,
  codes: string[],
) {
  await tx.challenge.updateMany({
    where: { userId, kind: "MFA_RECOVERY", consumedAt: null },
    data: { consumedAt: new Date() },
  });
  await tx.challenge.createMany({
    data: codes.map((code) => ({
      userId,
      kind: "MFA_RECOVERY",
      tokenHash: recoveryCodeHash(code),
      expiresAt: new Date(Date.now() + 365 * 86400000),
    })),
  });
}
export async function regenerateRecoveryCodes(
  email: string,
  password: string,
  code: string,
) {
  email = z.string().email().parse(email).toLowerCase();
  password = z.string().min(1).max(128).parse(password);
  await rateLimit(`mfa-codes:${email}`, 5);
  const u = await db.user.findUnique({ where: { email } });
  const valid = await passwordMatches(password, u?.passwordHash || "");
  if (
    !u?.active ||
    !valid ||
    !u.mfaConfirmed ||
    !u.mfaSecret ||
    !verifyTotp(decrypt(u.mfaSecret).toString(), code)
  )
    throw new Error("MFA_VERIFICATION_FAILED");
  const recoveryCodes = newRecoveryCodes();
  await transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "User" WHERE id=${u.id} FOR UPDATE`;
    const current = await tx.user.findUniqueOrThrow({ where: { id: u.id } });
    if (
      !current.active ||
      !current.mfaConfirmed ||
      current.mfaSecret !== u.mfaSecret ||
      current.passwordHash !== u.passwordHash
    )
      throw new Error("IDENTITY_CHANGED_SIGN_IN_AGAIN");
    await replaceRecoveryCodes(tx, u.id, recoveryCodes);
    await tx.session.deleteMany({ where: { userId: u.id } });
    await event(
      tx,
      u.id,
      null,
      "identity.mfa_recovery_codes_replaced",
      u.id,
      {},
      u.id,
    );
  });
  return { recoveryCodes };
}
export async function recoverMfa(
  email: string,
  password: string,
  recoveryCode: string,
) {
  email = z.string().email().parse(email).toLowerCase();
  password = z.string().min(1).max(128).parse(password);
  await rateLimit(`mfa-recover:${email}`, 5);
  const u = await db.user.findUnique({ where: { email } });
  const valid = await passwordMatches(password, u?.passwordHash || "");
  if (!u?.active || !valid || !u.mfaConfirmed)
    throw new Error("MFA_RECOVERY_DENIED");
  let digest: string;
  try {
    digest = recoveryCodeHash(recoveryCode);
  } catch {
    throw new Error("MFA_RECOVERY_DENIED");
  }
  await transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "User" WHERE id=${u.id} FOR UPDATE`;
    const current = await tx.user.findUniqueOrThrow({ where: { id: u.id } });
    if (
      !current.active ||
      !current.mfaConfirmed ||
      current.passwordHash !== u.passwordHash ||
      current.mfaSecret !== u.mfaSecret
    )
      throw new Error("MFA_RECOVERY_DENIED");
    const claimed = await tx.challenge.updateMany({
      where: {
        userId: u.id,
        kind: "MFA_RECOVERY",
        tokenHash: digest,
        consumedAt: null,
        expiresAt: { gt: new Date() },
      },
      data: { consumedAt: new Date() },
    });
    if (claimed.count !== 1) throw new Error("MFA_RECOVERY_DENIED");
    await tx.user.update({
      where: { id: u.id },
      data: { mfaSecret: null, mfaConfirmed: false },
    });
    // A lost authenticator recovery ends every session and invalidates the whole
    // old recovery set. Staff access remains blocked until a new MFA enrollment.
    await tx.challenge.updateMany({
      where: { userId: u.id, kind: "MFA_RECOVERY", consumedAt: null },
      data: { consumedAt: new Date() },
    });
    await tx.session.deleteMany({ where: { userId: u.id } });
    await event(tx, u.id, null, "identity.mfa_recovered", u.id, {}, u.id);
  });
}

const invitationSchema = z.object({
  propertyId: z.string().min(1),
  email: z
    .string()
    .email()
    .transform((value) => value.toLowerCase()),
  role: z
    .string()
    .refine(
      (value) => Object.hasOwn(rolePermissions, value),
      "Select a supported staff role",
    ),
  reason: z.string().trim().min(10).max(2000),
});
export async function createInvitation(actor: Actor, input: unknown) {
  const d = invitationSchema.parse(input);
  await rateLimit(`invitation:${actor.id}`, 12);
  const raw = token();
  const invitation = await transaction(async (tx) => {
    await permit(actor, d.propertyId, "settings", tx);
    const creator = await tx.user.findUniqueOrThrow({
      where: { id: actor.id },
    });
    if (creator.email === d.email) throw new Error("SELF_INVITATION_DENIED");
    await tx.accountInvitation.updateMany({
      where: {
        propertyId: d.propertyId,
        email: d.email,
        role: d.role,
        acceptedAt: null,
        revokedAt: null,
      },
      data: { revokedAt: new Date() },
    });
    const invitation = await tx.accountInvitation.create({
      data: {
        propertyId: d.propertyId,
        email: d.email,
        role: d.role,
        tokenHash: hash(raw),
        invitedBy: actor.id,
        expiresAt: new Date(Date.now() + 48 * 60 * 60000),
      },
    });
    await event(
      tx,
      actor.id,
      d.propertyId,
      "identity.invitation_created",
      invitation.id,
      { role: d.role, reason: d.reason },
    );
    return invitation;
  });
  return { id: invitation.id, token: raw, expiresAt: invitation.expiresAt };
}
export async function listInvitations(actor: Actor, propertyId: string) {
  propertyId = z.string().min(1).parse(propertyId);
  await permit(actor, propertyId, "settings");
  return db.accountInvitation.findMany({
    where: { propertyId },
    orderBy: { createdAt: "desc" },
    take: 100,
    select: {
      id: true,
      email: true,
      role: true,
      expiresAt: true,
      acceptedAt: true,
      revokedAt: true,
      createdAt: true,
    },
  });
}
export async function revokeInvitation(
  actor: Actor,
  id: string,
  reason: string,
) {
  id = z.string().min(1).parse(id);
  reason = z.string().trim().min(10).max(2000).parse(reason);
  await transaction(async (tx) => {
    const invitation = await tx.accountInvitation.findUniqueOrThrow({
      where: { id },
    });
    await permit(actor, invitation.propertyId, "settings", tx);
    if (invitation.acceptedAt || invitation.revokedAt)
      throw new Error("INVITATION_NOT_PENDING");
    await tx.accountInvitation.update({
      where: { id },
      data: { revokedAt: new Date() },
    });
    await event(
      tx,
      actor.id,
      invitation.propertyId,
      "identity.invitation_revoked",
      id,
      { reason },
    );
  });
}
export async function acceptInvitation(input: unknown) {
  const d = z
    .object({
      email: z
        .string()
        .email()
        .transform((value) => value.toLowerCase()),
      password: z.string().min(1).max(128),
      code: z.string().regex(/^\d{6}$/),
      token: z.string().min(30).max(100),
    })
    .parse(input);
  await rateLimit(`invitation-accept:${d.email}`, 5);
  const user = await db.user.findUnique({ where: { email: d.email } });
  const valid = await passwordMatches(d.password, user?.passwordHash || "");
  if (
    !user?.active ||
    !valid ||
    !user.emailVerifiedAt ||
    !user.phoneVerifiedAt ||
    !user.mfaConfirmed ||
    !user.mfaSecret ||
    !verifyTotp(decrypt(user.mfaSecret).toString(), d.code)
  )
    throw new Error("INVITATION_VERIFIED_MFA_ACCOUNT_REQUIRED");
  await transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "User" WHERE id=${user.id} FOR UPDATE`;
    const current = await tx.user.findUniqueOrThrow({ where: { id: user.id } });
    if (
      !current.active ||
      !current.emailVerifiedAt ||
      !current.phoneVerifiedAt ||
      !current.mfaConfirmed ||
      current.mfaSecret !== user.mfaSecret ||
      current.passwordHash !== user.passwordHash
    )
      throw new Error("IDENTITY_CHANGED_SIGN_IN_AGAIN");
    const invitation = await tx.accountInvitation.findUnique({
      where: { tokenHash: hash(d.token) },
    });
    if (
      !invitation ||
      invitation.email !== current.email ||
      invitation.acceptedAt ||
      invitation.revokedAt ||
      invitation.expiresAt <= new Date() ||
      !Object.hasOwn(rolePermissions, invitation.role)
    )
      throw new Error("INVITATION_INVALID_OR_EXPIRED");
    // Revoking the inviter's administration grant invalidates outstanding invites.
    await permit(
      { id: invitation.invitedBy },
      invitation.propertyId,
      "settings",
      tx,
    );
    const claimed = await tx.accountInvitation.updateMany({
      where: {
        id: invitation.id,
        acceptedAt: null,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      data: { acceptedAt: new Date(), acceptedBy: current.id },
    });
    if (claimed.count !== 1) throw new Error("INVITATION_INVALID_OR_EXPIRED");
    await tx.membership.upsert({
      where: {
        userId_propertyId_role: {
          userId: current.id,
          propertyId: invitation.propertyId,
          role: invitation.role,
        },
      },
      create: {
        userId: current.id,
        propertyId: invitation.propertyId,
        role: invitation.role,
      },
      update: {},
    });
    await tx.session.deleteMany({ where: { userId: current.id } });
    await event(
      tx,
      current.id,
      invitation.propertyId,
      "identity.invitation_accepted",
      invitation.id,
      { role: invitation.role, invitedBy: invitation.invitedBy },
      current.id,
    );
  });
}
