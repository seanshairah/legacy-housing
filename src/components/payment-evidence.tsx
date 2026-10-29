import Link from "next/link";
import { type Actor } from "../domain/access";
import { paymentEvidenceOverview } from "../domain/payment-evidence";
import { money } from "../domain/finance";
import { ActionForm, Badge } from "./ui";

function Reason({ label = "Reason" }: { label?: string }) {
  return (
    <label>
      {label}
      <textarea name="reason" required minLength={10} maxLength={2000} />
    </label>
  );
}

export async function PaymentEvidence({
  actor,
  propertyId,
  page = 1,
}: {
  actor: Actor;
  propertyId: string;
  page?: number;
}) {
  const result = await paymentEvidenceOverview(actor, propertyId, page);
  const destination = result.canRead ? "/workspace/finance" : "/portal";
  const next = `${destination}?property=${encodeURIComponent(propertyId)}&evidencePage=${page}`;
  return (
    <section
      className="panel"
      id="payment-evidence"
      aria-label="Payment evidence and disputes"
    >
      <h2>Payment evidence & disputes</h2>
      <p>
        Evidence and disputes are reviewed separately from settlement. A
        completed dispute review does not post a payment or issue a receipt.
      </p>
      {!result.payments.length && <p>No payments on this page.</p>}
      {result.payments.map((payment) => {
        const owns = payment.userId === actor.id;
        const editable =
          ["BANK", "CASH"].includes(payment.method) &&
          payment.status === "PROOF_REVIEW";
        const openDispute = payment.disputes.some((d) =>
          ["OPEN", "INVESTIGATING"].includes(d.state),
        );
        return (
          <details className="record-card" key={payment.id}>
            <summary>
              {payment.reference} ·{" "}
              {money(payment.amountMinor, payment.currency)} · {payment.method}
            </summary>
            <Badge>{payment.status.replaceAll("_", " ")}</Badge>
            <p>
              Reference:{" "}
              {payment.bankReference ||
                "Provider reference managed during reconciliation"}
            </p>
            {payment.proofDocumentId && (
              <p>
                <a
                  className="text-link"
                  href={`/api/documents/${payment.proofDocumentId}`}
                >
                  Download protected payment evidence ↗
                </a>
              </p>
            )}
            {payment.evidence && (
              <p>
                Payment date:{" "}
                {payment.evidence.paymentDate.toISOString().slice(0, 10)}
                {payment.evidence.bankName && ` · ${payment.evidence.bankName}`}
                {payment.evidence.accountLast4 &&
                  ` · account ending ${payment.evidence.accountLast4}`}
                {payment.evidence.assignedReviewerId &&
                  ` · assigned reviewer ${payment.evidence.assignedReviewerId}`}
              </p>
            )}
            {editable && (owns || result.canWrite) && (
              <ActionForm
                action="evidence.update"
                paymentId={payment.id}
                next={next}
              >
                <h3>Record payment details</h3>
                <input type="hidden" name="currency" value={payment.currency} />
                <label>
                  Payment date
                  <input
                    name="paymentDate"
                    type="date"
                    required
                    max={new Date().toISOString().slice(0, 10)}
                    defaultValue={payment.evidence?.paymentDate
                      .toISOString()
                      .slice(0, 10)}
                  />
                </label>
                <p>
                  Currency: {payment.currency}. The currency must match the
                  original payment.
                </p>
                {payment.method === "BANK" && (
                  <>
                    <label>
                      Bank name
                      <input
                        name="bankName"
                        required
                        minLength={2}
                        maxLength={120}
                        defaultValue={payment.evidence?.bankName || ""}
                      />
                    </label>
                    <label>
                      Account ending (last four digits only)
                      <input
                        name="accountLast4"
                        inputMode="numeric"
                        pattern="[0-9]{4}"
                        maxLength={4}
                        defaultValue={payment.evidence?.accountLast4 || ""}
                      />
                    </label>
                  </>
                )}
                <Reason label="Evidence update reason" />
                <button className="button secondary">
                  Save payment details
                </button>
              </ActionForm>
            )}
            {editable && result.canWrite && (
              <ActionForm
                action="evidence.assign"
                paymentId={payment.id}
                next={next}
              >
                <label>
                  Independent finance reviewer
                  <select
                    name="reviewerId"
                    required
                    defaultValue={payment.evidence?.assignedReviewerId || ""}
                  >
                    <option value="">Choose a reviewer</option>
                    {result.reviewers
                      .filter(
                        (r) =>
                          r.userId !== payment.proposedBy &&
                          r.userId !== payment.userId,
                      )
                      .map((r) => (
                        <option key={r.userId} value={r.userId}>
                          {r.user.name}
                        </option>
                      ))}
                  </select>
                </label>
                <Reason label="Reviewer assignment reason" />
                <button className="button secondary">
                  Assign finance reviewer
                </button>
              </ActionForm>
            )}
            {owns && !openDispute && (
              <ActionForm
                action="payment.dispute"
                paymentId={payment.id}
                next={next}
              >
                <Reason label="Payment dispute details" />
                <button className="button secondary">
                  Open payment dispute
                </button>
              </ActionForm>
            )}
            {payment.disputes.length > 0 && <h3>Latest payment disputes</h3>}
            {payment.disputes.map((dispute) => (
              <div className="record-card" key={dispute.id}>
                <Badge>{dispute.state}</Badge>
                <p>{dispute.reason}</p>
                {dispute.resolution && (
                  <p>Latest response: {dispute.resolution}</p>
                )}
                <details>
                  <summary>Review history (latest 20 events)</summary>
                  {dispute.events.map((event) => (
                    <p key={event.id}>
                      {event.createdAt.toISOString()} · {event.state} ·{" "}
                      {event.reason}
                    </p>
                  ))}
                </details>
                {result.canWrite &&
                  ["OPEN", "INVESTIGATING"].includes(dispute.state) && (
                    <ActionForm
                      action="payment.dispute.review"
                      id={dispute.id}
                      next={next}
                    >
                      <label>
                        Dispute decision
                        <select name="state">
                          <option value="INVESTIGATING">Investigating</option>
                          <option value="RESOLVED">
                            Resolved after verification
                          </option>
                          <option value="REJECTED">Rejected with reason</option>
                        </select>
                      </label>
                      <Reason label="Dispute review reason" />
                      <label className="check-label">
                        <input type="checkbox" name="verified" />I independently
                        verified the relevant evidence before resolving this
                        dispute.
                      </label>
                      <button className="button secondary">
                        Record dispute decision
                      </button>
                    </ActionForm>
                  )}
              </div>
            ))}
          </details>
        );
      })}
      <nav aria-label="Payment evidence pages">
        {page > 1 && (
          <Link
            href={`${destination}?property=${encodeURIComponent(propertyId)}&evidencePage=${page - 1}#payment-evidence`}
          >
            Previous payments
          </Link>
        )}{" "}
        {result.hasNext && (
          <Link
            href={`${destination}?property=${encodeURIComponent(propertyId)}&evidencePage=${page + 1}#payment-evidence`}
          >
            Next payments
          </Link>
        )}
      </nav>
    </section>
  );
}
