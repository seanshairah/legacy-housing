import {
  randomBytes,
  createHash,
  scrypt as scryptCallback,
  timingSafeEqual,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
import * as OTPAuth from "otpauth";
function derive(
  password: string,
  salt: string,
  cost = 131072,
): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scryptCallback(
      password,
      salt,
      64,
      { N: cost, r: 8, p: 1, maxmem: 192 * 1024 * 1024 },
      (error, key) => (error ? reject(error) : resolve(key)),
    ),
  );
}
export const hash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
export const token = () => randomBytes(32).toString("base64url");
export async function passwordHash(password: string) {
  const salt = randomBytes(16).toString("hex");
  const derived = await derive(password, salt);
  return `scrypt$131072$8$1$${salt}$${derived.toString("hex")}`;
}
export async function passwordMatches(password: string, stored: string) {
  const modern = stored.startsWith("scrypt$131072$8$1$");
  const parts = stored.split(modern ? "$" : ":"),
    salt = modern ? parts[4] : parts[1],
    key = modern ? parts[5] : parts[2];
  const derived = await derive(
    password,
    salt || "invalid-salt",
    modern || !stored ? 131072 : 16384,
  );
  const expected = key ? Buffer.from(key, "hex") : Buffer.alloc(64);
  return (
    expected.length === derived.length && timingSafeEqual(derived, expected)
  );
}
function key(name: string) {
  const value = process.env[name];
  if (!value || !/^[a-f0-9]{64}$/i.test(value))
    throw new Error(`${name}_REQUIRES_32_BYTE_HEX_KEY`);
  return Buffer.from(value, "hex");
}
export function encrypt(value: Buffer | string, name = "DATA_KEY") {
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key(name), iv);
  return Buffer.concat([
    iv,
    cipher.update(value),
    cipher.final(),
    cipher.getAuthTag(),
  ]).toString("base64");
}
export function decrypt(value: string, name = "DATA_KEY") {
  const packed = Buffer.from(value, "base64"),
    decipher = createDecipheriv(
      "aes-256-gcm",
      key(name),
      packed.subarray(0, 12),
    );
  decipher.setAuthTag(packed.subarray(-16));
  return Buffer.concat([
    decipher.update(packed.subarray(12, -16)),
    decipher.final(),
  ]);
}
export function totp(secret: string) {
  return new OTPAuth.TOTP({
    issuer: "Legacy Heights",
    label: "Account",
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secret),
  });
}
export function verifyTotp(secret: string, code: string) {
  return (
    /^\d{6}$/.test(code) &&
    totp(secret).validate({ token: code, window: 1 }) !== null
  );
}
export const newTotpSecret = () => new OTPAuth.Secret({ size: 20 }).base32;
export function assertSameOrigin(request: Request) {
  const expected = new URL(process.env.APP_URL || "http://localhost:3001")
    .origin;
  if (request.headers.get("origin") !== expected)
    throw new Error("CSRF_ORIGIN_REJECTED");
}
export function safeText(value: string) {
  return value.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
}
