import { db, transaction } from "../lib/db";
import { type Actor, permit, permitClientAdmin } from "./access";
import { event } from "./events";
export async function visibleSecurityAlerts(actor: Actor, propertyId: string) {
  await permit(actor, propertyId, "audit");
  let global = false;
  try {
    await permitClientAdmin(actor);
    global = true;
  } catch {
    /* Property reviewers cannot view global signals. */
  }
  return db.securityAlert.findMany({
    where: { OR: [{ propertyId }, ...(global ? [{ propertyId: null }] : [])] },
    orderBy: [{ lastSeenAt: "desc" }],
    take: 50,
  });
}
export async function reviewSecurityAlert(
  actor: Actor,
  id: string,
  state: "ACKNOWLEDGED" | "RESOLVED",
  reason: string,
) {
  if (!reason.trim() || reason.length > 2000)
    throw new Error("REVIEW_REASON_REQUIRED");
  return transaction(async (tx) => {
    const alert = await tx.securityAlert.findUniqueOrThrow({ where: { id } });
    if (alert.propertyId) await permit(actor, alert.propertyId, "settings", tx);
    else await permitClientAdmin(actor, tx);
    await tx.securityAlert.update({
      where: { id },
      data: {
        state,
        reviewedBy: actor.id,
        reviewedAt: new Date(),
        resolution: reason,
      },
    });
    await event(tx, actor.id, alert.propertyId, "security.alert_reviewed", id, {
      state,
      reason,
    });
  });
}
