import { readFile } from "node:fs/promises";
import path from "node:path";
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, rgb } from "pdf-lib";
export async function renderPdf(lines: string[]) {
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
  return Buffer.from(await pdf.save());
}
