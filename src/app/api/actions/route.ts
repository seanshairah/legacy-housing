import { securitySignal } from "../../../lib/security-monitor";
import { NextResponse } from "next/server";
import { assertSameOrigin } from "../../../lib/security";
import { currentUser } from "../../../lib/current-user";
import { command } from "../../../domain/commands";
import { upload } from "../../../domain/documents";
import { db } from "../../../lib/db";
import { rateLimit } from "../../../domain/identity";
import { z } from "zod";
function destination(next: unknown) {
  if (
    typeof next !== "string" ||
    !next.startsWith("/") ||
    next.startsWith("//") ||
    next.length > 2000
  )
    return "/portal";
  const target = new URL(next, "https://navigation.invalid");
  if (
    target.origin !== "https://navigation.invalid" ||
    !/^\/(portal|workspace(?:\/\w+)?|rooms)?$/.test(target.pathname)
  )
    return "/portal";
  const allowed = new Set([
    "property",
    "page",
    "search",
    "retentionAfter",
    "retentionPage",
    "organisation",
    "reviewPage",
    "reviewStatus",
    "reviewSearch",
    "reviewAssigned",
    "reviewNoteApp",
    "reviewNotePage",
    "evidencePage",
  ]);
  for (const key of target.searchParams.keys())
    if (!allowed.has(key)) target.searchParams.delete(key);
  return target.pathname + target.search;
}
export async function POST(request: Request) {
  let next = "/portal";
  try {
    assertSameOrigin(request);
    const length = Number(request.headers.get("content-length"));
    if (!length || length > 11 * 1024 * 1024)
      throw new Error("REQUEST_SIZE_LIMIT");
    const data = await request.formData(),
      d = Object.fromEntries(data);
    next = destination(d.next);
    if (d.action === "enquiry") {
      const item = z
        .object({
          name: z.string().min(2).max(120),
          email: z.string().email(),
          message: z.string().min(10).max(2000),
        })
        .parse(d);
      await rateLimit(`enquiry:${item.email}`, 3);
      await db.enquiry.create({ data: item });
      next = "/";
    } else {
      const user = await currentUser();
      if (!user)
        return NextResponse.redirect(
          new URL("/auth", process.env.APP_URL || "http://localhost:3001"),
          303,
        );
      await rateLimit(`actions:${user.id}`, 120);
      if (d.action === "upload") {
        const file = data.get("file");
        if (!(file instanceof File)) throw new Error("FILE_REQUIRED");
        await upload(user, {
          propertyId: String(d.propertyId),
          applicationId: d.applicationId ? String(d.applicationId) : undefined,
          kind: String(d.kind),
          filename: file.name,
          medicalConsent: d.medicalConsent === "on",
          bytes: Buffer.from(await file.arrayBuffer()),
        });
      } else {
        const result = await command(user, String(d.action), d);
        if (result && typeof result === "object" && "redirect" in result)
          return NextResponse.redirect(String(result.redirect), 303);
      }
    }
    const url = new URL(next, process.env.APP_URL || "http://localhost:3001");
    url.searchParams.set("success", "Saved successfully");
    return NextResponse.redirect(url, 303);
  } catch (error) {
    if (error instanceof Error && error.message === "CSRF_ORIGIN_REJECTED")
      await securitySignal({ kind: "CSRF_REJECTED", subject: "commands" });
    const url = new URL(next, process.env.APP_URL || "http://localhost:3001");
    const message =
      error instanceof z.ZodError
        ? "Please check the entered fields"
        : error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message)
          ? error.message
          : "Unable to save. Check the details and try again.";
    url.searchParams.set("error", message);
    return NextResponse.redirect(url, 303);
  }
}
