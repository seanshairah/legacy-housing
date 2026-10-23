import { leaseDisplayLines } from "../../../../../lib/lease-display";
import { rateLimit } from "../../../../../domain/identity";
import { renderPdf } from "../../../../../lib/pdf";
import { NextResponse } from "next/server";
import { db } from "../../../../../lib/db";
import { currentUser } from "../../../../../lib/current-user";
import { ownerOrPermit } from "../../../../../domain/access";
import { money, account } from "../../../../../domain/finance";
import { transaction } from "../../../../../lib/db";
import { event } from "../../../../../domain/events";
export async function GET(
  _r: Request,
  { params }: { params: Promise<{ kind: string; id: string }> },
) {
  const actor = await currentUser();
  if (!actor)
    return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  try {
    await rateLimit(`financial-download:${actor.id}`, 60);
    const { kind, id } = await params;
    let lines: string[] = [];
    if (kind === "invoice") {
      const c = await db.charge.findUniqueOrThrow({
        where: { id },
        include: { user: true },
      });
      await ownerOrPermit(actor, c.userId, c.propertyId, "finance.read");
      lines = [
        "INVOICE",
        c.reference,
        c.user.name,
        c.description,
        `Amount: ${money(c.amountMinor, c.currency)}`,
        `Due: ${c.dueAt.toISOString().slice(0, 10)}`,
      ];
    } else if (kind === "statement") {
      const userId = new URL(_r.url).searchParams.get("userId") || actor.id;
      await ownerOrPermit(actor, userId, id, "finance.read");
      if (!(await db.application.count({ where: { userId, propertyId: id } })))
        throw new Error("FORBIDDEN");
      const property = await db.property.findUniqueOrThrow({ where: { id } }),
        balance = await account(userId, id),
        person = await db.user.findUniqueOrThrow({
          where: { id: userId },
          select: { name: true },
        });
      lines = [
        "ACCOUNT STATEMENT",
        person.name,
        property.name,
        `As of ${new Date().toISOString()}`,
        `Outstanding charges: ${money(balance.outstanding, property.currency)}`,
        `Verified unallocated funds: ${money(balance.credit, property.currency)}`,
        ...balance.lines.map(
          (c) =>
            `${c.reference}: ${c.description}; amount ${money(c.amountMinor, c.currency)}; open ${money(c.remaining, c.currency)}`,
        ),
      ];
    } else if (kind === "receipt") {
      const r = await db.receipt.findUniqueOrThrow({
        where: { id },
        include: { payment: true },
      });
      await ownerOrPermit(
        actor,
        r.payment.userId,
        r.payment.propertyId,
        "finance.read",
      );
      lines = [
        "RECEIPT",
        r.number,
        `Issued ${r.issuedAt.toISOString()}`,
        ...Object.entries(r.snapshot as Record<string, string>).map(
          ([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`,
        ),
      ];
    } else if (kind === "lease") {
      const l = await db.lease.findUniqueOrThrow({ where: { id } });
      await ownerOrPermit(actor, l.userId, l.propertyId, "leases");
      lines = [
        "LEASE AGREEMENT",
        `Status: ${l.status}`,
        `SHA-256: ${l.documentHash}`,
        `Executed: ${l.executedAt?.toISOString() || "Not executed"}`,
        ...leaseDisplayLines(JSON.parse(l.documentSnapshot)),
      ];
    } else return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
    const bytes = await renderPdf(lines);
    await transaction((tx) =>
      event(tx, actor.id, null, "financial_document.downloaded", id, { kind }),
    );
    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="legacy-${kind}-${id}.pdf"`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch {
    return NextResponse.json(
      { error: "DOCUMENT_UNAVAILABLE" },
      { status: 403 },
    );
  }
}
