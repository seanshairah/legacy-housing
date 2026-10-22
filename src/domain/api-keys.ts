import { db, transaction } from "../lib/db";
import { type Actor, permit } from "./access";
import { hash, token } from "../lib/security";
import { event } from "./events";
export async function issueApiKey(
  actor: Actor,
  propertyId: string,
  name: string,
  scopes: string[],
) {
  const allowed = [
    "inventory",
    "admissions",
    "leases",
    "finance.read",
    "operations",
    "reports",
  ];
  if (
    !name.trim() ||
    !scopes.length ||
    scopes.some((s) => !allowed.includes(s))
  )
    throw new Error("INVALID_API_SCOPES");
  const raw = token();
  const key = await transaction(async (tx) => {
    await permit(actor, propertyId, "settings", tx);
    const k = await tx.apiKey.create({
      data: {
        userId: actor.id,
        propertyId,
        name,
        scopes,
        tokenHash: hash(raw),
        expiresAt: new Date(Date.now() + 30 * 86400000),
      },
    });
    await event(tx, actor.id, propertyId, "api_key.created", k.id, {
      scopes,
      name,
    });
    return k;
  });
  return { id: key.id, token: raw, expiresAt: key.expiresAt };
}
export async function apiActor(raw: string) {
  const k = await db.apiKey.findUnique({ where: { tokenHash: hash(raw) } });
  if (!k || !k.active || k.expiresAt < new Date())
    throw new Error("INVALID_API_KEY");
  return { id: k.userId, apiPropertyId: k.propertyId, apiScopes: k.scopes };
}
