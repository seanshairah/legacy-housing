import { NextResponse } from "next/server";
import { currentUser } from "../../../../lib/current-user";
import { download } from "../../../../domain/documents";
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const u = await currentUser();
  if (!u)
    return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  try {
    const { doc, bytes } = await download(u, (await params).id);
    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Type": doc.mime,
        "Content-Disposition": `attachment; filename="${doc.filename.replace(/["\r\n]/g, "_")}"`,
        "Cache-Control": "private, no-store",
        "Content-Security-Policy": "sandbox; default-src 'none'",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return NextResponse.json(
      { error: "DOCUMENT_UNAVAILABLE" },
      { status: 403 },
    );
  }
}
