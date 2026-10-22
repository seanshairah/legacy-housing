import { PrivacyAdmin } from "../../../components/privacy-admin";
import { ReportPanel } from "../../../components/report-panel";
import { ApiKeyForm } from "../../../components/api-key-form";
import Link from "next/link";
import { redirect } from "next/navigation";
import {
  ArrowUpRight,
  Bell,
  Search,
  ShieldCheck,
  ChevronDown,
  Building2,
} from "lucide-react";
import { db } from "../../../lib/db";
import { requireUser } from "../../../lib/current-user";
import { rolePermissions } from "../../../domain/access";
import { money, account } from "../../../domain/finance";
import {
  Brand,
  PageHead,
  Stat,
  Badge,
  Empty,
  ActionForm,
  navItems,
} from "../../../components/ui";
export const dynamic = "force-dynamic";
export default async function Workspace({
  params,
  searchParams,
}: {
  params: Promise<{ section: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const u = await requireUser(),
    { section } = await params,
    q = await searchParams;
  if (!u.memberships.length) redirect("/portal");
  const capabilities = new Set(
    u.memberships.flatMap((m) => rolePermissions[m.role] || []),
  );
  const menu = navItems.filter((n) => capabilities.has(n.cap));
  if (section === "overview" && !capabilities.has("reports"))
    redirect(`/workspace/${menu[0]?.key || "overview"}`);
  const item = navItems.find((n) => n.key === section);
  if (section !== "overview" && (!item || !capabilities.has(item.cap)))
    redirect(`/workspace/${menu[0]?.key || "overview"}`);
  const permittedProperties = u.memberships
    .filter(
      (m) =>
        section === "overview" ||
        rolePermissions[m.role]?.includes(item?.cap || "reports"),
    )
    .map((m) => m.propertyId);
  const properties = await db.property.findMany({
      where: { id: { in: permittedProperties } },
      orderBy: { name: "asc" },
    }),
    selected = properties.find((p) => p.id === q.property) || properties[0];
  if (!selected) redirect("/portal");
  const p = selected.id,
    next = `/workspace/${section}`,
    needle = (q.search || "").slice(0, 80),
    page = Math.max(1, Math.min(10000, parseInt(q.page || "1") || 1)),
    skip = (page - 1) * 20;
  const supportFiles =
    section === "operations"
      ? await db.document.findMany({
          where: {
            userId: u.id,
            propertyId: p,
            kind: "SUPPORT",
            state: { in: ["CLEAN", "APPROVED"] },
          },
          select: { id: true, filename: true },
        })
      : [];
  const templates =
    section === "leases"
      ? await db.leaseTemplate.findMany({
          where: { propertyId: p, approvedAt: { not: null } },
          orderBy: { version: "desc" },
        })
      : [];
  const operators =
    section === "operations"
      ? await db.membership.findMany({
          where: {
            propertyId: p,
            role: { in: ["ADMIN", "CARETAKER", "PROPERTY_MANAGER"] },
          },
          include: { user: true },
        })
      : [];
  const title =
    (
      {
        overview: "A clearer view of home.",
        admissions: "Every application. A next step.",
        inventory: "Spaces, thoughtfully managed.",
        kyc: "Confidence in every document.",
        medical: "Sensitive evidence. Narrow access.",
        finance: "A clear account of everything.",
        leases: "From agreement to arrival.",
        operations: "Care that follows through.",
        integrations: "Connected, on your terms.",
        reports: "The details behind the picture.",
        security: "Trust, with a paper trail.",
        settings: "Make the platform yours.",
      } as Record<string, string>
    )[section] || "Workspace";
  const [beds, active, applicationsCount, openTickets] = await Promise.all([
    db.bed.count({
      where: { room: { floor: { building: { propertyId: p } } } },
    }),
    db.reservation.count({ where: { propertyId: p, state: "ACTIVE" } }),
    db.application.count({
      where: {
        propertyId: p,
        status: { in: ["SUBMITTED", "IN_REVIEW", "DOCUMENTS_PENDING"] },
      },
    }),
    db.ticket.count({
      where: { propertyId: p, status: { notIn: ["CLOSED", "RESOLVED"] } },
    }),
  ]);
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Brand />
        <div className="sidebar-label">PROPERTY WORKSPACE</div>
        <div className="property-switch">
          <Building2 size={18} />
          <span>{selected.name}</span>
          <ChevronDown size={14} />
        </div>
        <nav>
          {[
            { key: "overview", label: "Overview", icon: Building2, cap: "" },
            ...menu.filter((n) => n.key !== "overview"),
          ].map((n) => (
            <Link
              key={n.key}
              className={section === n.key ? "active" : ""}
              href={`/workspace/${n.key}?property=${p}`}
            >
              <n.icon size={18} />
              {n.label}
              {n.key === "admissions" && applicationsCount > 0 && (
                <span className="nav-count">{applicationsCount}</span>
              )}
            </Link>
          ))}
        </nav>
        <div className="sidebar-help">
          <ShieldCheck size={22} />
          <strong>A workspace built on trust.</strong>
          <p>
            Permissions, evidence, and activity stay connected to each property.
          </p>
          <Link href="/portal">Open resident portal ↗</Link>
        </div>
        <div className="sidebar-bottom">
          <div className="avatar">{u.name[0]}</div>
          <div>
            <strong>{u.name}</strong>
            <small>
              {u.memberships
                .map((m) => m.role)
                .filter((v, i, a) => a.indexOf(v) === i)
                .join(" · ")}
            </small>
          </div>
        </div>
      </aside>
      <div className="app-main">
        <header className="app-topbar">
          <span>
            Workspace{" "}
            <span className="muted">/ {item?.label || "Overview"}</span>
          </span>
          <div>
            <span className="topbar-date">
              {new Date().toLocaleDateString("en-ZA", {
                day: "numeric",
                month: "long",
                year: "numeric",
                timeZone: "Africa/Harare",
              })}
            </span>
            <Bell size={18} />
            <div className="avatar small-avatar">{u.name[0]}</div>
          </div>
        </header>
        <main id="main" className="workspace-content">
          <PageHead
            eyebrow="LEGACY HEIGHTS / OPERATIONS"
            title={title}
            description={`${selected.name} · ${section === "overview" ? "Your property, people, and priorities at a glance." : "Real records, scoped to your property and permissions."}`}
            action={
              <Link href="/rooms" className="button secondary">
                View catalogue <ArrowUpRight size={17} />
              </Link>
            }
          />
          {q.error && (
            <p role="alert" className="notice error">
              {q.error.replaceAll("_", " ").toLowerCase()}
            </p>
          )}
          {q.success && (
            <p role="status" className="notice">
              {q.success}
            </p>
          )}
          {selected.slug.startsWith("demo-") && (
            <p className="demo-note">
              Local development · synthetic property data · no live payments or
              client documents
            </p>
          )}
          <form method="get" className="workspace-filters">
            <label className="search-input">
              <Search size={16} />
              <input
                name="search"
                aria-label="Search records"
                defaultValue={needle}
                placeholder="Search this workspace…"
              />
            </label>
            <label className="sr-only" htmlFor="property">
              Property
            </label>
            <select name="property" id="property" defaultValue={p}>
              {properties.map((property) => (
                <option key={property.id} value={property.id}>
                  {property.name}
                </option>
              ))}
            </select>
            <button className="button secondary small-button">
              Apply filters
            </button>
          </form>
          {section === "overview" && (
            <>
              <div className="stats-grid">
                <Stat
                  label="Occupancy"
                  value={`${beds ? Math.round((active / beds) * 100) : 0}%`}
                  note={`${active} occupied of ${beds} beds`}
                />
                <Stat
                  label="Applications to review"
                  value={applicationsCount}
                  note="Submitted and in-review records"
                />
                <Stat
                  label="Open service requests"
                  value={openTickets}
                  note="Awaiting resolution"
                />
                <Stat
                  label="Available capacity"
                  value={beds - active}
                  note="Before holds, blocks, and date filters"
                />
              </div>
              <div className="dashboard-grid">
                <section className="panel">
                  <div className="panel-head">
                    <h2>Property at a glance</h2>
                    <Badge tone="green">Live records</Badge>
                  </div>
                  <div className="occupancy-visual">
                    <div
                      className="occupancy-ring"
                      style={
                        {
                          "--progress": `${beds ? (active / beds) * 100 : 0}%`,
                        } as React.CSSProperties
                      }
                    >
                      <strong>
                        {beds ? Math.round((active / beds) * 100) : 0}%
                      </strong>
                      <span>occupied</span>
                    </div>
                    <div>
                      <h3>Room to make a difference.</h3>
                      <p className="muted">
                        Use the catalogue’s stay dates to see actual
                        availability. Occupancy reflects checked-in residents.
                      </p>
                      <div className="legend">
                        <span>
                          <i />
                          Occupied {active}
                        </span>
                        <span>
                          <i />
                          Other spaces {beds - active}
                        </span>
                      </div>
                    </div>
                  </div>
                </section>
                <section className="panel">
                  <div className="panel-head">
                    <h2>Your priorities</h2>
                    <span className="muted small">TODAY</span>
                  </div>
                  {menu
                    .filter((n) =>
                      [
                        "admissions",
                        "kyc",
                        "finance",
                        "operations",
                        "leases",
                      ].includes(n.key),
                    )
                    .map((n) => (
                      <Link
                        className="priority-link"
                        key={n.key}
                        href={`/workspace/${n.key}?property=${p}`}
                      >
                        <span className="update-icon">
                          <n.icon size={18} />
                        </span>
                        <span>
                          <strong>{n.label}</strong>
                          <small>Open your property queue</small>
                        </span>
                        <ArrowUpRight size={17} />
                      </Link>
                    ))}
                </section>
              </div>
              <section className="panel">
                <div className="panel-head">
                  <h2>Recent property activity</h2>
                  <Badge>Auditable actions</Badge>
                </div>
                {capabilities.has("audit") ? (
                  <AuditRows propertyId={p} />
                ) : (
                  <p className="muted">
                    Detailed activity is available to authorized administrators
                    and auditors. Your action results appear in each workspace.
                  </p>
                )}
              </section>
            </>
          )}
          {section === "admissions" && (
            <section className="panel">
              <div className="panel-head">
                <h2>Applications queue</h2>
                <Badge>{applicationsCount} awaiting review</Badge>
              </div>
              {(
                await db.application.findMany({
                  where: {
                    propertyId: p,
                    ...(needle
                      ? {
                          user: {
                            name: { contains: needle, mode: "insensitive" },
                          },
                        }
                      : {}),
                  },
                  include: {
                    user: true,
                    documents: true,
                    reservations: {
                      include: { bed: { include: { room: true } } },
                    },
                  },
                  orderBy: { createdAt: "desc" },
                  skip,
                  take: 20,
                })
              ).map((a) => (
                <div key={a.id} className="record-card">
                  <div className="panel-head">
                    <div>
                      <h3>{a.user.name}</h3>
                      <p className="muted small">
                        {a.user.email} · {a.user.residentType} ·{" "}
                        {a.createdAt.toISOString().slice(0, 10)}
                      </p>
                    </div>
                    <Badge>{a.status.replaceAll("_", " ").toLowerCase()}</Badge>
                  </div>
                  <p className="small">
                    Documents approved:{" "}
                    {a.documents.filter((d) => d.state === "APPROVED").length} ·{" "}
                    {a.reservations
                      .map(
                        (r) =>
                          `${r.bed.room.name} / ${r.bed.label}: ${r.state}`,
                      )
                      .join(" · ")}
                  </p>
                  {["SUBMITTED", "IN_REVIEW", "DOCUMENTS_PENDING"].includes(
                    a.status,
                  ) && (
                    <ActionForm
                      action="application.review"
                      next={next}
                      id={a.id}
                    >
                      <div className="inline-fields">
                        <label>
                          Decision
                          <select name="decision">
                            <option value="APPROVED">
                              Approve (requires approved KYC)
                            </option>
                            <option value="DECLINED">Decline</option>
                          </select>
                        </label>
                        <label>
                          Review reason
                          <input name="reason" required />
                        </label>
                        <button className="button small-button">
                          Record decision
                        </button>
                      </div>
                    </ActionForm>
                  )}
                  {a.reservations.some((r) => r.state === "EXPIRED") && (
                    <ActionForm action="reselect" next={next} id={a.id}>
                      <label>
                        New bed ID (from inventory)
                        <input name="bedId" required />
                      </label>
                      <button className="button secondary">
                        Offer new hold
                      </button>
                    </ActionForm>
                  )}
                </div>
              ))}
            </section>
          )}
          {section === "inventory" && (
            <>
              <section className="panel">
                <div className="panel-head">
                  <h2>Buildings, floors & individual spaces</h2>
                  <Badge>{beds} beds</Badge>
                </div>
                {(
                  await db.building.findMany({
                    where: { propertyId: p },
                    include: {
                      floors: {
                        orderBy: { level: "asc" },
                        include: {
                          rooms: {
                            include: {
                              beds: {
                                include: {
                                  reservations: {
                                    where: {
                                      state: {
                                        in: ["ACTIVE", "CONFIRMED", "HOLD"],
                                      },
                                    },
                                  },
                                },
                              },
                            },
                          },
                        },
                      },
                    },
                  })
                ).map((b) => (
                  <div key={b.id}>
                    <h3>{b.name}</h3>
                    {b.floors.map((f) => (
                      <div key={f.id}>
                        <div className="floor-heading">
                          <strong>{f.name}</strong>
                        </div>
                        <div className="inventory-grid">
                          {f.rooms.map((r) => (
                            <div className="inventory-room" key={r.id}>
                              <div className="panel-head">
                                <strong>Room {r.name}</strong>
                                <Badge>{r.category}</Badge>
                              </div>
                              <p className="muted small">
                                {money(r.monthlyMinor, selected.currency)} /
                                month
                              </p>
                              {r.beds.map((bed) => (
                                <div className="bed-row" key={bed.id}>
                                  <div>
                                    <strong>{bed.label}</strong>
                                    <small>{bed.id}</small>
                                  </div>
                                  <Badge
                                    tone={
                                      bed.blocked
                                        ? "red"
                                        : bed.reservations.length
                                          ? ""
                                          : "green"
                                    }
                                  >
                                    {bed.blocked
                                      ? "Blocked"
                                      : bed.reservations.length
                                        ? "Committed"
                                        : "Uncommitted"}
                                  </Badge>
                                  <ActionForm
                                    action="bed.block"
                                    next={next}
                                    id={bed.id}
                                    blocked={String(!bed.blocked)}
                                  >
                                    <input
                                      name="reason"
                                      placeholder="Reason"
                                      aria-label={`Reason to change ${bed.label}`}
                                      required
                                    />
                                    <button className="text-button">
                                      {bed.blocked ? "Release" : "Block"}
                                    </button>
                                  </ActionForm>
                                </div>
                              ))}
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                ))}
              </section>
              <section className="panel">
                <h2>Dated room / bed / term pricing</h2>
                <p className="muted">
                  Rules apply to new reservations only. Higher-specificity
                  bed/room rules take precedence, then priority and term length.
                  Existing reservations keep their price snapshot.
                </p>
                <ActionForm action="rateplan" next={next} propertyId={p}>
                  <div className="inline-fields">
                    <label>
                      Rule title
                      <input name="title" required minLength={3} />
                    </label>
                    <label>
                      Room ID (optional)
                      <input name="roomId" />
                    </label>
                    <label>
                      Bed ID (optional)
                      <input name="bedId" />
                    </label>
                    <label>
                      From
                      <input name="startAt" type="date" required />
                    </label>
                    <label>
                      Until (exclusive)
                      <input name="endAt" type="date" required />
                    </label>
                    <label>
                      Minimum nights
                      <input
                        name="minNights"
                        type="number"
                        defaultValue="1"
                        min="1"
                        max="732"
                        required
                      />
                    </label>
                    <label>
                      Priority
                      <input
                        name="priority"
                        type="number"
                        defaultValue="0"
                        min="0"
                        max="100"
                        required
                      />
                    </label>
                    <label>
                      Monthly rate
                      <input name="amount" required />
                    </label>
                    <button className="button secondary">
                      Create dated price rule
                    </button>
                  </div>
                </ActionForm>
              </section>
              <section className="panel">
                <h2>Add room & beds</h2>
                <ActionForm action="inventory.add" next={next} propertyId={p}>
                  <div className="inline-fields">
                    {[
                      ["building", "Building"],
                      ["floor", "Floor name"],
                      ["level", "Floor number"],
                      ["room", "Room name"],
                      ["beds", "Number of beds"],
                      ["monthly", `Monthly price (${selected.currency})`],
                    ].map(([name, label]) => (
                      <label key={name}>
                        {label}
                        <input name={name} required />
                      </label>
                    ))}
                    <label>
                      Category
                      <select name="category">
                        {["SINGLE", "SHARED", "PREMIUM", "ACCESSIBLE"].map(
                          (c) => (
                            <option key={c}>{c}</option>
                          ),
                        )}
                      </select>
                    </label>
                    <button className="button">Add inventory</button>
                  </div>
                </ActionForm>
              </section>
            </>
          )}
          {["kyc", "medical"].includes(section) && (
            <section className="panel">
              <div className="panel-head">
                <h2>Document review</h2>
                <Badge>Medical access is separately controlled</Badge>
              </div>
              {(
                await db.document.findMany({
                  where: {
                    propertyId: p,
                    kind:
                      section === "medical"
                        ? "MEDICAL"
                        : {
                            notIn: ["MEDICAL", "PAYMENT_PROOF", "SIGNED_LEASE"],
                          },
                    ...(needle
                      ? {
                          user: {
                            name: { contains: needle, mode: "insensitive" },
                          },
                        }
                      : {}),
                  },
                  include: { user: true },
                  orderBy: { createdAt: "desc" },
                  skip,
                  take: 20,
                })
              ).map((d) => (
                <div key={d.id} className="record-card">
                  <div className="panel-head">
                    <div>
                      <h3>
                        {d.user.name} · {d.kind}
                      </h3>
                      <p className="muted small">
                        {d.filename} · v{d.version} · {d.bytes} bytes
                      </p>
                    </div>
                    <Badge tone={d.state === "APPROVED" ? "green" : ""}>
                      {d.state}
                    </Badge>
                  </div>
                  {["CLEAN", "APPROVED"].includes(d.state) && (
                    <a className="text-link" href={`/api/documents/${d.id}`}>
                      Secure download ↗
                    </a>
                  )}
                  {d.state === "CLEAN" && (
                    <ActionForm action="document.review" next={next} id={d.id}>
                      <div className="inline-fields">
                        <label>
                          Decision
                          <select name="decision">
                            <option>APPROVED</option>
                            <option>REJECTED</option>
                          </select>
                        </label>
                        <label>
                          Reason
                          <input name="reason" required />
                        </label>
                        <button className="button small-button">
                          Record review
                        </button>
                      </div>
                    </ActionForm>
                  )}
                  {d.scanResult && (
                    <p className="small muted">Scanner: {d.scanResult}</p>
                  )}
                </div>
              ))}
            </section>
          )}
          {section === "finance" && (
            <Finance
              propertyId={p}
              next={next}
              canWrite={capabilities.has("finance")}
              search={needle}
              skip={skip}
            />
          )}
          {section === "leases" && (
            <section className="panel">
              <div className="panel-head">
                <h2>Leasing & residency</h2>
                <Badge>Immutable executed agreements</Badge>
              </div>
              {(
                await db.tenancyRequest.findMany({
                  where: { propertyId: p, state: "PENDING" },
                  take: 20,
                  orderBy: { createdAt: "asc" },
                })
              ).map((r) => (
                <div className="record-card" key={r.id}>
                  <h3>{r.type} request</h3>
                  <p>{r.reason}</p>
                  <p className="small muted">
                    {r.startAt.toISOString().slice(0, 10)} —{" "}
                    {r.endAt.toISOString().slice(0, 10)} · resident {r.userId}
                  </p>
                  <ActionForm action="tenancy.review" next={next} id={r.id}>
                    <div className="inline-fields">
                      <label>
                        Decision
                        <select name="decision">
                          <option>APPROVED</option>
                          <option>DECLINED</option>
                        </select>
                      </label>
                      <label>
                        Review reason
                        <input name="reason" required />
                      </label>
                      <button className="button secondary">
                        Review request
                      </button>
                    </div>
                  </ActionForm>
                </div>
              ))}
              {(
                await db.application.findMany({
                  where: {
                    propertyId: p,
                    status: "LEASE_SIGNING_PENDING",
                    lease: null,
                  },
                  include: { user: true },
                })
              ).map((a) => (
                <div key={a.id} className="record-card">
                  <h3>{a.user.name} · Ready for agreement</h3>
                  <ActionForm
                    action="lease.issue"
                    next={next}
                    applicationId={a.id}
                  >
                    <div className="inline-fields">
                      <label>
                        Approved template
                        <select name="templateId" required>
                          {templates.map((t) => (
                            <option key={t.id} value={t.id}>
                              {t.title} · v{t.version}
                            </option>
                          ))}
                        </select>
                      </label>
                      <button className="button small-button">
                        Issue lease
                      </button>
                    </div>
                  </ActionForm>
                </div>
              ))}
              {(
                await db.lease.findMany({
                  where: { propertyId: p },
                  include: {
                    user: true,
                    reservation: {
                      include: { bed: { include: { room: true } } },
                    },
                    events: { orderBy: { createdAt: "desc" } },
                  },
                  orderBy: { createdAt: "desc" },
                  skip,
                  take: 20,
                })
              ).map((l) => (
                <div key={l.id} className="record-card">
                  <div className="panel-head">
                    <div>
                      <h3>
                        {l.user.name} · Room {l.reservation.bed.room.name}
                      </h3>
                      <p className="small muted">
                        {l.reservation.startAt.toISOString().slice(0, 10)} —{" "}
                        {l.reservation.endAt.toISOString().slice(0, 10)}
                      </p>
                    </div>
                    <Badge>
                      {l.status} / {l.reservation.state}
                    </Badge>
                  </div>
                  <a
                    className="text-link"
                    href={`/api/financial/lease/${l.id}`}
                  >
                    Agreement PDF ↗
                  </a>
                  {l.signedDocumentId && (
                    <a
                      className="text-link"
                      href={`/api/documents/${l.signedDocumentId}`}
                    >
                      {" "}
                      Signed evidence ↗
                    </a>
                  )}
                  {l.status === "REVIEW" && (
                    <ActionForm action="lease.execute" next={next} id={l.id}>
                      <label>
                        Signing evidence review
                        <input name="reason" required />
                      </label>
                      <button className="button">Approve execution</button>
                    </ActionForm>
                  )}
                  {l.status === "EXECUTED" &&
                    l.reservation.state === "CONFIRMED" && (
                      <ActionForm action="checkin" next={next} id={l.id}>
                        <button className="button">
                          Check in (validates requirements)
                        </button>
                      </ActionForm>
                    )}
                  {l.reservation.state === "ACTIVE" && (
                    <ActionForm action="checkout" next={next} id={l.id}>
                      <label>
                        Move-out inspection / deposit disposition
                        <textarea name="reason" required />
                      </label>
                      <button className="button secondary">
                        Check out & block for turnover
                      </button>
                    </ActionForm>
                  )}
                  <details>
                    <summary>Evidence trail</summary>
                    {l.events.map((e) => (
                      <p key={e.id} className="small">
                        {e.type} · {e.createdAt.toISOString()} ·{" "}
                        {JSON.stringify(e.evidence)}
                      </p>
                    ))}
                  </details>
                </div>
              ))}
            </section>
          )}
          {section === "operations" && (
            <section className="panel">
              <div className="panel-head">
                <h2>Service, feedback & complaints</h2>
                <Badge>{openTickets} open</Badge>
              </div>
              <form
                action="/api/actions"
                method="post"
                encType="multipart/form-data"
                className="inline-fields"
              >
                <input type="hidden" name="action" value="upload" />
                <input type="hidden" name="next" value={next} />
                <input type="hidden" name="propertyId" value={p} />
                <input type="hidden" name="kind" value="SUPPORT" />
                <label>
                  Upload a support attachment
                  <input
                    name="file"
                    type="file"
                    accept=".pdf,.png,.jpg,.jpeg"
                    required
                  />
                </label>
                <button className="button secondary">
                  Upload for scanning
                </button>
              </form>
              {(
                await db.ticket.findMany({
                  where: {
                    propertyId: p,
                    ...(needle
                      ? { subject: { contains: needle, mode: "insensitive" } }
                      : {}),
                  },
                  include: {
                    user: true,
                    messages: { orderBy: { createdAt: "asc" } },
                  },
                  orderBy: { createdAt: "desc" },
                  skip,
                  take: 20,
                })
              ).map((t) => (
                <div className="record-card" key={t.id}>
                  <div className="panel-head">
                    <div>
                      <h3>{t.subject}</h3>
                      <p className="small muted">
                        {t.user.name} · {t.type} · {t.category} · {t.priority}
                      </p>
                    </div>
                    <Badge
                      tone={
                        t.dueAt < new Date() &&
                        !["RESOLVED", "CLOSED"].includes(t.status)
                          ? "red"
                          : ""
                      }
                    >
                      {t.status}
                    </Badge>
                  </div>
                  <p>{t.body}</p>
                  <p className="small muted">
                    SLA due {t.dueAt.toISOString()} · First response{" "}
                    {t.firstResponseAt?.toISOString() || "pending"}
                  </p>
                  {t.messages.map((m) => (
                    <p className="ticket-message" key={m.id}>
                      {m.body}
                      {m.documentId && (
                        <a
                          className="text-link"
                          href={`/api/documents/${m.documentId}`}
                        >
                          {" "}
                          Download attachment ↗
                        </a>
                      )}
                    </p>
                  ))}
                  <ActionForm action="ticket.update" next={next} id={t.id}>
                    <div className="inline-fields">
                      <label>
                        Status
                        <select name="status" defaultValue={t.status}>
                          {[
                            "OPEN",
                            "IN_PROGRESS",
                            "WAITING",
                            "RESOLVED",
                            "CLOSED",
                          ].map((s) => (
                            <option key={s}>{s}</option>
                          ))}
                        </select>
                      </label>
                      <label>
                        Assign to
                        <select name="assignedTo">
                          <option value="">Keep assignment</option>
                          {operators.map((m) => (
                            <option key={m.id} value={m.userId}>
                              {m.user.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        Scanned attachment
                        <select name="documentId">
                          <option value="">No attachment</option>
                          {supportFiles.map((d) => (
                            <option key={d.id} value={d.id}>
                              {d.filename}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        Update / response
                        <textarea name="body" required minLength={2} />
                      </label>
                      <button className="button small-button">
                        Update request
                      </button>
                    </div>
                  </ActionForm>
                </div>
              ))}
            </section>
          )}
          {section === "integrations" && <Integrations propertyId={p} />}
          {section === "reports" && (
            <ReportPanel
              propertyId={p}
              filters={q}
              canReadFinance={u.memberships.some(
                (m) =>
                  m.propertyId === p &&
                  rolePermissions[m.role]?.includes("finance.read"),
              )}
            />
          )}
          {section === "security" && (
            <>
              <section className="panel">
                <div className="panel-head">
                  <h2>Append-only activity record</h2>
                  <Badge>Property scoped</Badge>
                </div>
                <AuditRows propertyId={p} />
              </section>
              <section className="panel">
                <h2>Delivery & worker exceptions</h2>
                {(
                  await db.outboxEvent.findMany({
                    where: {
                      propertyId: p,
                      state: { in: ["DEAD", "PENDING"] },
                    },
                    take: 30,
                    orderBy: { createdAt: "desc" },
                  })
                ).map((e) => (
                  <div className="record-card" key={e.id}>
                    <strong>{e.type}</strong>
                    <p className="small muted">
                      {e.state} · {e.attempts} attempts ·{" "}
                      {e.lastError || "Queued"}
                    </p>
                    {capabilities.has("settings") && (
                      <ActionForm action="job.retry" next={next} id={e.id}>
                        <button className="button secondary small-button">
                          Retry delivery
                        </button>
                      </ActionForm>
                    )}
                  </div>
                ))}
              </section>
            </>
          )}
          {section === "settings" && (
            <>
              <Settings propertyId={p} next={next} />
              <PrivacyAdmin actor={u} />
            </>
          )}
          {!["overview", "integrations", "settings", "reports"].includes(
            section,
          ) && (
            <div className="pagination">
              {page > 1 && (
                <Link
                  href={`${next}?property=${p}&page=${page - 1}&search=${encodeURIComponent(needle)}`}
                >
                  ← Previous
                </Link>
              )}
              <span>Page {page} · up to 20 records</span>
              <Link
                href={`${next}?property=${p}&page=${page + 1}&search=${encodeURIComponent(needle)}`}
              >
                Next →
              </Link>
            </div>
          )}
          <div className="workspace-footer">
            <span>LEGACY HEIGHTS · CONSIDERED LIVING</span>
            <span>Connected records. Clearer decisions.</span>
          </div>
        </main>
      </div>
    </div>
  );
}
async function AuditRows({ propertyId }: { propertyId: string }) {
  const rows = await db.auditEvent.findMany({
    where: { propertyId },
    orderBy: { createdAt: "desc" },
    take: 30,
  });
  return rows.length ? (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>When</th>
            <th>Activity</th>
            <th>Actor</th>
            <th>Reference</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((a) => (
            <tr key={a.id}>
              <td>
                {a.createdAt.toISOString().replace("T", " ").slice(0, 19)}
              </td>
              <td>{a.action}</td>
              <td>{a.actorId}</td>
              <td>
                <code>{a.objectId.slice(0, 16)}</code>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ) : (
    <Empty
      title="A clean page"
      body="Property actions will appear here with their actor, time, and reference."
    />
  );
}
async function Finance({
  propertyId: p,
  next,
  canWrite,
  search,
  skip,
}: {
  propertyId: string;
  next: string;
  canWrite: boolean;
  search: string;
  skip: number;
}) {
  const residents = await db.application.findMany({
      where: { propertyId: p, status: { notIn: ["DECLINED", "WITHDRAWN"] } },
      include: { user: true },
    }),
    payments = await db.payment.findMany({
      where: {
        propertyId: p,
        ...(search
          ? { user: { name: { contains: search, mode: "insensitive" } } }
          : {}),
      },
      include: { user: true, receipt: true, refunds: true },
      orderBy: { createdAt: "desc" },
      skip,
      take: 20,
    });
  const proofGroups = await db.payment.groupBy({
    by: ["proofHash"],
    where: { propertyId: p, proofHash: { not: null } },
    _count: { proofHash: true },
  });
  const duplicateProofs = new Set(
    proofGroups
      .filter((row) => row._count.proofHash > 1)
      .map((row) => row.proofHash),
  );
  return (
    <>
      {canWrite && (
        <section className="panel">
          <h2>Record received cash for independent verification</h2>
          <p className="muted">
            Staff only. This creates a pending tender, not a settled payment. A
            separate reviewer verifies the cash/voucher when maker-checker is
            enabled.
          </p>
          <ActionForm
            action="payment"
            next={next}
            propertyId={p}
            method="CASH"
            idempotencyKey={crypto.randomUUID()}
          >
            <div className="inline-fields">
              <label>
                Resident
                <select name="userId">
                  {residents.map((a) => (
                    <option key={a.id} value={a.userId}>
                      {a.user.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Amount received
                <input name="amount" required />
              </label>
              <label>
                Unique cash voucher reference
                <input name="bankReference" required />
              </label>
              <button className="button secondary">
                Submit cash tender for verification
              </button>
            </div>
          </ActionForm>
        </section>
      )}
      <section className="panel">
        <div className="panel-head">
          <h2>Resident accounts</h2>
          <Badge>Balances derived from postings</Badge>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Resident</th>
                <th>Outstanding</th>
                <th>Unallocated credit</th>
              </tr>
            </thead>
            <tbody>
              {await Promise.all(
                residents.map(async (a) => {
                  const t = await account(a.userId, p);
                  return (
                    <tr key={a.id}>
                      <td>{a.user.name}</td>
                      <td>{money(t.outstanding)}</td>
                      <td>{money(t.credit)}</td>
                    </tr>
                  );
                }),
              )}
            </tbody>
          </table>
        </div>
      </section>
      {canWrite && (
        <section className="panel">
          <h2>Issue invoice / charge</h2>
          <ActionForm action="charge" next={next} propertyId={p}>
            <div className="inline-fields">
              <label>
                Resident
                <select name="userId" required>
                  {residents.map((a) => (
                    <option key={a.id} value={a.userId}>
                      {a.user.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Category
                <select name="category">
                  {["RENT", "DEPOSIT", "UTILITIES", "PENALTY", "OTHER"].map(
                    (c) => (
                      <option key={c}>{c}</option>
                    ),
                  )}
                </select>
              </label>
              <label>
                Amount
                <input name="amount" required pattern="[0-9]+(\.[0-9]{1,2})?" />
              </label>
              <label>
                Due date
                <input name="dueAt" type="date" required />
              </label>
              <label>
                Unique invoice / billing reference
                <input name="reference" required minLength={5} />
              </label>
              <label>
                Description
                <input name="description" required minLength={3} />
              </label>
              <button className="button">Issue invoice</button>
            </div>
          </ActionForm>
        </section>
      )}
      <section className="panel">
        <div className="panel-head">
          <h2>Payment & proof review</h2>
          <Badge>Evidence is not settlement</Badge>
        </div>
        {payments.map((payment) => (
          <div className="record-card" key={payment.id}>
            <div className="panel-head">
              <div>
                <h3>
                  {payment.user.name} ·{" "}
                  {money(payment.amountMinor, payment.currency)}
                </h3>
                <p className="small muted">
                  {payment.reference} · {payment.method} ·{" "}
                  {payment.bankReference}
                </p>
              </div>
              <Badge tone={payment.status === "PAID" ? "green" : ""}>
                {payment.status}
              </Badge>
            </div>
            {payment.proofHash && duplicateProofs.has(payment.proofHash) && (
              <p className="notice error">
                Duplicate evidence fingerprint detected. Independently verify
                bank transaction references before approval.
              </p>
            )}
            {payment.proofDocumentId && (
              <a
                className="text-link"
                href={`/api/documents/${payment.proofDocumentId}`}
              >
                Review bank evidence ↗
              </a>
            )}
            {canWrite && payment.status === "PROOF_REVIEW" && (
              <ActionForm action="proof.review" next={next} id={payment.id}>
                <div className="inline-fields">
                  <label>
                    Decision
                    <select name="decision">
                      <option value="APPROVE">Verify & post</option>
                      <option value="REJECT">Reject evidence</option>
                    </select>
                  </label>
                  <label>
                    Verified bank / cash evidence and reason
                    <input name="reason" required />
                  </label>
                  <button className="button small-button">
                    Record finance decision
                  </button>
                </div>
              </ActionForm>
            )}
            {payment.receipt && (
              <a
                className="text-link"
                href={`/api/financial/receipt/${payment.receipt.id}`}
              >
                Issued receipt PDF ↗
              </a>
            )}
            {canWrite &&
              ["PAID", "PARTIALLY_REFUNDED"].includes(payment.status) && (
                <details>
                  <summary>Record verified refund / reversal</summary>
                  <p className="small muted">
                    This records an externally verified refund; it does not move
                    money. Keep the bank/provider reference as evidence.
                  </p>
                  <ActionForm action="refund" next={next} id={payment.id}>
                    <div className="inline-fields">
                      <label>
                        Amount
                        <input name="amount" required />
                      </label>
                      <label>
                        Verified refund reference
                        <input name="reference" required />
                      </label>
                      <label>
                        Reason
                        <input name="reason" required />
                      </label>
                      <button className="button secondary">
                        Record refund
                      </button>
                    </div>
                  </ActionForm>
                </details>
              )}
          </div>
        ))}
      </section>
    </>
  );
}
async function Integrations({ propertyId }: { propertyId: string }) {
  const configured = await db.integration.findMany({ where: { propertyId } });
  return (
    <>
      <div className="integration-grid">
        {[
          [
            "PAYNOW",
            "Paynow Zimbabwe",
            "Verified settlement and hosted checkout",
            "Merchant credentials and sandbox verification required",
          ],
          [
            "ACCOUNTING",
            "Accounting / ERP",
            "Permissioned invoice and payment CSV exchange",
            "Choose ERP and provide sandbox access",
          ],
          [
            "SIS",
            "Student information",
            "Institution and registration mappings",
            "Institution agreement and consent required",
          ],
          [
            "PMS",
            "Property management",
            "Inventory / tenancy export contracts",
            "Choose system of record and provider",
          ],
          [
            "EMAIL",
            "Email delivery",
            "Transactional notification queue",
            "Resend key and verified sender required",
          ],
          [
            "SMS",
            "Mobile verification",
            "Phone verification and optional alerts",
            "SMS Pop account and approved sender required",
          ],
          [
            "SIGNATURE",
            "Electronic signature",
            "Manual signed-upload evidence workflow available",
            "Approved template and legal review required",
          ],
          [
            "STORAGE",
            "Private documents",
            "Encrypted volume + ClamAV quarantine",
            "Production managed storage and KMS review required",
          ],
        ].map(([provider, title, desc, dependency]) => (
          <div className="panel integration-card" key={provider}>
            <div className="integration-logo">{title[0]}</div>
            <h3>{title}</h3>
            <p>{desc}</p>
            <Badge>
              {configured
                .find((c) => c.provider === provider)
                ?.status.replaceAll("_", " ") || "Ready for configuration"}
            </Badge>
            <p className="small muted">{dependency}</p>
            {["ACCOUNTING", "SIS", "PMS"].includes(provider) && (
              <a
                href={`/api/v1/export?propertyId=${propertyId}&resource=${provider === "ACCOUNTING" ? "invoices" : provider === "SIS" ? "applications" : "inventory"}`}
                className="text-link"
              >
                Export permitted CSV ↗
              </a>
            )}
          </div>
        ))}
      </div>
      <section className="panel">
        <ApiKeyForm propertyId={propertyId} />
        {(
          await db.apiKey.findMany({
            where: { propertyId },
            select: { id: true, name: true, active: true, expiresAt: true },
          })
        ).map((k) => (
          <div key={k.id} className="record-card">
            <strong>{k.name}</strong>
            <p className="small muted">
              {k.active ? "Active" : "Revoked"} · expires{" "}
              {k.expiresAt.toISOString().slice(0, 10)}
            </p>
            {k.active && (
              <ActionForm
                action="api_key.revoke"
                next="/workspace/integrations"
                id={k.id}
              >
                <button className="text-button danger">Revoke key</button>
              </ActionForm>
            )}
          </div>
        ))}
        <h2 style={{ marginTop: 30 }}>Test local exchange adapters</h2>
        <ActionForm
          action="connector.test"
          next="/workspace/integrations"
          propertyId={propertyId}
        >
          <div className="inline-fields">
            <label>
              Connector
              <select name="provider">
                <option>ACCOUNTING_CSV</option>
                <option>SIS_CSV</option>
                <option>PMS_CSV</option>
              </select>
            </label>
            <button className="button secondary">
              Validate local connection
            </button>
          </div>
        </ActionForm>
        <h2 style={{ marginTop: 30 }}>Honest integration status</h2>
        <p>
          No external service is labelled live without supporting sandbox
          evidence. Credentials belong in secure environment settings. This UI
          never stores raw keys in browser state or displays saved secrets.
        </p>
        <Link href="/api/v1/openapi" prefetch={false} className="text-link">
          OpenAPI contract ↗
        </Link>
      </section>
    </>
  );
}
async function Settings({
  propertyId: p,
  next,
}: {
  propertyId: string;
  next: string;
}) {
  const members = await db.membership.findMany({
    where: { propertyId: p },
    include: { user: true },
  });
  return (
    <>
      <section className="panel">
        <h2>Add a property to this client</h2>
        <p className="muted">
          Requires client-wide administrator access. New properties remain
          unpublished until inventory and factual content are approved.
        </p>
        <ActionForm action="property.create" next={next}>
          <div className="inline-fields">
            {[
              ["name", "Property name"],
              ["slug", "URL slug"],
              ["legalEntity", "Legal entity"],
              ["location", "Location"],
              ["description", "Approved description"],
              ["deposit", "Deposit amount"],
              ["holdMinutes", "Hold minutes"],
            ].map(([name, label]) => (
              <label key={name}>
                {label}
                <input name={name} required />
              </label>
            ))}
            <label>
              Currency
              <select name="currency">
                <option>USD</option>
                <option>ZWG</option>
              </select>
            </label>
            <button className="button secondary">
              Create unpublished property
            </button>
          </div>
        </ActionForm>
        <ActionForm action="property.publish" next={next} propertyId={p}>
          <label className="check-label">
            <input type="checkbox" name="approved" required />I confirm this
            property has approved factual catalogue content and inventory.
          </label>
          <button className="button secondary">
            Publish current property catalogue
          </button>
        </ActionForm>
      </section>
      <section className="panel">
        <h2>Scoped staff access</h2>
        <table>
          <thead>
            <tr>
              <th>Staff</th>
              <th>Role</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.id}>
                <td>{m.user.name}</td>
                <td>{m.role}</td>
                <td>
                  <ActionForm action="membership.revoke" next={next} id={m.id}>
                    <button className="text-button danger">Revoke grant</button>
                  </ActionForm>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <ActionForm action="membership" next={next} propertyId={p}>
          <div className="inline-fields">
            <label>
              Registered user ID
              <input name="userId" required />
            </label>
            <label>
              Role
              <select name="role">
                {Object.keys(rolePermissions).map((r) => (
                  <option key={r}>{r}</option>
                ))}
              </select>
            </label>
            <button className="button secondary">Grant scoped access</button>
          </div>
        </ActionForm>
      </section>
      <section className="panel">
        <h2>Approve a new lease template version</h2>
        <p className="muted">
          Use operative terms approved by qualified counsel. Existing issued and
          executed agreements are not altered by template changes.
        </p>
        <ActionForm action="template" next={next} propertyId={p}>
          <label>
            Title
            <input name="title" required minLength={3} />
          </label>
          <label>
            Approved terms
            <textarea name="body" required minLength={100} rows={8} />
          </label>
          <label className="check-label">
            <input type="checkbox" name="legalApproval" required />I confirm
            these terms have been approved for this property.
          </label>
          <button className="button">Create approved version</button>
        </ActionForm>
      </section>
      <section className="panel">
        <h2>Publish a property notice</h2>
        <ActionForm action="announcement" next={next} propertyId={p}>
          <label>
            Title
            <input name="title" required minLength={3} />
          </label>
          <label>
            Message
            <textarea name="body" required minLength={5} />
          </label>
          <button className="button secondary">Publish notice</button>
        </ActionForm>
      </section>
    </>
  );
}
