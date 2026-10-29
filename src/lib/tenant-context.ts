import { db, type Tx } from "./db";
import { type Actor } from "../domain/access";
import { permitOrganisation } from "../domain/organisations";

/**
 * Restricted organisation data-plane transaction. Settings and role are LOCAL,
 * so pooled connections cannot retain the previous request's tenant context.
 * The global identity/worker control plane is deliberately outside this role.
 */
export async function withTenant<T>(
  actor: Actor,
  organisationId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(organisationId))
    throw new Error("INVALID_ORGANISATION");
  if (!actor.id || actor.apiPropertyId)
    throw new Error("ORGANISATION_FORBIDDEN");
  return db.$transaction(
    async (tx) => {
      await permitOrganisation(actor, organisationId, "member", tx);
      await tx.$queryRaw`SELECT set_config('app.organisation_id',${organisationId},true),set_config('app.user_id',${actor.id},true)`;
      // A static role name is intentional. Never interpolate a caller-provided role.
      await tx.$executeRaw`SET LOCAL ROLE legacy_tenant`;
      return fn(tx);
    },
    { isolationLevel: "Serializable", maxWait: 10000, timeout: 20000 },
  );
}
