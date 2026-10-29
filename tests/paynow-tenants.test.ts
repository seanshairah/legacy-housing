import { it, expect, vi, afterEach } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { db } from "../src/lib/db";
import { fullFixture } from "./browser/support";
import { reserve } from "../src/domain/inventory";
import { issueCharge, proposePayment } from "../src/domain/finance";
import { configureOrganisationPaynow } from "../src/domain/organisations";
import {
  initiatePaynow,
  callback,
  reconcilePaynow,
  paynowHash,
  verifyPaynow,
} from "../src/domain/paynow";
process.env.DATA_KEY ||= randomBytes(32).toString("hex");
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it("merchant credentials are isolated by organisation and existing intents retain their original key after rotation", async () => {
  vi.stubEnv("APP_URL", "https://example.invalid");
  vi.stubEnv("PAYNOW_MODE", "live");
  vi.stubEnv("PAYNOW_INTEGRATION_ID", "legacy-must-not-be-used");
  vi.stubEnv("PAYNOW_INTEGRATION_KEY", "legacy-must-not-be-used");
  vi.stubEnv("PAYNOW_CURRENCY", "USD");
  const make = async (suffix: string) => {
    const organisation = await db.organisation.create({
      data: {
        name: `Synthetic merchant ${suffix}`,
        slug: `merchant-${randomUUID()}`,
        legalEntity: "Synthetic entity",
      },
    });
    const f = await fullFixture(organisation.id);
    await reserve(f.people.RESIDENT, {
      bedId: f.room.beds[0].id,
      startAt: f.start,
      endAt: f.end,
      consent: true,
      termsVersion: "application-policy-v1",
    });
    await issueCharge(f.people.FINANCE, {
      userId: f.people.RESIDENT.id,
      propertyId: f.property.id,
      category: "RENT",
      reference: `INV-${f.run}`,
      description: "Synthetic tenant merchant invoice",
      amount: "20.00",
      dueAt: f.start,
    });
    return { organisation, f };
  };
  const a = await make("A"),
    b = await make("B");
  const keys = new Map([
    ["merchant-a", "secret-key-merchant-a"],
    ["merchant-b", "secret-key-merchant-b"],
    ["merchant-a-new", "rotated-key-merchant-a"],
  ]);
  for (const [fixture, integrationId] of [
    [a, "merchant-a"],
    [b, "merchant-b"],
  ] as const)
    await configureOrganisationPaynow(
      fixture.f.people.ADMIN,
      fixture.organisation.id,
      {
        mode: "live",
        credentials: {
          integrationId,
          integrationKey: keys.get(integrationId),
          currency: "USD",
        },
      },
    );
  const intents = new Map<
    string,
    { key: string; amount: string; provider: string }
  >();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: URL, init: RequestInit) => {
      const target = new URL(String(url));
      expect(target.origin).toBe("https://www.paynow.co.zw");
      const fields = Object.fromEntries(new URLSearchParams(String(init.body)));
      let result: Record<string, string>, key: string;
      if (target.pathname.endsWith("initiatetransaction")) {
        key = keys.get(fields.id)!;
        expect(key).toBeTruthy();
        expect(verifyPaynow(fields, key)).toBe(true);
        intents.set(fields.reference, {
          key,
          amount: fields.amount,
          provider: `verified-${fields.reference}`,
        });
        result = {
          status: "Ok",
          pollurl: `https://www.paynow.co.zw/poll?reference=${fields.reference}`,
          browserurl: `https://www.paynow.co.zw/hosted?reference=${fields.reference}`,
          paynowreference: `verified-${fields.reference}`,
        };
      } else {
        const reference = target.searchParams.get("reference")!,
          intent = intents.get(reference)!;
        key = intent.key;
        result = {
          reference,
          amount: intent.amount,
          paynowreference: intent.provider,
          status: "paid",
        };
      }
      return new Response(
        new URLSearchParams({ ...result, hash: paynowHash(result, key) }),
      );
    }),
  );
  const pay = async (fixture: typeof a, amount = "10.00") => {
    const p = await proposePayment(fixture.f.people.RESIDENT, {
      userId: fixture.f.people.RESIDENT.id,
      propertyId: fixture.f.property.id,
      amount,
      method: "PAYNOW",
      idempotencyKey: randomUUID(),
    });
    await initiatePaynow(fixture.f.people.RESIDENT, p.id);
    return db.payment.findUniqueOrThrow({ where: { id: p.id } });
  };
  const pA = await pay(a),
    pB = await pay(b);
  expect(pA.providerConfigEncrypted).toBeTruthy();
  expect(pA.providerConfigEncrypted).not.toContain(keys.get("merchant-a")!);
  const fields = {
    reference: pA.reference,
    amount: "10.00",
    paynowreference: pA.providerId!,
    status: "paid",
  };
  await expect(
    callback({ ...fields, hash: paynowHash(fields, keys.get("merchant-b")!) }),
  ).rejects.toThrow("INVALID_WEBHOOK_SIGNATURE");
  expect(await db.receipt.count({ where: { paymentId: pA.id } })).toBe(0);
  await configureOrganisationPaynow(a.f.people.ADMIN, a.organisation.id, {
    mode: "live",
    credentials: {
      integrationId: "merchant-a-new",
      integrationKey: keys.get("merchant-a-new"),
      currency: "USD",
    },
  });
  await callback({
    ...fields,
    hash: paynowHash(fields, keys.get("merchant-a")!),
  });
  await callback({
    ...fields,
    hash: paynowHash(fields, keys.get("merchant-a")!),
  });
  await reconcilePaynow(pA.id);
  await reconcilePaynow(pA.id);
  await reconcilePaynow(pB.id);
  expect(await db.receipt.count({ where: { paymentId: pA.id } })).toBe(1);
  const fresh = await pay(a);
  expect(intents.get(fresh.reference)!.key).toBe(keys.get("merchant-a-new"));
  await expect(
    db.payment.update({
      where: { id: fresh.id },
      data: { providerConfigEncrypted: "replacement" },
    }),
  ).rejects.toThrow();
  await configureOrganisationPaynow(b.f.people.ADMIN, b.organisation.id, {
    mode: "disabled",
  });
  // Previously bound intents can still reconcile; new intents cannot inherit the legacy merchant.
  await reconcilePaynow(pB.id);
  const denied = await proposePayment(b.f.people.RESIDENT, {
    userId: b.f.people.RESIDENT.id,
    propertyId: b.f.property.id,
    amount: "10.00",
    method: "PAYNOW",
    idempotencyKey: randomUUID(),
  });
  await expect(initiatePaynow(b.f.people.RESIDENT, denied.id)).rejects.toThrow(
    "PAYNOW_READY_FOR_CREDENTIALS",
  );
});
