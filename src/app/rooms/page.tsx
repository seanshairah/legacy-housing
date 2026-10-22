import { quoteRates } from "../../domain/pricing";
import Link from "next/link";
import {
  ArrowUpRight,
  BedDouble,
  Accessibility,
  Building2,
  Check,
} from "lucide-react";
import { db } from "../../lib/db";
import {
  PublicNav,
  PageHead,
  Badge,
  ActionForm,
  Empty,
} from "../../components/ui";
import { currentUser } from "../../lib/current-user";
import { money } from "../../domain/finance";
export const dynamic = "force-dynamic";
export default async function Rooms({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const q = await searchParams,
    user = await currentUser();
  const start = new Date(q.startAt || new Date().toISOString().slice(0, 10)),
    end = new Date(
      q.endAt ||
        new Date(Date.now() + 120 * 86400000).toISOString().slice(0, 10),
    );
  const valid = !isNaN(start.getTime()) && !isNaN(end.getTime()) && end > start;
  const properties = await db.property.findMany({
    where: { published: true },
    include: {
      buildings: {
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
                            in: ["HOLD", "CONFIRMED", "ACTIVE", "BLOCKED"],
                          },
                          ...(valid
                            ? { startAt: { lt: end }, endAt: { gt: start } }
                            : {}),
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
    },
  });
  const selected = properties.find((p) => p.id === q.property) || properties[0];
  const rates =
    selected && valid
      ? await db.ratePlan.findMany({
          where: {
            propertyId: selected.id,
            startAt: { lt: end },
            endAt: { gt: start },
          },
        })
      : [];
  return (
    <>
      <PublicNav />
      <main id="main" className="catalogue section">
        <PageHead
          eyebrow="A PLACE FOR YOUR NEXT CHAPTER"
          title="Find your kind of space."
          description="Explore floors and rooms, compare options, and reserve an individual bed for your stay."
        />
        <form className="filter-bar" method="get">
          <label>
            Property
            <select name="property" defaultValue={selected?.id}>
              {properties.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Move-in
            <input
              name="startAt"
              type="date"
              defaultValue={valid ? start.toISOString().slice(0, 10) : ""}
              required
            />
          </label>
          <label>
            Move-out
            <input
              name="endAt"
              type="date"
              defaultValue={valid ? end.toISOString().slice(0, 10) : ""}
              required
            />
          </label>
          <label>
            Room category
            <select name="category" defaultValue={q.category || ""}>
              <option value="">All rooms</option>
              {["SINGLE", "SHARED", "PREMIUM", "ACCESSIBLE"].map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </label>
          <button className="button">
            Check availability <ArrowUpRight size={17} />
          </button>
        </form>
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
        {selected?.slug.startsWith("demo-") && (
          <p className="demo-note">
            Development catalogue · synthetic inventory and illustrative prices.
            Real property details require client approval.
          </p>
        )}
        {!valid ? (
          <p className="notice error">
            Choose valid move-in and move-out dates.
          </p>
        ) : selected ? (
          <>
            <div className="catalogue-header">
              <div>
                <h2>{selected.name}</h2>
                <p className="muted">{selected.location}</p>
              </div>
              <Badge tone="green">{selected.currency} · per month</Badge>
            </div>
            {selected.buildings.map((b) => (
              <div key={b.id}>
                {b.floors.map((f) => (
                  <section key={f.id} className="floor-section">
                    <div className="floor-heading">
                      <Building2 size={20} />
                      <h3>
                        {b.name} / {f.name}
                      </h3>
                      <span className="muted small">
                        An accessible list of every room
                      </span>
                    </div>
                    <div className="rooms-grid">
                      {f.rooms
                        .filter(
                          (r) =>
                            !q.category ||
                            r.category === q.category ||
                            (q.category === "ACCESSIBLE" && r.accessible),
                        )
                        .map((r) => (
                          <article key={r.id} className="room-card">
                            <div className="room-plan">
                              <div className="plan-door" />
                              {r.beds.map((bed) => (
                                <div
                                  className={`plan-bed ${bed.blocked || bed.reservations.some((v) => v.state !== "HOLD" || v.expiresAt! > new Date()) ? "occupied" : ""}`}
                                  key={bed.id}
                                >
                                  <BedDouble size={30} />
                                  <small>{bed.label}</small>
                                </div>
                              ))}
                              {r.accessible && (
                                <Accessibility
                                  className="plan-access"
                                  size={20}
                                />
                              )}
                            </div>
                            <div className="room-card-head">
                              <div>
                                <Badge>{r.category.toLowerCase()}</Badge>
                                <h3>Room {r.name}</h3>
                              </div>
                              <strong>
                                {money(r.monthlyMinor, selected.currency)}
                                <small>/ month base rate</small>
                              </strong>
                            </div>
                            <p className="muted small">
                              {r.beds.length === 1
                                ? "Your own space"
                                : "Shared room · each bed reserved separately"}
                              {r.accessible ? " · Accessible room" : ""}
                            </p>
                            <div className="bed-list">
                              {r.beds.map((bed) => {
                                const available =
                                  !bed.blocked &&
                                  !bed.reservations.some(
                                    (v) =>
                                      v.state !== "HOLD" ||
                                      v.expiresAt! > new Date(),
                                  );
                                const quote = quoteRates(
                                  {
                                    bedId: bed.id,
                                    roomId: r.id,
                                    baseMinor: r.monthlyMinor,
                                    currency: selected.currency,
                                    startAt: start,
                                    endAt: end,
                                  },
                                  rates,
                                );
                                return (
                                  <div key={bed.id}>
                                    <span>
                                      <span
                                        className={`availability-dot ${available ? "" : "unavailable"}`}
                                      />
                                      {bed.label}{" "}
                                      <small>
                                        {available
                                          ? "Available"
                                          : "Unavailable"}
                                      </small>
                                    </span>
                                    <p
                                      className="small muted"
                                      style={{ margin: "8px 0" }}
                                    >
                                      {money(
                                        BigInt(quote.totalMinor),
                                        quote.currency,
                                      )}{" "}
                                      for selected stay
                                    </p>
                                    {available &&
                                      (user ? (
                                        <ActionForm
                                          action="reserve"
                                          next="/portal"
                                          bedId={bed.id}
                                          expectedPriceMinor={quote.totalMinor}
                                          startAt={start.toISOString()}
                                          endAt={end.toISOString()}
                                        >
                                          <label className="check-label">
                                            <input
                                              type="checkbox"
                                              name="consent"
                                              required
                                            />
                                            <span>
                                              I accept the{" "}
                                              <Link href="/privacy">
                                                application policy
                                              </Link>
                                            </span>
                                          </label>
                                          <button className="text-button">
                                            Reserve <ArrowUpRight size={14} />
                                          </button>
                                        </ActionForm>
                                      ) : (
                                        <Link
                                          className="text-button"
                                          href="/auth"
                                        >
                                          Sign in to reserve ↗
                                        </Link>
                                      ))}
                                  </div>
                                );
                              })}
                            </div>
                          </article>
                        ))}
                    </div>
                  </section>
                ))}
              </div>
            ))}
            <div className="waitlist-banner">
              <div>
                <h3>Haven’t found your fit?</h3>
                <p>
                  Join the waiting list for these dates. A place is confirmed
                  only after you receive and accept an offer.
                </p>
              </div>
              {user ? (
                <ActionForm
                  action="waitlist"
                  propertyId={selected.id}
                  startAt={start.toISOString()}
                  endAt={end.toISOString()}
                >
                  <button className="button secondary">
                    Join waiting list <Check size={17} />
                  </button>
                </ActionForm>
              ) : (
                <Link className="button secondary" href="/auth">
                  Sign in to join
                </Link>
              )}
            </div>
          </>
        ) : (
          <Empty
            title="Our catalogue is being prepared"
            body="Check back soon for property and room information."
          />
        )}
      </main>
    </>
  );
}
