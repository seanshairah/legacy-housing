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
  if (rows[0].count > limit) throw new Error("RATE_LIMITED");
}
export async function issueChallenge(
  userId: string,
  kind: "EMAIL" | "PHONE" | "RESET",
) {
  const raw = token();
  await transaction(async (tx) => {
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
  });
}
export async function register(input: unknown) {
  const data = registrationSchema.parse(input);
  await rateLimit(`register:${data.email}`, 4);
  const { password, ...fields } = data;
  const user = await db.user.create({
    data: { ...fields, passwordHash: await passwordHash(password) },
  });
  await Promise.all([
    issueChallenge(user.id, "EMAIL"),
    issueChallenge(user.id, "PHONE"),
  ]);
  return user.id;
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
    if (c.kind === "RESET")
      await tx.session.deleteMany({ where: { userId: c.userId } });
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
  await rateLimit(`login:${email}`);
  const u = await db.user.findUnique({
    where: { email },
    include: { memberships: true },
  });
  const valid = await passwordMatches(password, u?.passwordHash || "");
  if (!u || !u.active || !valid) throw new Error("INVALID_CREDENTIALS");
  if (
    u.mfaConfirmed &&
    (!code || !verifyTotp(decrypt(u.mfaSecret!).toString(), code))
  )
    throw new Error("MFA_CODE_REQUIRED");
  if (u.memberships.length && !u.mfaConfirmed)
    throw new Error("STAFF_MFA_ENROLLMENT_REQUIRED");
  if (!u.passwordHash.startsWith("scrypt$131072$8$1$"))
    await db.user.update({
      where: { id: u.id },
      data: { passwordHash: await passwordHash(password) },
    });
  const raw = token();
  await transaction(async (tx) => {
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
  if (!raw) return null;
  const s = await db.session.findUnique({
    where: { tokenHash: hash(raw) },
    include: { user: { include: { memberships: true } } },
  });
  return s && s.expiresAt > new Date() && s.user.active ? s.user : null;
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
      where: { id: u.id, mfaConfirmed: false },
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
  await transaction(async (tx) => {
    const changed = await tx.user.updateMany({
      where: { id: u.id, mfaConfirmed: false, mfaSecret: u.mfaSecret },
      data: { mfaConfirmed: true },
    });
    if (changed.count !== 1) throw new Error("MFA_SETUP_CHANGED_REPEAT");
    await tx.session.deleteMany({ where: { userId: u.id } });
    await event(tx, u.id, null, "identity.mfa_enabled", u.id, {}, u.id);
  });
}
