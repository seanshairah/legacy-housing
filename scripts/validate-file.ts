import { PDFDocument } from "pdf-lib";
import sharp from "sharp";
// Private bytes arrive only over stdin, never a path or a command-line argument.
const chunks: Buffer[] = [];
let size = 0;
try {
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 10 * 1024 * 1024) throw new Error("SIZE_LIMIT");
    chunks.push(Buffer.from(chunk));
  }
  const bytes = Buffer.concat(chunks),
    mime = process.argv[2];
  if (mime === "application/pdf") {
    if (
      /\/(JavaScript|JS|Launch|EmbeddedFile|OpenAction)\b/.test(
        bytes.toString("latin1"),
      )
    )
      throw new Error("ACTIVE_CONTENT");
    const pdf = await PDFDocument.load(bytes, {
      ignoreEncryption: false,
      updateMetadata: false,
    });
    if (pdf.getPageCount() > 100) throw new Error("PAGE_LIMIT");
    for (const [, object] of pdf.context.enumerateIndirectObjects())
      if (
        /\/(JavaScript|JS|Launch|EmbeddedFile|OpenAction)\b/.test(
          object.toString(),
        )
      )
        throw new Error("ACTIVE_CONTENT");
  } else {
    const image = sharp(bytes, { limitInputPixels: 20000000, failOn: "error" }),
      m = await image.metadata();
    if (!m.width || !m.height || m.width * m.height > 20000000)
      throw new Error("PIXEL_LIMIT");
    await image.stats();
  }
} catch {
  process.exitCode = 42;
}
