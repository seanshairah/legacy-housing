import Link from "next/link";
import {
  ArrowUpRight,
  BedDouble,
  Wallet,
  FileText,
  Wrench,
  LogOut,
  ShieldCheck,
  Bell,
} from "lucide-react";
import { requireUser } from "../../lib/current-user";
import { db } from "../../lib/db";
import { money, account } from "../../domain/finance";
import {
  Brand,
  PageHead,
  Stat,
  Badge,
  Empty,
  ActionForm,
} from "../../components/ui";
export const dynamic = "force-dynamic";
export default async function Portal({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const u = await requireUser(),
    q = await searchParams;
  const [applications, documents, payments, tickets, notices, leases] =
    await Promise.all([
      db.application.findMany({
        where: { userId: u.id },
        include: {
          property: true,
          reservations: { include: { bed: { include: { room: true } } } },
          history: { orderBy: { createdAt: "desc" } },
        },
        orderBy: { createdAt: "desc" },
      }),
      db.document.findMany({
        where: { userId: u.id },
        orderBy: { createdAt: "desc" },
      }),
      db.payment.findMany({
        where: { userId: u.id },
        include: { receipt: true },
        orderBy: { createdAt: "desc" },
      }),
      db.ticket.findMany({
        where: { userId: u.id },
        include: { messages: { orderBy: { createdAt: "asc" } } },
        orderBy: { createdAt: "desc" },
      }),
      db.notification.findMany({
        where: { userId: u.id },
        take: 8,
        orderBy: { createdAt: "desc" },
      }),
      db.lease.findMany({
        where: { userId: u.id },
        include: {
          reservation: { include: { bed: { include: { room: true } } } },
        },
      }),
    ]);
  const privacyRequests = await db.privacyRequest.findMany({
    where: { userId: u.id },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  const offers = await db.waitlist.findMany({
    where: { userId: u.id, state: "OFFERED" },
    include: { property: true },
  });
  const active = applications.find(
    (a) => !["DECLINED", "WITHDRAWN", "ENDED"].includes(a.status),
  );
  const totals = active ? await account(u.id, active.propertyId) : null;
  const reservation = active?.reservations.find((r) =>
    ["ACTIVE", "CONFIRMED", "HOLD"].includes(r.state),
  );
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Brand />
        <div className="sidebar-label">YOUR RESIDENT SPACE</div>
        <nav>
          <Link className="active" href="/portal">
            <BedDouble size={18} />
            My home
          </Link>
          <a href="#account">
            <Wallet size={18} />
            My account
          </a>
          <a href="#documents">
            <FileText size={18} />
            Documents & lease
          </a>
          <a href="#support">
            <Wrench size={18} />
            Help & support
          </a>
          <a href="#profile">
            <ShieldCheck size={18} />
            Profile & security
          </a>
          {!!u.memberships.length && (
            <Link href="/workspace/overview">
              <ArrowUpRight size={18} />
              Staff workspace
            </Link>
          )}
        </nav>
        <div className="sidebar-bottom">
          <div className="avatar">{u.name[0]}</div>
          <div>
            <strong>{u.name}</strong>
            <small>
              {u.residentType === "STUDENT" ? "Student resident" : "Resident"}
            </small>
          </div>
          <form action="/api/actions" method="post">
            <input type="hidden" name="action" value="sessions.revoke" />
            <button aria-label="Sign out of all sessions">
              <LogOut size={17} />
            </button>
          </form>
        </div>
      </aside>
      <div className="app-main">
        <header className="app-topbar">
          <span>
            My residency <span className="muted">/ Overview</span>
          </span>
          <div>
            <Badge tone="green">Resident portal</Badge>
            <Bell size={18} />
          </div>
        </header>
        <main id="main" className="workspace-content">
          <PageHead
            eyebrow="MAKE YOURSELF AT HOME"
            title={`Hello, ${u.name.split(" ")[0]}.`}
            description="Your home, your plans, and your next steps — together in one place."
            action={
              <Link className="button" href="/rooms">
                Explore rooms <ArrowUpRight size={18} />
              </Link>
            }
          />
          {q.error && (
            <div role="alert" className="notice error">
              {q.error.replaceAll("_", " ").toLowerCase()}
            </div>
          )}
          {q.success && (
            <div role="status" className="notice">
              {q.success}
            </div>
          )}
          {offers.map((offer) => (
            <section key={offer.id} className="notice">
              <h3>A space is available at {offer.property.name}</h3>
              <p>
                Your waiting-list offer expires with its temporary bed hold.
                Accept after reviewing the application policy to begin.
              </p>
              <ActionForm action="waitlist.accept" id={offer.id}>
                <label className="check-label">
                  <input name="consent" type="checkbox" required />I accept the
                  application policy.
                </label>
                <button className="button">Accept offer & apply</button>
              </ActionForm>
            </section>
          ))}
          <div className="stats-grid">
            <Stat
              label="Your space"
              value={
                reservation
                  ? `Room ${reservation.bed.room.name}`
                  : "Find your space"
              }
              note={
                reservation
                  ? `${reservation.bed.label} · ${reservation.state.toLowerCase()}`
                  : "Explore the room catalogue"
              }
              icon={<BedDouble size={18} />}
            />
            <Stat
              label="Outstanding balance"
              value={
                totals
                  ? money(totals.outstanding, active!.property.currency)
                  : "—"
              }
              note={
                totals
                  ? `Unallocated credit: ${money(totals.credit)}`
                  : "Your charges will appear here"
              }
            />
            <Stat
              label="Documents"
              value={documents.filter((d) => d.state === "APPROVED").length}
              note={`${documents.length} submitted · ${documents.filter((d) => d.state === "QUARANTINED").length} awaiting scan`}
            />
            <Stat
              label="Open requests"
              value={
                tickets.filter(
                  (t) => !["CLOSED", "RESOLVED"].includes(t.status),
                ).length
              }
              note="We’re here when you need us"
              icon={<Wrench size={18} />}
            />
          </div>
          <div className="dashboard-grid">
            <section className="panel">
              <div className="panel-head">
                <h2>Your next chapter</h2>
                <Badge>
                  {active?.status.replaceAll("_", " ").toLowerCase() ||
                    "Not started"}
                </Badge>
              </div>
              {!active ? (
                <Empty
                  title="Your next home is waiting"
                  body="Choose an available room to start your application. Verify both your email and phone before reserving."
                />
              ) : (
                <>
                  <p className="muted">{active.property.name}</p>
                  <ol className="journey-steps">
                    {[
                      ["Application", "Your application is securely recorded."],
                      [
                        "Documents",
                        "Upload identity, residence and, for students, registration evidence.",
                      ],
                      [
                        "Deposit",
                        "Pay the issued deposit after approval. Proof uploads require finance verification.",
                      ],
                      [
                        "Lease & move-in",
                        "Review, sign, and submit your agreement. Staff confirm your move-in.",
                      ],
                    ].map(([title, body], i) => (
                      <li key={title}>
                        <span>{i + 1}</span>
                        <div>
                          <strong>{title}</strong>
                          <p>{body}</p>
                        </div>
                      </li>
                    ))}
                  </ol>
                  {reservation?.state === "HOLD" && (
                    <p className="notice">
                      Temporary hold ends{" "}
                      {reservation.expiresAt?.toLocaleString("en-ZA", {
                        timeZone: "Africa/Harare",
                      })}
                      . An expired hold does not guarantee a bed.
                    </p>
                  )}
                  {active.decisionReason && (
                    <p className="notice">
                      Review note: {active.decisionReason}
                    </p>
                  )}
                  {!["ACTIVE", "READY_FOR_MOVE_IN"].includes(active.status) && (
                    <details>
                      <summary>Withdraw application</summary>
                      <ActionForm action="application.withdraw" id={active.id}>
                        <label>
                          Reason
                          <input name="reason" required />
                        </label>
                        <button className="text-button danger">
                          Withdraw and release reservation
                        </button>
                      </ActionForm>
                      <p className="small muted">
                        Any deposit disposition is reviewed separately under the
                        approved cancellation policy.
                      </p>
                    </details>
                  )}
                  <details>
                    <summary>Application history</summary>
                    {active.history.map((h) => (
                      <p key={h.id} className="small">
                        {h.createdAt.toISOString().slice(0, 10)} · {h.status} ·{" "}
                        {h.reason}
                      </p>
                    ))}
                  </details>
                </>
              )}
            </section>
            <section className="panel">
              <div className="panel-head">
                <h2>Updates for you</h2>
                <Bell size={18} />
              </div>
              {notices.length ? (
                notices.map((n) => (
                  <div className="update-item" key={n.id}>
                    <span className="update-icon">
                      <Bell size={16} />
                    </span>
                    <div>
                      <strong>{n.title}</strong>
                      <p>{n.body}</p>
                      <small>{n.createdAt.toLocaleDateString("en-ZA")}</small>
                    </div>
                  </div>
                ))
              ) : (
                <Empty
                  title="All caught up"
                  body="Application, payment, and support updates will appear here."
                />
              )}
            </section>
          </div>
          <section id="account" className="panel">
            <div className="panel-head">
              <h2>Your account</h2>
              <Badge>Transparent, verified payments</Badge>
            </div>
            {active &&
              totals &&
              totals.credit > 0n &&
              totals.outstanding > 0n && (
                <ActionForm
                  action="credit.apply"
                  propertyId={active.propertyId}
                  userId={u.id}
                >
                  <p className="notice">
                    You have {money(totals.credit)} in verified unallocated
                    funds.
                  </p>
                  <button className="button secondary">
                    Apply available credit to open invoices
                  </button>
                </ActionForm>
              )}
            {totals?.lines.length ? (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Invoice</th>
                      <th>Description</th>
                      <th>Due</th>
                      <th>Amount</th>
                      <th>Outstanding</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {totals.lines.map((c) => (
                      <tr key={c.id}>
                        <td>{c.reference}</td>
                        <td>{c.description}</td>
                        <td>{c.dueAt.toISOString().slice(0, 10)}</td>
                        <td>{money(c.amountMinor, c.currency)}</td>
                        <td>{money(c.remaining, c.currency)}</td>
                        <td>
                          <a
                            className="text-link"
                            href={`/api/financial/invoice/${c.id}`}
                          >
                            PDF ↗
                          </a>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="muted">No invoices yet.</p>
            )}
            {active && totals && totals.outstanding > 0n && (
              <ActionForm
                action="payment"
                userId={u.id}
                propertyId={active.propertyId}
                idempotencyKey={crypto.randomUUID()}
              >
                <div className="inline-fields">
                  <label>
                    Amount ({active.property.currency})
                    <input
                      name="amount"
                      defaultValue={`${totals.outstanding / 100n}.${String(totals.outstanding % 100n).padStart(2, "0")}`}
                      pattern="[0-9]+(\.[0-9]{1,2})?"
                      required
                    />
                  </label>
                  <label>
                    Payment method
                    <select name="method">
                      <option value="BANK">Bank transfer · proof review</option>
                      <option value="PAYNOW">
                        Paynow · requires live configuration
                      </option>
                    </select>
                  </label>
                  <label>
                    Scanned proof
                    <select name="proofDocumentId">
                      <option value="">Choose uploaded proof</option>
                      {documents
                        .filter(
                          (d) =>
                            d.kind === "PAYMENT_PROOF" &&
                            ["CLEAN", "APPROVED"].includes(d.state),
                        )
                        .map((d) => (
                          <option key={d.id} value={d.id}>
                            {d.filename}
                          </option>
                        ))}
                    </select>
                  </label>
                  <label>
                    Bank reference
                    <input name="bankReference" />
                  </label>
                  <button className="button">
                    Submit payment <ArrowUpRight size={16} />
                  </button>
                </div>
                <p className="small muted">
                  Uploading evidence does not confirm payment. Finance verifies
                  bank transfers; Paynow settlement is confirmed with the
                  provider.
                </p>
              </ActionForm>
            )}
            {payments.length > 0 && (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Payment</th>
                      <th>Method</th>
                      <th>Amount</th>
                      <th>Status</th>
                      <th>Receipt</th>
                    </tr>
                  </thead>
                  <tbody>
                    {payments.map((p) => (
                      <tr key={p.id}>
                        <td>{p.reference}</td>
                        <td>{p.method}</td>
                        <td>{money(p.amountMinor, p.currency)}</td>
                        <td>
                          <Badge tone={p.status === "PAID" ? "green" : ""}>
                            {p.status.toLowerCase()}
                          </Badge>
                        </td>
                        <td>
                          {p.receipt ? (
                            <a
                              className="text-link"
                              href={`/api/financial/receipt/${p.receipt.id}`}
                            >
                              Download PDF ↗
                            </a>
                          ) : (
                            "Pending verification"
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
          <section id="documents" className="panel">
            <div className="panel-head">
              <h2>Documents & agreements</h2>
              <ShieldCheck size={19} />
            </div>
            <p className="muted">
              Private, encrypted uploads. Files remain quarantined until malware
              scanning succeeds. PDF, PNG or JPEG, up to 10 MB.
            </p>
            {active && (
              <form
                action="/api/actions"
                method="post"
                encType="multipart/form-data"
                className="inline-fields"
              >
                <input type="hidden" name="action" value="upload" />
                <input type="hidden" name="next" value="/portal" />
                <input
                  type="hidden"
                  name="propertyId"
                  value={active.propertyId}
                />
                <input type="hidden" name="applicationId" value={active.id} />
                <label>
                  Document type
                  <select name="kind">
                    {[
                      "IDENTITY",
                      "RESIDENCE",
                      "REGISTRATION",
                      "SPONSOR",
                      "MEDICAL",
                      "PAYMENT_PROOF",
                      "SIGNED_LEASE",
                      "SUPPORT",
                    ].map((k) => (
                      <option key={k}>{k}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Choose file
                  <input
                    type="file"
                    name="file"
                    accept=".pdf,.png,.jpg,.jpeg"
                    required
                  />
                </label>
                <label className="check-label">
                  <input type="checkbox" name="medicalConsent" />
                  For medical uploads only: I explicitly consent to authorized
                  medical reviewers processing this voluntary declaration for
                  accommodation support, separately from standard KYC.
                </label>
                <button className="button secondary">
                  Upload securely <ArrowUpRight size={16} />
                </button>
              </form>
            )}
            <div className="document-list">
              {documents.map((d) => (
                <div key={d.id}>
                  <div>
                    <FileText size={20} />
                    <span>
                      <strong>{d.kind.replaceAll("_", " ")}</strong>
                      <small>
                        {d.filename} · version {d.version}
                        {d.reason ? ` · ${d.reason}` : ""}
                      </small>
                    </span>
                  </div>
                  <Badge
                    tone={
                      d.state === "APPROVED"
                        ? "green"
                        : d.state === "REJECTED"
                          ? "red"
                          : ""
                    }
                  >
                    {d.state.toLowerCase()}
                  </Badge>
                  {["CLEAN", "APPROVED"].includes(d.state) && (
                    <a href={`/api/documents/${d.id}`} className="text-button">
                      Download ↗
                    </a>
                  )}
                </div>
              ))}
            </div>
            {leases.map((l) => (
              <div key={l.id} className="lease-card">
                <div className="panel-head">
                  <h3>Room {l.reservation.bed.room.name} · Lease</h3>
                  <Badge tone="green">
                    {l.status.replaceAll("_", " ").toLowerCase()}
                  </Badge>
                </div>
                <a className="text-link" href={`/api/financial/lease/${l.id}`}>
                  Download agreement PDF ↗
                </a>
                <p className="small muted">
                  Document fingerprint: {l.documentHash}
                </p>
                {l.status === "AWAITING_SIGNATURE" && (
                  <ActionForm action="lease.sign" id={l.id}>
                    <label>
                      Scanned signed agreement
                      <select name="documentId" required>
                        <option value="">Choose your signed upload</option>
                        {documents
                          .filter(
                            (d) =>
                              d.kind === "SIGNED_LEASE" &&
                              ["CLEAN", "APPROVED"].includes(d.state),
                          )
                          .map((d) => (
                            <option key={d.id} value={d.id}>
                              {d.filename}
                            </option>
                          ))}
                      </select>
                    </label>
                    <label className="check-label">
                      <input name="consent" type="checkbox" required />I confirm
                      this is my signed copy of the agreement presented.
                    </label>
                    <button className="button">
                      Submit for execution review
                    </button>
                  </ActionForm>
                )}
                {l.status === "EXECUTED" && (
                  <ActionForm action="exit" id={l.id}>
                    <label>
                      Notice or renewal/transfer request
                      <textarea name="reason" required minLength={10} />
                    </label>
                    <button className="button secondary">
                      Send tenancy request
                    </button>
                  </ActionForm>
                )}
                {l.status === "EXECUTED" && (
                  <ActionForm action="tenancy.request" leaseId={l.id}>
                    <h3>Renew or transfer your stay</h3>
                    <div className="inline-fields">
                      <label>
                        Request type
                        <select name="type">
                          <option>RENEWAL</option>
                          <option>TRANSFER</option>
                        </select>
                      </label>
                      <label>
                        Target bed ID
                        <input
                          name="targetBedId"
                          defaultValue={l.reservation.bedId}
                          required
                        />
                      </label>
                      <label>
                        New start date
                        <input
                          name="startAt"
                          type="date"
                          defaultValue={l.reservation.endAt
                            .toISOString()
                            .slice(0, 10)}
                          required
                        />
                      </label>
                      <label>
                        New end date
                        <input name="endAt" type="date" required />
                      </label>
                    </div>
                    <label>
                      Reason
                      <textarea name="reason" required minLength={10} />
                    </label>
                    <button className="button secondary">
                      Request tenancy change
                    </button>
                  </ActionForm>
                )}
              </div>
            ))}
          </section>
          <section id="support" className="panel">
            <div className="panel-head">
              <h2>A little help goes a long way</h2>
              <Wrench size={19} />
            </div>
            {active && (
              <ActionForm action="ticket" propertyId={active.propertyId}>
                <div className="inline-fields">
                  <label>
                    Type
                    <select name="type">
                      {[
                        "MAINTENANCE",
                        "COMPLAINT",
                        "COMPLIMENT",
                        "SUPPORT",
                      ].map((t) => (
                        <option key={t}>{t}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Category
                    <input
                      name="category"
                      placeholder="e.g. Plumbing"
                      required
                    />
                  </label>
                  <label>
                    Priority
                    <select name="priority">
                      <option>NORMAL</option>
                      <option>HIGH</option>
                      <option>URGENT</option>
                    </select>
                  </label>
                  <label>
                    Subject
                    <input
                      name="subject"
                      required
                      minLength={4}
                      maxLength={160}
                    />
                  </label>
                </div>
                <label>
                  Tell us what’s happening
                  <textarea
                    name="body"
                    required
                    minLength={10}
                    maxLength={5000}
                  />
                </label>
                <button className="button">
                  Create request <ArrowUpRight size={16} />
                </button>
              </ActionForm>
            )}
            {tickets.map((t) => (
              <details className="ticket-detail" key={t.id}>
                <summary>
                  <span>{t.subject}</span>
                  <Badge>{t.status.replaceAll("_", " ")}</Badge>
                </summary>
                <p>{t.body}</p>
                {t.messages.map((m) => (
                  <p className="ticket-message" key={m.id}>
                    {m.body}
                    <small>{m.createdAt.toLocaleString("en-ZA")}</small>
                  </p>
                ))}
                <ActionForm action="ticket.update" id={t.id}>
                  <input type="hidden" name="status" value="OPEN" />
                  <label>
                    Reply or reopen
                    <textarea name="body" required minLength={2} />
                  </label>
                  <button className="button secondary">Send reply</button>
                </ActionForm>
              </details>
            ))}
          </section>
          <section id="profile" className="panel">
            <div className="panel-head">
              <h2>Profile & security</h2>
              <ShieldCheck size={19} />
            </div>
            <p>
              {u.email} · Email {u.emailVerifiedAt ? "verified" : "unverified"}{" "}
              · Mobile {u.phoneVerifiedAt ? "verified" : "unverified"} · MFA{" "}
              {u.mfaConfirmed ? "enabled" : "not enabled"}
            </p>
            <ActionForm action="profile">
              <div className="inline-fields">
                <label>
                  Emergency contact name
                  <input
                    name="emergencyName"
                    defaultValue={u.emergencyName || ""}
                    required
                  />
                </label>
                <label>
                  Emergency contact mobile
                  <input
                    name="emergencyPhone"
                    defaultValue={u.emergencyPhone || ""}
                    placeholder="+263…"
                    required
                  />
                </label>
                <button className="button secondary">Update contact</button>
              </div>
            </ActionForm>
            <ActionForm action="privacy.request">
              <h3>Data access & privacy request</h3>
              <a className="text-link" href="/api/v1/me-export">
                Download your account data securely ↗
              </a>
              <div className="inline-fields">
                <label>
                  Request type
                  <select name="type">
                    <option>ACCESS</option>
                    <option>EXPORT</option>
                    <option>CORRECTION</option>
                    <option>ERASURE</option>
                  </select>
                </label>
                <label>
                  Details
                  <input name="reason" required />
                </label>
                <button className="button secondary">Submit request</button>
              </div>
            </ActionForm>
            {privacyRequests.map((r) => (
              <p className="small" key={r.id}>
                {r.type} · {r.state}:{" "}
                {r.resolution || "Awaiting privacy review"}
              </p>
            ))}
            <ActionForm action="preferences">
              <h3>Notification preferences</h3>
              <label className="check-label">
                <input type="checkbox" name="email" defaultChecked />
                Email notifications
              </label>
              <label className="check-label">
                <input type="checkbox" name="sms" />
                Optional SMS notifications (provider required)
              </label>
              <button className="button secondary">Save preferences</button>
            </ActionForm>
            <div className="inline-fields">
              <Link className="text-link" href="/auth">
                Set up authenticator ↗
              </Link>
              <ActionForm action="sessions.revoke">
                <button className="text-button danger">
                  Sign out of all sessions
                </button>
              </ActionForm>
            </div>
          </section>
        </main>
      </div>
    </div>
  );
}
