import { NextResponse } from "next/server";
import { callback } from "../../../../../domain/paynow";
export async function POST(request: Request) {
  try {
    const text = await request.text();
    if (text.length > 32000) throw new Error("SIZE_LIMIT");
    await callback(Object.fromEntries(new URLSearchParams(text)));
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "CALLBACK_REJECTED" }, { status: 400 });
  }
}
