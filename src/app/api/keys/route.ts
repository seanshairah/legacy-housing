import { NextResponse } from "next/server";
import { currentUser } from "../../../lib/current-user";
import { assertSameOrigin } from "../../../lib/security";
import { issueApiKey } from "../../../domain/api-keys";
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const u = await currentUser();
    if (!u)
      return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
    const body = await request.text();
    if (body.length > 4000) throw new Error("SIZE_LIMIT");
    const d = JSON.parse(body);
    return NextResponse.json(
      await issueApiKey(u, String(d.propertyId), String(d.name), d.scopes),
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json({ error: "KEY_CREATION_DENIED" }, { status: 403 });
  }
}
