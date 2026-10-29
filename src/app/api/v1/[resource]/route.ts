import { securitySignal } from "../../../../lib/security-monitor";
import { financialReconciliation } from "../../../../domain/reporting";
import { activity } from "../../../../lib/activity";
import { connectors } from "../../../../integrations";
import { transaction } from "../../../../lib/db";
import { event } from "../../../../domain/events";
import { apiActor } from "../../../../domain/api-keys";
import { NextResponse } from "next/server";
import { db } from "../../../../lib/db";
import { currentUser } from "../../../../lib/current-user";
import { permit } from "../../../../domain/access";
import { assertSameOrigin } from "../../../../lib/security";
import { command } from "../../../../domain/commands";
import { rateLimit } from "../../../../domain/identity";
const json = (data: unknown, status = 200) =>
  new NextResponse(
    JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
    {
      status,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "private, no-store",
      },
    },
  );
const csvCell = (v: unknown) => {
  let s = String(v ?? "");
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return '"' + s.replaceAll('"', '""') + '"';
};
export async function GET(
  request: Request,
  { params }: { params: Promise<{ resource: string }> },
) {
  const { resource } = await params;
  if (resource === "openapi")
    return NextResponse.json({
      openapi: "3.1.0",
      info: { title: "Legacy Heights API", version: "1.0.0" },
      servers: [{ url: "/api/v1" }],
      components: {
        securitySchemes: {
          session: { type: "apiKey", in: "cookie", name: "legacy_session" },
          bearer: { type: "http", scheme: "bearer" },
        },
      },
      security: [{ session: [] }, { bearer: [] }],
      paths: Object.fromEntries(
        [
          "inventory",
          "applications",
          "leases",
          "invoices",
          "payments",
          "tickets",
          "analytics",
          "integrations",
          "reconciliation",
          "export",
        ].map((r) => [
          `/${r}`,
          {
            get: {
              summary: `Property-scoped ${r}`,
              parameters: [
                {
                  name: "propertyId",
                  in: "query",
                  required: true,
                  schema: { type: "string" },
                },
                {
                  name: "page",
                  in: "query",
                  schema: { type: "integer", minimum: 1 },
                },
              ],
              responses: {
                200: { description: "Records; minor units encoded as strings" },
                401: { description: "Authentication required" },
                403: { description: "Scope denied" },
              },
            },
          },
        ]),
      ),
    });
  let actor;
  try {
    const bearer = request.headers.get("authorization");
    actor = bearer?.startsWith("Bearer ")
      ? await apiActor(bearer.slice(7))
      : await currentUser();
  } catch {
    return json({ error: "UNAUTHENTICATED" }, 401);
  }
  if (!actor) return json({ error: "UNAUTHENTICATED" }, 401);
  try {
    await rateLimit(`api:${actor.id}`, 200);
    if (resource === "me-export") {
      if ("apiPropertyId" in actor)
        return json({ error: "SESSION_REQUIRED" }, 403);
      const user = await db.user.findUniqueOrThrow({
        where: { id: actor.id },
        select: {
          id: true,
          name: true,
          email: true,
          phone: true,
          residentType: true,
          institution: true,
          emergencyName: true,
          emergencyPhone: true,
          createdAt: true,
        },
      });
      const data = {
        user,
        applications: await db.application.findMany({
          where: { userId: actor.id },
        }),
        documents: await db.document.findMany({
          where: { userId: actor.id },
          select: {
            id: true,
            kind: true,
            filename: true,
            state: true,
            version: true,
            hash: true,
            createdAt: true,
          },
        }),
        charges: await db.charge.findMany({ where: { userId: actor.id } }),
        payments: await db.payment.findMany({
          where: { userId: actor.id },
          select: {
            id: true,
            reference: true,
            status: true,
            amountMinor: true,
            currency: true,
            createdAt: true,
            evidence: {
              select: {
                paymentDate: true,
                bankName: true,
                accountLast4: true,
                updatedAt: true,
              },
            },
            disputes: {
              select: {
                id: true,
                reason: true,
                state: true,
                resolution: true,
                createdAt: true,
                updatedAt: true,
                events: {
                  select: { state: true, reason: true, createdAt: true },
                  orderBy: { createdAt: "asc" },
                },
              },
              orderBy: { createdAt: "asc" },
            },
          },
        }),
        leases: await db.lease.findMany({
          where: { userId: actor.id },
          select: {
            id: true,
            status: true,
            documentHash: true,
            signedHash: true,
            executedAt: true,
          },
        }),
        consents: await db.consent.findMany({ where: { userId: actor.id } }),
        tickets: await db.ticket.findMany({
          where: { userId: actor.id },
          include: { messages: { where: { internal: false } } },
        }),
      };
      await transaction(async (tx) => {
        await tx.privacyRequest.create({
          data: {
            userId: actor.id,
            type: "EXPORT",
            reason: "Authenticated self-service export",
            state: "FULFILLED",
            resolution:
              "Account data and protected document references delivered to the authenticated resident.",
          },
        });
        await event(tx, actor.id, null, "privacy.exported", actor.id);
      });
      return new Response(
        JSON.stringify(data, (_k, v) =>
          typeof v === "bigint" ? v.toString() : v,
        ),
        {
          headers: {
            "Content-Type": "application/json",
            "Content-Disposition":
              'attachment; filename="legacy-my-account.json"',
            "Cache-Control": "private, no-store",
          },
        },
      );
    }

    const query = new URL(request.url).searchParams,
      p = query.get("propertyId") || "",
      page = Math.max(1, Math.min(10000, Number(query.get("page")) || 1)),
      skip = (page - 1) * 50;
    if (resource === "reconciliation") {
      const report = await financialReconciliation(
        actor,
        p,
        Object.fromEntries(query),
      );
      await activity(actor.id, p, "reconciliation.exported", p);
      const rows = [
        [
          "reference",
          "method",
          "status",
          "received_minor",
          "refunded_minor",
          "allocated_minor",
          "unallocated_minor",
          "receipt",
          "exception",
        ],
        ...report.transactions.map((t) => [
          t.reference,
          t.method,
          t.status,
          String(t.received),
          String(t.refunded),
          String(t.allocated),
          String(t.unallocated),
          t.receipt || "",
          t.exception || "",
        ]),
      ];
      return new Response(
        rows.map((r) => r.map(csvCell).join(",")).join("\r\n"),
        {
          headers: {
            "Content-Type": "text/csv",
            "Content-Disposition":
              'attachment; filename="legacy-reconciliation.csv"',
            "Cache-Control": "no-store",
          },
        },
      );
    }
    const target =
      resource === "export" ? query.get("resource") || "" : resource;
    if (resource === "exchange") {
      const connector = connectors[query.get("provider") || ""];
      if (!connector) return json({ error: "UNKNOWN_CONNECTOR" }, 400);
      const result = await connector.export(actor, p);
      await transaction((tx) =>
        event(tx, actor.id, p, "exchange.exported", connector.provider, {
          rows: result.rows.length,
        }),
      );
      return new Response(
        [result.headers, ...result.rows]
          .map((row) => row.map(csvCell).join(","))
          .join("\r\n"),
        {
          headers: {
            "Content-Type": "text/csv",
            "Cache-Control": "no-store",
            "Content-Disposition": `attachment; filename="legacy-${connector.provider}.csv"`,
          },
        },
      );
    }
    const caps: Record<string, string> = {
      inventory: "inventory",
      applications: "admissions",
      leases: "leases",
      invoices: "finance.read",
      payments: "finance.read",
      tickets: "operations",
      analytics: "reports",
      integrations: "settings",
    };
    if (!caps[target]) return json({ error: "NOT_FOUND" }, 404);
    await permit(actor, p, caps[target]);
    await activity(actor.id, p, "api.read", target);
    const from = query.get("from"),
      to = query.get("to");
    const dateFilter =
      from || to
        ? {
            createdAt: {
              ...(from ? { gte: new Date(from) } : {}),
              ...(to ? { lt: new Date(to) } : {}),
            },
          }
        : {};
    let data: unknown[] = [];
    if (target === "inventory")
      data = await db.bed.findMany({
        where: { room: { floor: { building: { propertyId: p } } } },
        include: {
          room: { include: { floor: { include: { building: true } } } },
        },
        skip,
        take: 50,
      });
    if (target === "applications")
      data = await db.application.findMany({
        where: { propertyId: p, ...dateFilter },
        select: { id: true, userId: true, status: true, createdAt: true },
        skip,
        take: 50,
      });
    if (target === "leases")
      data = await db.lease.findMany({
        where: { propertyId: p, ...dateFilter },
        select: {
          id: true,
          userId: true,
          status: true,
          documentHash: true,
          executedAt: true,
        },
        skip,
        take: 50,
      });
    if (target === "invoices")
      data = await db.charge.findMany({
        where: { propertyId: p, ...dateFilter },
        skip,
        take: 50,
      });
    if (target === "payments")
      data = await db.payment.findMany({
        where: { propertyId: p, ...dateFilter },
        select: {
          id: true,
          userId: true,
          reference: true,
          amountMinor: true,
          currency: true,
          status: true,
          settledAt: true,
        },
        skip,
        take: 50,
      });
    if (target === "tickets")
      data = await db.ticket.findMany({
        where: { propertyId: p, ...dateFilter },
        select: {
          id: true,
          type: true,
          status: true,
          priority: true,
          createdAt: true,
          resolvedAt: true,
        },
        skip,
        take: 50,
      });
    if (target === "integrations")
      data = await db.integration.findMany({
        where: { propertyId: p },
        select: { id: true, provider: true, status: true, lastCheckedAt: true },
      });
    if (target === "analytics")
      data = [
        {
          occupied: await db.reservation.count({
            where: { propertyId: p, state: "ACTIVE" },
          }),
          applications: await db.application.count({
            where: { propertyId: p, ...dateFilter },
          }),
        },
      ];
    if (resource === "export") {
      await transaction((tx) =>
        event(tx, actor.id, p, "report.exported", target, {
          page,
          rows: data.length,
        }),
      );
      const flat = data as Record<string, unknown>[],
        keys = flat.length
          ? Object.keys(flat[0]).filter(
              (k) =>
                flat[0][k] === null ||
                typeof flat[0][k] !== "object" ||
                flat[0][k] instanceof Date,
            )
          : ["id"];
      return new Response(
        [
          keys.map(csvCell).join(","),
          ...flat.map((row) =>
            keys
              .map((k) =>
                csvCell(
                  row[k] instanceof Date
                    ? (row[k] as Date).toISOString()
                    : row[k],
                ),
              )
              .join(","),
          ),
        ].join("\r\n"),
        {
          headers: {
            "Content-Type": "text/csv",
            "Content-Disposition": `attachment; filename="legacy-${target}-${page}.csv"`,
            "Cache-Control": "no-store",
          },
        },
      );
    }
    return json({ data, page, pageSize: 50 });
  } catch {
    return json({ error: "SCOPE_OR_REQUEST_REJECTED" }, 403);
  }
}
export async function POST(
  request: Request,
  { params }: { params: Promise<{ resource: string }> },
) {
  const actor = await currentUser();
  if (!actor) return json({ error: "UNAUTHENTICATED" }, 401);
  try {
    assertSameOrigin(request);
    if ((await params).resource !== "commands")
      return json({ error: "NOT_FOUND" }, 404);
    const text = await request.text();
    if (text.length > 50000) return json({ error: "SIZE_LIMIT" }, 413);
    const d = JSON.parse(text);
    return json({ data: await command(actor, String(d.action), d) });
  } catch (error) {
    if (error instanceof Error && error.message === "CSRF_ORIGIN_REJECTED")
      await securitySignal({ kind: "CSRF_REJECTED", subject: "commands" });
    return json(
      {
        error:
          error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message)
            ? error.message
            : "COMMAND_REJECTED",
      },
      400,
    );
  }
}
