import { visibleSecurityAlerts } from "../domain/monitoring";
import { type Actor } from "../domain/access";
import { ActionForm, Badge, Empty } from "./ui";
export async function SecurityPanel({
  actor,
  propertyId,
  canReview,
}: {
  actor: Actor;
  propertyId: string;
  canReview: boolean;
}) {
  const alerts = await visibleSecurityAlerts(actor, propertyId);
  return (
    <section className="panel">
      <h2>Security detection & response</h2>
      <p className="muted">
        Repeated authentication failures, access denials, rate limits, malware
        and exhausted scans create persistent review alerts. Global
        authentication signals are visible only to client-wide administrators.
        This application monitoring complements host intrusion detection.
      </p>
      {!alerts.length && (
        <Empty
          title="No recorded security signals"
          body="New signals appear here automatically."
        />
      )}
      {alerts.map((a) => (
        <div className="record-card" key={a.id}>
          <div className="panel-head">
            <strong>{a.kind.replaceAll("_", " ")}</strong>
            <Badge tone={a.severity === "HIGH" ? "red" : ""}>
              {a.severity} · {a.state}
            </Badge>
          </div>
          <p className="small muted">
            {a.occurrences} occurrences · last seen {a.lastSeenAt.toISOString()}{" "}
            · {a.propertyId ? "Property" : "Client-wide"}
          </p>
          {a.resolution && <p>{a.resolution}</p>}
          {canReview && (
            <ActionForm
              action="security.review"
              id={a.id}
              next="/workspace/security"
            >
              <label>
                Review status
                <select name="state">
                  <option>ACKNOWLEDGED</option>
                  <option>RESOLVED</option>
                </select>
              </label>
              <label>
                Investigation / resolution
                <textarea name="reason" required maxLength={2000} />
              </label>
              <button className="button secondary small-button">
                Record security review
              </button>
            </ActionForm>
          )}
        </div>
      ))}
    </section>
  );
}
