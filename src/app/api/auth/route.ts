import { securitySignal } from "../../../lib/security-monitor";
import { event } from "../../../domain/events";
import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin, hash } from "../../../lib/security";
import {
  register,
  login,
  consumeChallenge,
  issueChallenge,
  enrollMfa,
  confirmMfa,
  rateLimit,
  regenerateRecoveryCodes,
  recoverMfa,
  createInvitation,
  listInvitations,
  revokeInvitation,
  acceptInvitation,
  session,
} from "../../../domain/identity";
import { db, transaction } from "../../../lib/db";
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const body = await request.text();
    if (body.length > 12000) throw new Error("REQUEST_SIZE_LIMIT");
    const d = request.headers.get("content-type")?.includes("application/json")
      ? JSON.parse(body)
      : Object.fromEntries(new URLSearchParams(body));
    let result: unknown = { ok: true };
    if (d.action === "register") {
      await register(d);
      result = {
        ok: true,
        message:
          "Account created. Verify your email and mobile using the codes sent by the configured providers.",
      };
    } else if (d.action === "login") {
      const raw = await login(
        z.string().parse(d.email),
        z.string().max(128).parse(d.password),
        d.code,
      );
      const response = NextResponse.json(
        { ok: true, redirect: "/portal" },
        { headers: { "Cache-Control": "no-store" } },
      );
      response.cookies.set("legacy_session", raw, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "strict",
        path: "/",
        maxAge: 43200,
      });
      return response;
    } else if (d.action === "verify") {
      await consumeChallenge(z.string().parse(d.token), d.password);
      result = { ok: true, message: "Verification complete. You may sign in." };
    } else if (d.action === "forgot") {
      const email = z.string().email().parse(d.email).toLowerCase();
      await rateLimit(`reset:${email}`, 4);
      const u = await db.user.findUnique({ where: { email } });
      if (u) await issueChallenge(u.id, "RESET");
      result = {
        ok: true,
        message:
          "If an account exists, a recovery code has been queued. Delivery requires a configured provider.",
      };
    } else if (d.action === "enroll")
      result = { ok: true, ...(await enrollMfa(d.email, d.password)) };
    else if (d.action === "confirm")
      result = {
        ok: true,
        ...(await confirmMfa(d.email, d.password, d.code)),
        message:
          "Authenticator confirmed. Save the recovery codes below, then sign in.",
      };
    else if (d.action === "recovery-codes")
      result = {
        ok: true,
        ...(await regenerateRecoveryCodes(d.email, d.password, d.code)),
        message:
          "Recovery codes replaced. All sessions have ended. Save these codes before signing in again.",
      };
    else if (d.action === "mfa-recover") {
      await recoverMfa(d.email, d.password, d.recoveryCode);
      result = {
        ok: true,
        message:
          "Lost authenticator removed and all sessions ended. Open MFA to set up a new authenticator before using staff access.",
      };
    } else if (d.action === "invitation.accept") {
      await acceptInvitation(d);
      result = {
        ok: true,
        message:
          "Invitation accepted. All previous sessions have ended. Sign in with your authenticator to use the granted role.",
      };
    } else if (
      ["invitation.create", "invitation.list", "invitation.revoke"].includes(
        d.action,
      )
    ) {
      const raw = request.headers
        .get("cookie")
        ?.match(/(?:^|;\s*)legacy_session=([^;]+)/)?.[1];
      const actor = await session(raw);
      if (!actor) throw new Error("UNAUTHENTICATED");
      if (d.action === "invitation.create")
        result = { ok: true, invitation: await createInvitation(actor, d) };
      else if (d.action === "invitation.list")
        result = {
          ok: true,
          invitations: await listInvitations(actor, d.propertyId),
        };
      else {
        await revokeInvitation(actor, d.id, d.reason);
        result = { ok: true };
      }
    } else if (d.action === "logout") {
      const raw = request.headers
        .get("cookie")
        ?.match(/(?:^|;\s*)legacy_session=([^;]+)/)?.[1];
      if (raw)
        await transaction(async (tx) => {
          const existing = await tx.session.findUnique({
            where: { tokenHash: hash(raw) },
          });
          if (!existing) return;
          await tx.session.deleteMany({ where: { tokenHash: hash(raw) } });
          await event(
            tx,
            existing.userId,
            null,
            "session.logged_out",
            existing.userId,
          );
        });
      const response = NextResponse.json(
        { ok: true, redirect: "/" },
        { headers: { "Cache-Control": "no-store" } },
      );
      response.cookies.delete("legacy_session");
      return response;
    } else throw new Error("INVALID_ACTION");
    return NextResponse.json(result, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (error instanceof Error && error.message === "CSRF_ORIGIN_REJECTED")
      await securitySignal({ kind: "CSRF_REJECTED", subject: "auth" });
    const message =
      error instanceof z.ZodError
        ? "Please check the entered fields."
        : error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message)
          ? error.message
          : "REQUEST_FAILED";
    return NextResponse.json(
      { ok: false, error: message },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
}
