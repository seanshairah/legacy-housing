import { db } from "../lib/db";
import { type Actor } from "../domain/access";
import {
  permitOrganisation,
  organisationForProperty,
} from "../domain/organisations";
import { ActionForm, Badge } from "./ui";
export async function PrivacyAdmin({
  actor,
  propertyId,
}: {
  actor: Actor;
  propertyId: string;
}) {
  const organisationId = await organisationForProperty(propertyId);
  try {
    await permitOrganisation(actor, organisationId, "admin");
  } catch {
    return null;
  }
  const requests = await db.privacyRequest.findMany({
    where: { organisationId, state: { not: "FULFILLED" } },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  return (
    <section className="panel">
      <h2>Client privacy request review</h2>
      <p className="muted">
        Restricted to this organisation's administrators. Erasure requires a
        lawful retention/legal-hold decision; this interface does not falsely
        mark data deleted.
      </p>
      {requests.map((r) => (
        <div key={r.id} className="record-card">
          <div className="panel-head">
            <h3>
              {r.type} · {r.userId}
            </h3>
            <Badge>{r.state}</Badge>
          </div>
          <p>{r.reason}</p>
          <ActionForm
            action="privacy.review"
            next="/workspace/settings"
            id={r.id}
          >
            <div className="inline-fields">
              <label>
                Review status
                <select name="state">
                  <option>IN_REVIEW</option>
                  <option>ON_HOLD</option>
                  <option>DECLINED</option>
                </select>
              </label>
              <label>
                Response / lawful retention reason
                <input name="reason" required />
              </label>
              <button className="button secondary">
                Record privacy response
              </button>
            </div>
          </ActionForm>
        </div>
      ))}
    </section>
  );
}
