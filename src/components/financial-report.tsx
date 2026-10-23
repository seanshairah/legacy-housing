import {
  financialReconciliation,
  type ReportFilters,
} from "../domain/reporting";
import { type Actor } from "../domain/access";
import { money } from "../domain/finance";
import { Stat, Badge } from "./ui";
export async function FinancialReport({
  actor,
  propertyId,
  filters = {},
}: {
  actor: Actor;
  propertyId: string;
  filters?: ReportFilters;
}) {
  const r = await financialReconciliation(actor, propertyId, filters);
  const query = new URLSearchParams({
    propertyId,
    ...Object.fromEntries(
      Object.entries(filters).filter(([, v]) => v !== undefined),
    ),
  });
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Collections, debtors & reconciliation</h2>
        <a className="text-link" href={`/api/v1/reconciliation?${query}`}>
          Download reconciliation CSV ↗
        </a>
      </div>
      <div className="stats-grid">
        <Stat
          label="Collection performance"
          value={
            r.collectionPercent === null
              ? "No invoices"
              : `${r.collectionPercent.toFixed(2)}%`
          }
          note="Net allocations / net invoices due in the selected period, as of now"
        />
        <Stat
          label="Outstanding invoices"
          value={money(r.outstanding, r.currency)}
          note="Issued amount less credits and net allocations"
        />
        <Stat
          label="Overdue rental debt"
          value={money(r.overdueRent, r.currency)}
          note="Unpaid RENT invoices already due"
        />
        <Stat
          label="Reconciliation exceptions"
          value={r.exceptions}
          note="Missing receipt or allocation/funds mismatch"
        />
      </div>
      <p className="small muted">
        Invoice cohort uses due dates; transaction cohort uses creation dates.
        Figures include recorded corrections through {r.asOf}. Transaction and
        invoice cohorts can differ; unallocated funds remain credit.
      </p>
      <div className="table-wrap">
        <table>
          <caption>Outstanding debtors</caption>
          <thead>
            <tr>
              <th>Resident</th>
              <th>Invoice</th>
              <th>Due</th>
              <th>Outstanding</th>
            </tr>
          </thead>
          <tbody>
            {r.invoices
              .filter((c) => c.outstanding > 0n)
              .map((c) => (
                <tr key={c.id}>
                  <td>{c.resident}</td>
                  <td>{c.reference}</td>
                  <td>{c.dueAt.toISOString().slice(0, 10)}</td>
                  <td>{money(c.outstanding, r.currency)}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
      <div className="table-wrap">
        <table>
          <caption>Payment verification and reconciliation</caption>
          <thead>
            <tr>
              <th>Reference / method</th>
              <th>Status</th>
              <th>Net verified</th>
              <th>Allocated</th>
              <th>Unused credit</th>
              <th>Receipt / exception</th>
            </tr>
          </thead>
          <tbody>
            {r.transactions.map((t) => (
              <tr key={t.id}>
                <td>
                  {t.reference}
                  <br />
                  {t.method}
                </td>
                <td>
                  <Badge>{t.status}</Badge>
                </td>
                <td>{money(t.verified, r.currency)}</td>
                <td>{money(t.allocated, r.currency)}</td>
                <td>{money(t.unallocated, r.currency)}</td>
                <td>{t.exception || t.receipt || "Awaiting settlement"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
