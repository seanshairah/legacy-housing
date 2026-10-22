import { NextResponse } from "next/server";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { db } from "../../../../../lib/db";
import { currentUser } from "../../../../../lib/current-user";
import { ownerOrPermit } from "../../../../../domain/access";
import { money } from "../../../../../domain/finance";
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
        ...Object.entries(
          JSON.parse(l.documentSnapshot) as Record<string, string>,
        ).map(
          ([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`,
        ),
      ];
    } else return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
    const pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.Helvetica);
    let page = pdf.addPage([595, 842]),
      y = 785;
    const wrap = (s: string) =>
      s.replace(/[^\x20-\x7E\n]/g, "?").match(/.{1,85}(?:\s|$)|.{1,85}/g) || [
        "",
      ];
    for (const line of ["LEGACY HEIGHTS", "", ...lines])
      for (const part of wrap(line)) {
        if (y < 55) {
          page = pdf.addPage([595, 842]);
          y = 785;
        }
        page.drawText(part.trim(), {
          x: 48,
          y,
          size: 10,
          font,
          color: rgb(0.15, 0.22, 0.17),
        });
        y -= 19;
      }
    await transaction((tx) =>
      event(tx, actor.id, null, "financial_document.downloaded", id, { kind }),
    );
    return new Response(new Uint8Array(await pdf.save()), {
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
