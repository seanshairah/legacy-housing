import { rateLimit } from "../../../../../domain/identity";
import { readFile } from "node:fs/promises";
import path from "node:path";
import fontkit from "@pdf-lib/fontkit";
import { NextResponse } from "next/server";
import { PDFDocument, rgb } from "pdf-lib";
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
        ...Object.entries(
          JSON.parse(l.documentSnapshot) as Record<string, string>,
        ).map(
          ([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`,
        ),
      ];
    } else return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
    const pdf = await PDFDocument.create();
    pdf.registerFontkit(fontkit);
    const font = await pdf.embedFont(
      await readFile(path.join(process.cwd(), "assets/fonts/DejaVuSans.ttf")),
      { subset: true },
    );
    const supported = new Set(font.getCharacterSet());
    for (const cp of lines.join("")) {
      if (cp.charCodeAt(0) > 31 && !supported.has(cp.codePointAt(0)!))
        throw new Error("DOCUMENT_GLYPH_UNSUPPORTED");
    }
    let page = pdf.addPage([595, 842]),
      y = 785;
    const wrap = (text: string) => {
      const out: string[] = [];
      for (const paragraph of text.replace(/\t/g, "    ").split("\n")) {
        let line = "";
        for (const word of paragraph.split(/(\s+)/)) {
          if (font.widthOfTextAtSize(line + word, 10) <= 499) {
            line += word;
            continue;
          }
          if (line.trim()) {
            out.push(line.trimEnd());
            line = "";
          }
          for (const cp of word) {
            if (font.widthOfTextAtSize(line + cp, 10) > 499) {
              out.push(line);
              line = cp;
            } else line += cp;
          }
        }
        out.push(line.trimEnd());
      }
      return out;
    };
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
