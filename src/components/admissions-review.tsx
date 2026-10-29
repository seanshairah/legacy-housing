import Link from "next/link";
import { type Actor } from "../domain/access";
import {
  applicationReviewNotes,
  listAdmissionsReviews,
} from "../domain/admissions";
import { ActionForm, Badge } from "./ui";
export async function AdmissionsReview({
  actor,
  propertyId,
  page = 1,
  search = "",
  status = "ALL",
  assignedTo = "",
  noteApplicationId,
  notePage = 1,
}: {
  actor: Actor;
  propertyId: string;
  page?: number;
  search?: string;
  status?: string;
  assignedTo?: string;
  noteApplicationId?: string;
  notePage?: number;
}) {
  const result = await listAdmissionsReviews(actor, propertyId, {
    page,
    search,
    status,
    assignedTo,
  });
  const query = new URLSearchParams({
    property: propertyId,
    reviewPage: String(page),
    reviewStatus: status,
    reviewSearch: search,
    reviewAssigned: assignedTo,
  });
  const next = `/workspace/admissions?${query}`;
  const pageLink = (n: number) => {
    const params = new URLSearchParams(query);
    params.set("reviewPage", String(n));
    return `/workspace/admissions?${params}#review-management`;
  };
  const historyLink = (id: string, n = 1) => {
    const params = new URLSearchParams(query);
    params.set("reviewNoteApp", id);
    params.set("reviewNotePage", String(n));
    return `/workspace/admissions?${params}#review-note-history`;
  };
  const notes = noteApplicationId
    ? await applicationReviewNotes(actor, noteApplicationId, notePage)
    : null;
  if (notes && notes.propertyId !== propertyId)
    throw new Error("APPLICATION_PROPERTY_MISMATCH");
  return (
    <section
      className="panel"
      aria-label="Admissions assignment and review"
      id="review-management"
    >
      <div className="panel-head">
        <h2>Review assignments & notes</h2>
        <Badge>{result.total} matching applications</Badge>
      </div>
      <p className="muted">
        Assignment rationale and internal notes are restricted to this
        property’s admissions staff. Stage messages are visible to the
        applicant.
      </p>
      <form action="/workspace/admissions" method="get" className="filter-bar">
        <input type="hidden" name="property" value={propertyId} />
        <label>
          Applicant name
          <input name="reviewSearch" defaultValue={search} maxLength={80} />
        </label>
        <label>
          Review stage
          <select name="reviewStatus" defaultValue={status}>
            {[
              "ALL",
              "SUBMITTED",
              "DOCUMENTS_PENDING",
              "IN_REVIEW",
              "DEPOSIT_PENDING",
              "LEASE_SIGNING_PENDING",
              "READY_FOR_MOVE_IN",
              "ACTIVE",
              "DECLINED",
              "WITHDRAWN",
              "ENDED",
            ].map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
        <label>
          Assigned reviewer
          <select name="reviewAssigned" defaultValue={assignedTo}>
            <option value="">All reviewers</option>
            {result.reviewers.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </label>
        <button className="button secondary">Filter reviews</button>
      </form>
      {!result.data.length && (
        <p>No applications match these review filters.</p>
      )}
      {result.data.map((a) => (
        <details className="record-card" key={a.id}>
          <summary>
            {a.user.name} · {a.status.replaceAll("_", " ")}
          </summary>
          <p className="small">
            Reviewer: {a.assignedReviewer?.name || "Unassigned"}
            {a.assignedReviewer &&
            !result.reviewers.some((r) => r.id === a.assignedReviewerId)
              ? " — reassignment required"
              : ""}
          </p>
          {["SUBMITTED", "DOCUMENTS_PENDING", "IN_REVIEW"].includes(
            a.status,
          ) && (
            <>
              <ActionForm action="admissions.assign" id={a.id} next={next}>
                <label>
                  Reviewer
                  <select
                    name="reviewerId"
                    defaultValue={a.assignedReviewerId || ""}
                  >
                    <option value="">Unassign reviewer</option>
                    {result.reviewers.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Internal assignment reason
                  <textarea
                    name="reason"
                    required
                    minLength={10}
                    maxLength={2000}
                  />
                </label>
                <button className="button secondary">Save assignment</button>
              </ActionForm>
              <ActionForm action="admissions.stage" id={a.id} next={next}>
                <label>
                  Next review stage
                  <select
                    name="stage"
                    defaultValue={
                      a.status === "IN_REVIEW"
                        ? "IN_REVIEW"
                        : "DOCUMENTS_PENDING"
                    }
                  >
                    <option value="DOCUMENTS_PENDING">Documents pending</option>
                    <option value="IN_REVIEW">In review</option>
                  </select>
                </label>
                <label>
                  Resident-facing next action
                  <textarea
                    name="reason"
                    required
                    minLength={10}
                    maxLength={2000}
                    defaultValue={a.message || ""}
                  />
                </label>
                <button className="button secondary">
                  Update review stage
                </button>
              </ActionForm>
            </>
          )}
          <ActionForm action="admissions.note" id={a.id} next={next}>
            <label>
              Internal review note
              <textarea name="body" required minLength={3} maxLength={5000} />
            </label>
            <button className="button secondary">Add internal note</button>
          </ActionForm>
          <h3>Latest internal notes</h3>
          {!a.reviewNotes.length && <p>No internal notes recorded.</p>}
          {a.reviewNotes.map((n) => (
            <div className="ticket-message" key={n.id}>
              <p>{n.body}</p>
              <small>
                {n.kind} · {n.actor.name} · {n.createdAt.toISOString()}
              </small>
            </div>
          ))}
          {!!a._count.reviewNotes && (
            <Link className="text-link" href={historyLink(a.id)}>
              Read all {a._count.reviewNotes} internal notes
            </Link>
          )}
        </details>
      ))}
      <nav aria-label="Review assignment pages">
        {page > 1 && (
          <Link href={pageLink(page - 1)}>Previous review page</Link>
        )}{" "}
        {page * result.pageSize < result.total && (
          <Link href={pageLink(page + 1)}>Next review page</Link>
        )}
      </nav>
      {notes && (
        <section
          id="review-note-history"
          aria-label="Full internal review note history"
        >
          <h3>Internal review note history</h3>
          <p>
            {notes.total} notes retained. Notes are append-only; add a
            correction to preserve the record.
          </p>
          {notes.data.map((n) => (
            <div key={n.id} className="ticket-message">
              <p>{n.body}</p>
              <small>
                {n.kind} · {n.actor.name} · {n.createdAt.toISOString()}
              </small>
            </div>
          ))}
          <nav aria-label="Internal note history pages">
            {notes.page > 1 && (
              <Link href={historyLink(notes.applicationId, notes.page - 1)}>
                Previous notes
              </Link>
            )}{" "}
            {notes.page * notes.pageSize < notes.total && (
              <Link href={historyLink(notes.applicationId, notes.page + 1)}>
                Next notes
              </Link>
            )}
          </nav>
        </section>
      )}
    </section>
  );
}
