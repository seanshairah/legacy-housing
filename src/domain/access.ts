import { db, type Tx } from "../lib/db";
export type Actor = {
  id: string;
  apiPropertyId?: string;
  apiScopes?: string[];
};
export const rolePermissions: Record<string, readonly string[]> = {
  ADMIN: [
    "inventory",
    "admissions",
    "kyc",
    "medical",
    "finance",
    "finance.read",
    "leases",
    "operations",
    "reports",
    "settings",
    "audit",
  ],
  ADMISSIONS: ["admissions", "leases", "operations"],
  FINANCE: ["finance", "finance.read"],
  PROPERTY_MANAGER: ["inventory", "operations", "reports", "leases"],
  CARETAKER: ["operations"],
  KYC: ["kyc"],
  MEDICAL_REVIEWER: ["medical"],
  AUDITOR: ["finance.read", "reports", "audit"],
};
export async function permit(
  actor: Actor,
  propertyId: string,
  capability: string,
  client: Tx | typeof db = db,
) {
  if (
    actor.apiPropertyId &&
    (actor.apiPropertyId !== propertyId ||
      !actor.apiScopes?.includes(capability))
  )
    throw new Error("FORBIDDEN");
  const user = await client.user.findUnique({
    where: { id: actor.id },
    select: { active: true },
  });
  if (!user?.active) throw new Error("UNAUTHENTICATED");
  const grants = await client.membership.findMany({
    where: { userId: actor.id, propertyId },
  });
  if (!grants.some((g) => rolePermissions[g.role]?.includes(capability)))
    throw new Error("FORBIDDEN");
}
export async function ownerOrPermit(
  actor: Actor,
  userId: string,
  propertyId: string,
  capability: string,
  client: Tx | typeof db = db,
) {
  if (actor.apiPropertyId || actor.id !== userId)
    await permit(actor, propertyId, capability, client);
}
export async function permitClientAdmin(
  actor: Actor,
  client: Tx | typeof db = db,
) {
  const user = await client.user.findUnique({
    where: { id: actor.id },
    select: { active: true },
  });
  if (!user?.active) throw new Error("UNAUTHENTICATED");
  const properties = await client.property.findMany({ select: { id: true } }),
    grants = await client.membership.findMany({
      where: { userId: actor.id, role: "ADMIN" },
      select: { propertyId: true },
    });
  if (
    actor.apiPropertyId ||
    !properties.length ||
    properties.some((p) => !grants.some((g) => g.propertyId === p.id))
  )
    throw new Error("CLIENT_ADMIN_REQUIRED");
}
