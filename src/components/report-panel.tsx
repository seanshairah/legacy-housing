import { operationalAnalytics } from "../domain/reporting";
import { type Actor } from "../domain/access";
import { FinancialReport } from "./financial-report";
import { Prisma } from "@prisma/client";
import { db } from "../lib/db";
import { money } from "../domain/finance";
import { Stat, Badge } from "./ui";
export async function ReportPanel({
  propertyId,
  actor,
  filters,
  canReadFinance,
}: {
  actor: Actor;
  propertyId: string;
  filters: Record<string, string | undefined>;
  canReadFinance: boolean;
}) {
  const from = filters.from ? new Date(filters.from) : null,
    to = filters.to ? new Date(filters.to) : null;
  if (
    (from && isNaN(from.getTime())) ||
    (to && isNaN(to.getTime())) ||
    (from && to && to <= from)
  )
    return (
      <p className="notice error">
        Choose a valid reporting period. End date is exclusive.
      </p>
    );
  const additional = await operationalAnalytics(actor, propertyId, filters);
  const buildingId = filters.building || undefined,
    floorId = filters.floor || undefined,
    roomId = filters.room || undefined;
  const scope: Prisma.RoomWhereInput = {
    ...(roomId ? { id: roomId } : {}),
    floor: {
      ...(floorId ? { id: floorId } : {}),
      building: { propertyId, ...(buildingId ? { id: buildingId } : {}) },
    },
  };
  const rooms = await db.room.findMany({
    where: { floor: { building: { propertyId } } },
    include: { floor: { include: { building: true } } },
    orderBy: { name: "asc" },
  });
  const roomIds = (
    await db.room.findMany({ where: scope, select: { id: true } })
  ).map((r) => r.id);
  const period = { ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) };
  const createdAt = from || to ? period : undefined;
  const personScope =
    buildingId || floorId || roomId
      ? {
          reservations: {
            some: { propertyId, bed: { roomId: { in: roomIds } } },
          },
        }
      : {};
  const [beds, active, leases, tickets] = await Promise.all([
    db.bed.count({ where: { roomId: { in: roomIds } } }),
    db.reservation.count({
      where: { propertyId, state: "ACTIVE", bed: { roomId: { in: roomIds } } },
    }),
    db.lease.count({
      where: {
        propertyId,
        executedAt: { not: null },
        createdAt,
        reservation: { bed: { roomId: { in: roomIds } } },
      },
    }),
    db.ticket.findMany({
      where: {
        propertyId,
        createdAt,
        ...(buildingId || floorId || roomId ? { user: personScope } : {}),
      },
    }),
  ]);
  const responded = tickets.filter((t) => t.firstResponseAt),
    resolved = tickets.filter((t) => t.resolvedAt),
    reopened = await db.auditEvent.count({
      where: {
        propertyId,
        action: "service_request.updated",
        createdAt,
        detail: { path: ["reopened"], equals: true },
      },
    });
  const categories = Object.entries(
    tickets.reduce<Record<string, number>>((r, t) => {
      r[t.category] = (r[t.category] || 0) + 1;
      return r;
    }, {}),
  );
  const payments = canReadFinance
    ? await db.payment.findMany({
        where: {
          propertyId,
          status: { in: ["PAID", "REFUNDED", "PARTIALLY_REFUNDED"] },
          settledAt: from || to ? period : undefined,
          user: personScope,
        },
        include: { refunds: true },
      })
    : [];
  const netCollected = payments.reduce(
    (n, p) =>
      n + p.amountMinor - p.refunds.reduce((m, r) => m + r.amountMinor, 0n),
    0n,
  );
  const currency = (
    await db.property.findUniqueOrThrow({ where: { id: propertyId } })
  ).currency;
  return (
    <>
      <section className="panel">
        <div className="panel-head">
          <h2>Property performance</h2>
          <Badge>Source records · no projections</Badge>
        </div>
        <form method="get" className="inline-fields">
          <input type="hidden" name="property" value={propertyId} />
          <label>
            From
            <input type="date" name="from" defaultValue={filters.from} />
          </label>
          <label>
            Until (exclusive)
            <input type="date" name="to" defaultValue={filters.to} />
          </label>
          <label>
            Building
            <select name="building" defaultValue={filters.building || ""}>
              <option value="">All buildings</option>
              {[
                ...new Map(
                  rooms.map((r) => [r.floor.building.id, r.floor.building]),
                ).values(),
              ].map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Floor
            <select name="floor" defaultValue={filters.floor || ""}>
              <option value="">All floors</option>
              {[
                ...new Map(rooms.map((r) => [r.floor.id, r.floor])).values(),
              ].map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Room
            <select name="room" defaultValue={filters.room || ""}>
              <option value="">All rooms</option>
              {rooms.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </label>
          <button className="button secondary">Update report</button>
        </form>
        <div className="stats-grid">
          <Stat
            label="Lease renewal rate"
            value={
              additional.renewalPercent === null
                ? "No eligible leases"
                : `${additional.renewalPercent.toFixed(2)}%`
            }
            note={`${additional.renewedLeases} approved renewals / ${additional.eligibleLeases} executed agreements ending in the cohort`}
          />
          <Stat
            label="Current occupancy"
            value={`${beds ? Math.round((active / beds) * 100) : 0}%`}
            note={`${active} checked in / ${beds} selected beds`}
          />
          <Stat
            label="Executed leases"
            value={leases}
            note="Agreements created in selected period"
          />
          <Stat
            label="Complaints / compliments"
            value={`${tickets.filter((t) => t.type === "COMPLAINT").length} / ${tickets.filter((t) => t.type === "COMPLIMENT").length}`}
            note="Created in selected period"
          />
          <Stat
            label="Open service backlog"
            value={
              tickets.filter((t) => !["RESOLVED", "CLOSED"].includes(t.status))
                .length
            }
            note="Requests from the selected population"
          />
        </div>
        {canReadFinance && (
          <div className="notice">
            <strong>Net collected: {money(netCollected, currency)}</strong>
            <p style={{ margin: 0 }}>
              Verified settlements in the period less their recorded refunds.{" "}
              {payments.length} settlement records. This is not projected rent
              or a cash-basis accounting certification.
            </p>
          </div>
        )}
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Measure</th>
                <th>Observed value</th>
                <th>Definition</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Mean first response</td>
                <td>
                  {responded.length
                    ? (
                        responded.reduce(
                          (n, t) =>
                            n +
                            (t.firstResponseAt!.getTime() -
                              t.createdAt.getTime()) /
                              3600000,
                          0,
                        ) / responded.length
                      ).toFixed(1) + " h"
                    : "No observations"}
                </td>
                <td>Created → first staff response</td>
              </tr>
              <tr>
                <td>Mean resolution</td>
                <td>
                  {resolved.length
                    ? (
                        resolved.reduce(
                          (n, t) =>
                            n +
                            (t.resolvedAt!.getTime() - t.createdAt.getTime()) /
                              3600000,
                          0,
                        ) / resolved.length
                      ).toFixed(1) + " h"
                    : "No observations"}
                </td>
                <td>Created → current resolution</td>
              </tr>
              <tr>
                <td>Reopened updates</td>
                <td>{reopened}</td>
                <td>Property events in selected period; not room-filtered</td>
              </tr>
              {categories.map(([c, count]) => (
                <tr key={c}>
                  <td>{c}</td>
                  <td>{count}</td>
                  <td>
                    {count > 1 ? "Repeat category" : "Single recorded category"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="small muted">
          Renewal cohort: {additional.cohortFrom.slice(0, 10)} through{" "}
          {additional.cohortTo.slice(0, 10)} (exclusive); defaults to the prior
          90 days. Only approved renewal requests count.
        </p>
        <div className="table-wrap">
          <table>
            <caption>Complaint and service trends by month (UTC)</caption>
            <thead>
              <tr>
                <th>Month</th>
                <th>Complaints</th>
                <th>Maintenance</th>
                <th>Compliments</th>
                <th>Support</th>
              </tr>
            </thead>
            <tbody>
              {additional.trends.map((t) => (
                <tr key={t.month}>
                  <td>{t.month}</td>
                  <td>{t.complaints}</td>
                  <td>{t.maintenance}</td>
                  <td>{t.compliments}</td>
                  <td>{t.support}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="table-wrap">
          <table>
            <caption>Current room utilisation</caption>
            <thead>
              <tr>
                <th>Room</th>
                <th>Checked in / beds</th>
                <th>Blocked beds</th>
              </tr>
            </thead>
            <tbody>
              {additional.rooms.map((r) => (
                <tr key={r.id}>
                  <td>{r.name}</td>
                  <td>
                    {r.occupied} / {r.beds}
                  </td>
                  <td>{r.blocked}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="small muted">
          Occupancy is current; period filters apply to record creation and
          financial settlement. Building/floor/room filters group service and
          finance by residents with a stay in the selected inventory. Finance
          data is separately permissioned. Zero observations remain labelled; no
          synthetic trend line is invented.
        </p>
      </section>
      {canReadFinance && (
        <FinancialReport
          actor={actor}
          propertyId={propertyId}
          filters={filters}
        />
      )}
    </>
  );
}
