import { createHash, timingSafeEqual } from "node:crypto";
import { db, transaction } from "../lib/db";
import { hash, decrypt, encrypt } from "../lib/security";
import { organisationPaynowConfiguration } from "./organisations";
import { type Actor, ownerOrPermit } from "./access";
import { settleProvider, minor, recordProviderRefund } from "./finance";
import { event } from "./events";
const host = "www.paynow.co.zw";
export function paynowHash(fields: Record<string, string>, key: string) {
  return createHash("sha512")
    .update(
      Object.entries(fields)
        .filter(([k]) => k.toLowerCase() !== "hash")
        .map(([, v]) => v)
        .join("") + key.toLowerCase(),
    )
    .digest("hex")
    .toUpperCase();
}
export function verifyPaynow(fields: Record<string, string>, key: string) {
  const provided = fields.hash?.toUpperCase() || "";
  const expected = paynowHash(fields, key);
  return (
    /^[A-F0-9]{128}$/.test(provided) &&
    timingSafeEqual(Buffer.from(provided), Buffer.from(expected))
  );
}
export function trustedPaynowUrl(raw: string) {
  const u = new URL(raw);
  if (
    u.protocol !== "https:" ||
    u.hostname !== host ||
    u.username ||
    u.password ||
    u.port ||
    u.hash
  )
    throw new Error("UNTRUSTED_PROVIDER_URL");
  return u;
}
async function config(propertyId: string, encryptedSnapshot?: string | null) {
  const organisation = await organisationPaynowConfiguration(propertyId);
  let credentials: {
    integrationId: string;
    integrationKey: string;
    currency: string;
  };
  if (encryptedSnapshot)
    credentials = JSON.parse(decrypt(encryptedSnapshot).toString());
  else if (organisation.credentials) {
    if (organisation.mode !== "live")
      throw new Error("PAYNOW_READY_FOR_CREDENTIALS");
    credentials = organisation.credentials;
  } else {
    // Compatibility is explicitly limited to the original dedicated client.
    // A newly provisioned organisation can never inherit another merchant's keys.
    if (
      organisation.organisationId !== "mipf" ||
      process.env.PAYNOW_MODE !== "live" ||
      !process.env.PAYNOW_INTEGRATION_ID ||
      !process.env.PAYNOW_INTEGRATION_KEY
    )
      throw new Error("PAYNOW_READY_FOR_CREDENTIALS");
    credentials = {
      integrationId: process.env.PAYNOW_INTEGRATION_ID,
      integrationKey: process.env.PAYNOW_INTEGRATION_KEY,
      currency: process.env.PAYNOW_CURRENCY || "",
    };
  }
  const app = new URL(process.env.APP_URL!);
  if (app.protocol !== "https:") throw new Error("PUBLIC_HTTPS_URL_REQUIRED");
  if (credentials.currency !== "USD")
    throw new Error("MERCHANT_CURRENCY_MUST_BE_VERIFIED");
  return {
    id: credentials.integrationId,
    key: credentials.integrationKey,
    currency: credentials.currency,
    encrypted: encryptedSnapshot || encrypt(JSON.stringify(credentials)),
    app: app.origin,
  };
}
async function providerPost(url: URL, fields: Record<string, string>) {
  const response = await fetch(url, {
    method: "POST",
    body: new URLSearchParams(fields),
    signal: AbortSignal.timeout(20000),
    redirect: "error",
  });
  if (!response.ok) throw new Error("PROVIDER_UNAVAILABLE");
  const text = await response.text();
  if (text.length > 32000) throw new Error("PROVIDER_RESPONSE_LIMIT");
  return Object.fromEntries(new URLSearchParams(text));
}
export async function initiatePaynow(actor: Actor, id: string) {
  const p = await db.payment.findUniqueOrThrow({
    where: { id },
    include: { user: true },
  });
  await ownerOrPermit(actor, p.userId, p.propertyId, "finance");
  const c = await config(p.propertyId, p.providerConfigEncrypted);
  if (
    p.method !== "PAYNOW" ||
    p.status !== "PENDING" ||
    p.currency !== c.currency
  )
    throw new Error("INVALID_PAYMENT");
  if (p.redirectUrl) return trustedPaynowUrl(p.redirectUrl).toString();
  const claim = await db.payment.updateMany({
    where: { id: p.id, status: "PENDING", pollUrl: null },
    data: { status: "INITIATING", providerConfigEncrypted: c.encrypted },
  });
  if (claim.count !== 1)
    throw new Error("PRIOR_INITIATION_REQUIRES_RECONCILIATION");
  const fields: Record<string, string> = {
    id: c.id,
    reference: p.reference,
    amount: `${p.amountMinor / 100n}.${String(p.amountMinor % 100n).padStart(2, "0")}`,
    additionalinfo: "Accommodation invoice",
    returnurl: `${c.app}/portal?payment=${p.id}`,
    resulturl: `${c.app}/api/v1/paynow/result`,
    authemail: p.user.email,
    status: "Message",
  };
  fields.hash = paynowHash(fields, c.key);
  try {
    const result = await providerPost(
      new URL(`https://${host}/interface/initiatetransaction`),
      fields,
    );
    if (!verifyPaynow(result, c.key) || result.status?.toLowerCase() !== "ok")
      throw new Error("PROVIDER_INITIATION_UNVERIFIED");
    const pollUrl = trustedPaynowUrl(result.pollurl).toString(),
      redirectUrl = trustedPaynowUrl(result.browserurl).toString();
    await db.payment.updateMany({
      where: { id, status: "INITIATING" },
      data: {
        pollUrl,
        redirectUrl,
        status: "PENDING",
        providerId: result.paynowreference || null,
      },
    });
    const current = await db.payment.findUniqueOrThrow({ where: { id } });
    return current.status === "PAID" ? `${c.app}/portal` : redirectUrl;
  } catch (error) {
    await transaction(async (tx) => {
      const changed = await tx.payment.updateMany({
        where: { id, status: "INITIATING" },
        data: { status: "INITIATION_UNKNOWN" },
      });
      if (changed.count)
        await event(
          tx,
          actor.id,
          p.propertyId,
          "payment.initiation_ambiguous",
          id,
          {},
          p.userId,
        );
    });
    throw error;
  }
}
export async function reconcilePaynow(id: string) {
  const p = await db.payment.findUniqueOrThrow({ where: { id } }),
    c = await config(p.propertyId, p.providerConfigEncrypted);
  if (!p.pollUrl) throw new Error("POLL_URL_REQUIRED");
  const result = await providerPost(trustedPaynowUrl(p.pollUrl), {});
  if (
    !verifyPaynow(result, c.key) ||
    result.reference !== p.reference ||
    !result.paynowreference ||
    (p.providerId && result.paynowreference !== p.providerId) ||
    minor(result.amount) !== p.amountMinor
  )
    throw new Error("PROVIDER_CONFIRMATION_MISMATCH");
  await db.payment.updateMany({
    where: { id, providerId: null },
    data: { providerId: result.paynowreference },
  });
  await db.payment.updateMany({
    where: { id, status: { in: ["INITIATING", "INITIATION_UNKNOWN"] } },
    data: { status: "PENDING" },
  });
  const status = result.status?.toLowerCase();
  if (["paid", "awaiting delivery", "delivered"].includes(status))
    return settleProvider(
      p.id,
      result.paynowreference,
      hash(JSON.stringify(result)),
    );
  if (["cancelled", "failed"].includes(status))
    await transaction(async (tx) => {
      const changed = await tx.payment.updateMany({
        where: { id, status: "PENDING" },
        data: { status: status.toUpperCase() },
      });
      if (changed.count)
        await event(
          tx,
          "paynow",
          p.propertyId,
          "payment.failed",
          id,
          {},
          p.userId,
        );
    });
  if (status === "refunded")
    await recordProviderRefund(
      p.id,
      result.paynowreference,
      hash(JSON.stringify(result)),
    );
}
export async function callback(fields: Record<string, string>) {
  const p = await db.payment.findUnique({
    where: { reference: fields.reference || "" },
  });
  if (!p) throw new Error("UNKNOWN_PAYMENT");
  if (p.method !== "PAYNOW") throw new Error("INVALID_PAYMENT");
  const c = await config(p.propertyId, p.providerConfigEncrypted);
  if (!verifyPaynow(fields, c.key))
    throw new Error("INVALID_WEBHOOK_SIGNATURE");
  if (
    !fields.paynowreference ||
    (p.providerId && p.providerId !== fields.paynowreference) ||
    minor(fields.amount) !== p.amountMinor
  )
    throw new Error("PROVIDER_CONFIRMATION_MISMATCH");
  const payloadHash = hash(JSON.stringify(fields));
  await transaction(async (tx) => {
    const existing = await tx.inboxEvent.findUnique({
      where: {
        provider_externalId: { provider: "PAYNOW", externalId: payloadHash },
      },
    });
    if (existing) return;
    if (!p.pollUrl && fields.pollurl)
      await tx.payment.updateMany({
        where: { id: p.id, pollUrl: null },
        data: {
          pollUrl: trustedPaynowUrl(fields.pollurl).toString(),
          providerId: fields.paynowreference,
        },
      });
    await tx.inboxEvent.create({
      data: { provider: "PAYNOW", externalId: payloadHash, payloadHash },
    });
    await tx.outboxEvent.create({
      data: {
        type: "paynow.reconcile",
        userId: p.userId,
        propertyId: p.propertyId,
        payload: { paymentId: p.id },
        traceId: payloadHash,
      },
    });
  });
}
