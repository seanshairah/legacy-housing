import Link from "next/link";
import { type Actor } from "../domain/access";
import { retentionDryRun, retentionOverview } from "../domain/retention";
import { ActionForm, Badge } from "./ui";

const explanations: Record<string, string> = {
  IMMUTABLE_EVIDENCE: "Financial or signed agreement evidence is preserved.",
  DELETION_ALREADY_CLAIMED:
    "An approved deletion is in progress; this document stays inaccessible.",
  ALREADY_DELETED: "The private payload has already been erased.",
  LEGAL_HOLD: "A legal hold prevents deletion.",
  NO_APPROVED_RETENTION_POLICY:
    "An independently approved retention policy is required.",
  ACTIVE_APPLICATION: "This application is still active.",
  ACTIVE_SERVICE_REQUEST: "This document supports an open service request.",
  RETENTION_NOT_EXPIRED: "The approved retention period has not elapsed.",
};
function Reason({ label = "Review reason" }: { label?: string }) {
  return (
    <label>
      {label}
      <textarea name="reason" required minLength={10} maxLength={2000} />
    </label>
  );
}
export async function RetentionPanel({
  actor,
  propertyId,
  after,
  historyPage = 1,
}: {
  actor: Actor;
  propertyId: string;
  after?: string;
  historyPage?: number;
}) {
  const [overview, preview] = await Promise.all([
    retentionOverview(actor, propertyId, historyPage),
    retentionDryRun(actor, propertyId, 100, after),
  ]);
  const next = `/workspace/settings?property=${encodeURIComponent(propertyId)}`;
  return (
    <section
      className="panel"
      aria-label="Document retention and legal holds"
      id="retention"
    >
      <h2>Document retention & legal holds</h2>
      <p>
        Approve a documented retention policy before requesting any deletion. A
        different administrator must approve the policy and each deletion.
        Active applications, open service requests, legal holds, payment
        evidence and signed agreements remain protected.
      </p>
      <p className="muted">
        Erasure removes the private document payload and redacts its filename.
        The version hash, ownership and approval history remain as evidence.
        Backup copies follow the separately approved backup retention process.
      </p>
      {!overview.executionEnabled && (
        <p className="notice" role="status">
          Payload deletion is disabled for this environment. Approved requests
          remain pending until an authorised operator enables deletion.
        </p>
      )}
      <details>
        <summary>Propose a retention policy</summary>
        <ActionForm
          action="retention.policy"
          propertyId={propertyId}
          next={next}
        >
          <label>
            Document category
            <select name="kind">
              {[
                "IDENTITY",
                "REGISTRATION",
                "RESIDENCE",
                "SPONSOR",
                "MEDICAL",
                "SUPPORT",
              ].map((kind) => (
                <option key={kind}>{kind}</option>
              ))}
            </select>
          </label>
          <label>
            Retention period after closure, in days
            <input
              name="retainDays"
              type="number"
              required
              min={1}
              max={36500}
            />
          </label>
          <label>
            Approved policy reference
            <input
              name="policyReference"
              required
              minLength={5}
              maxLength={500}
            />
          </label>
          <label>
            Lawful basis and policy rationale
            <textarea name="basis" required minLength={10} maxLength={2000} />
          </label>
          <button className="button secondary">
            Propose policy for review
          </button>
        </ActionForm>
      </details>
      <p className="small muted">
        Approval and hold history page {historyPage}; up to 100 records per
        section.
      </p>
      <h3>Policy versions</h3>
      {!overview.policies.length && (
        <p>No policy versions on this history page.</p>
      )}
      {overview.policies.map((policy) => (
        <div className="record-card" key={policy.id}>
          <div className="panel-head">
            <strong>
              {policy.kind.replaceAll("_", " ")} · version {policy.version}
            </strong>
            <Badge>{policy.state}</Badge>
          </div>
          <p>
            {policy.retainDays} days after the latest application closure or
            service resolution. Reference: {policy.policyReference}.
          </p>
          <p>{policy.basis}</p>
          {policy.state === "DRAFT" &&
            (policy.proposedBy === actor.id ? (
              <p className="muted">
                Another administrator must approve your proposal.
              </p>
            ) : (
              <ActionForm
                action="retention.policy.approve"
                id={policy.id}
                next={next}
              >
                <Reason label="Policy approval reason" />
                <button className="button secondary">
                  Approve retention policy
                </button>
              </ActionForm>
            ))}
        </div>
      ))}
      <h3>Document review preview</h3>
      <p className="muted">
        Review up to 100 document references per page. Previewing never deletes
        a file.
      </p>
      {!preview.items.length && <p>No document references on this page.</p>}
      {preview.items.map((doc) => (
        <div className="record-card" key={doc.id}>
          <div className="panel-head">
            <strong>{doc.kind.replaceAll("_", " ")}</strong>
            <Badge>{doc.eligible ? "Eligible for review" : "Preserved"}</Badge>
          </div>
          <p className="small muted">Document reference: {doc.id}</p>
          {doc.reason && (
            <p>
              {explanations[doc.reason] ||
                "This document is preserved pending review."}
            </p>
          )}
          {doc.eligible && (
            <ActionForm
              action="retention.request"
              documentId={doc.id}
              next={next}
            >
              <Reason label="Deletion request reason" />
              <button className="button secondary">
                Request independent deletion review
              </button>
            </ActionForm>
          )}
          {!["ALREADY_DELETED", "DELETION_ALREADY_CLAIMED"].includes(
            doc.reason || "",
          ) && (
            <details>
              <summary>Place a legal hold on this document</summary>
              <ActionForm
                action="retention.hold"
                documentId={doc.id}
                next={next}
              >
                <Reason label="Legal hold reason" />
                <button className="button secondary">Place legal hold</button>
              </ActionForm>
            </details>
          )}
        </div>
      ))}
      <div className="pagination">
        {after && <Link href={`${next}#retention`}>First document page</Link>}
        {preview.next && (
          <Link
            href={`${next}&retentionAfter=${encodeURIComponent(preview.next)}#retention`}
          >
            Next document page →
          </Link>
        )}
      </div>
      <h3>Legal holds</h3>
      {!overview.holds.length && <p>No legal holds on this history page.</p>}
      {overview.holds.map((hold) => (
        <div className="record-card" key={hold.id}>
          <div className="panel-head">
            <strong>Document {hold.documentId}</strong>
            <Badge>{hold.releasedAt ? "Released" : "Active hold"}</Badge>
          </div>
          <p>{hold.reason}</p>
          {!hold.releasedAt &&
            (hold.imposedBy === actor.id ? (
              <p className="muted">
                A different administrator must approve release of this hold.
              </p>
            ) : (
              <ActionForm
                action="retention.hold.release"
                id={hold.id}
                next={next}
              >
                <Reason label="Legal hold release reason" />
                <button className="button secondary">Release legal hold</button>
              </ActionForm>
            ))}
        </div>
      ))}
      <h3>Deletion approvals</h3>
      {!overview.deletions.length && (
        <p>No deletion requests on this history page.</p>
      )}
      {overview.deletions.map((request) => (
        <div className="record-card" key={request.id}>
          <div className="panel-head">
            <strong>Document {request.documentId}</strong>
            <Badge>{request.state}</Badge>
          </div>
          <p>{request.reason}</p>
          {request.state === "REQUESTED" &&
            (request.requestedBy === actor.id ? (
              <p className="muted">
                Another administrator must approve your request.
              </p>
            ) : (
              <ActionForm
                action="retention.approve"
                id={request.id}
                next={next}
              >
                <Reason label="Deletion approval reason" />
                <button className="button secondary">
                  Approve document deletion
                </button>
              </ActionForm>
            ))}
          {["APPROVED", "DELETING", "FAILED"].includes(request.state) && (
            <ActionForm action="retention.execute" id={request.id} next={next}>
              <label className="check">
                <input
                  type="checkbox"
                  name="confirm"
                  required
                  disabled={!overview.executionEnabled}
                />
                I have reviewed the approved policy and authorise irreversible
                removal of this private payload.
              </label>
              <button
                className="button secondary"
                disabled={!overview.executionEnabled}
              >
                Erase approved document payload
              </button>
            </ActionForm>
          )}
          {request.state === "FAILED" && (
            <p className="notice">
              The private file could not be removed. Access stays blocked; an
              administrator can retry after correcting the storage issue.
            </p>
          )}
        </div>
      ))}
      <div className="pagination" aria-label="Retention approval history pages">
        {historyPage > 1 && (
          <Link href={`${next}&retentionPage=${historyPage - 1}#retention`}>
            ← Previous approval history
          </Link>
        )}
        {overview.hasNext && (
          <Link href={`${next}&retentionPage=${historyPage + 1}#retention`}>
            Next approval history →
          </Link>
        )}
      </div>
    </section>
  );
}
