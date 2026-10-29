"use client";
import { useEffect, useState } from "react";

type Invitation = {
  id: string;
  email: string;
  role: string;
  expiresAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
};
export function InvitationPanel({
  propertyId,
  roles,
}: {
  propertyId: string;
  roles: string[];
}) {
  const [invitations, setInvitations] = useState<Invitation[]>([]),
    [issued, setIssued] = useState<{ token: string; expiresAt: string } | null>(
      null,
    ),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  async function request(action: string, input: Record<string, unknown>) {
    const response = await fetch("/api/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, propertyId, ...input }),
    });
    const result = await response.json();
    if (!response.ok || !result.ok)
      throw new Error(result.error || "Request failed");
    return result;
  }
  useEffect(() => {
    let active = true;
    fetch("/api/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "invitation.list", propertyId }),
    })
      .then(async (response) => {
        const result = await response.json();
        if (!response.ok || !result.ok)
          throw new Error(result.error || "Request failed");
        if (active) setInvitations(result.invitations);
      })
      .catch(() => {
        if (active)
          setMessage("Invitations could not be loaded. Refresh to retry.");
      });
    return () => {
      active = false;
    };
  }, [propertyId]);
  return (
    <section className="panel" aria-label="Staff invitations">
      <h2>Invite a staff member</h2>
      <p>
        Invitations expire after 48 hours. The recipient registers their own
        account, verifies both contacts and enrolls MFA before accepting. No
        temporary password is issued.
      </p>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setMessage("");
          setIssued(null);
          try {
            const result = await request(
              "invitation.create",
              Object.fromEntries(new FormData(event.currentTarget)),
            );
            setIssued(result.invitation);
            const list = await request("invitation.list", {});
            setInvitations(list.invitations);
          } catch (error) {
            setMessage(
              error instanceof Error ? error.message : "Request failed",
            );
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          Staff email
          <input name="email" type="email" required />
        </label>
        <label>
          Granted role
          <select name="role">
            {roles.map((role) => (
              <option key={role} value={role}>
                {role.replaceAll("_", " ")}
              </option>
            ))}
          </select>
        </label>
        <label>
          Invitation reason
          <textarea name="reason" required minLength={10} maxLength={2000} />
        </label>
        <button className="button" disabled={busy}>
          Create staff invitation
        </button>
      </form>
      {issued && (
        <div className="notice">
          <strong>One-time invitation code</strong>
          <p>
            <code>{issued.token}</code>
          </p>
          <p>
            Deliver this code through an approved secure channel. It cannot be
            retrieved again. The recipient selects “Accept invitation” on the
            sign-in page. Expires {new Date(issued.expiresAt).toLocaleString()}.
          </p>
        </div>
      )}
      {message && (
        <p role="status" className="notice">
          {message}
        </p>
      )}
      <h3>Latest 100 invitations</h3>
      {!invitations.length && <p>No invitations for this property.</p>}
      {invitations.map((invitation) => (
        <div key={invitation.id}>
          <p>
            {invitation.email} · {invitation.role.replaceAll("_", " ")} ·{" "}
            {invitation.acceptedAt
              ? "Accepted"
              : invitation.revokedAt
                ? "Revoked"
                : new Date(invitation.expiresAt) <= new Date()
                  ? "Expired"
                  : "Pending"}
          </p>
          {!invitation.acceptedAt &&
            !invitation.revokedAt &&
            new Date(invitation.expiresAt) > new Date() && (
              <form
                onSubmit={async (event) => {
                  event.preventDefault();
                  setBusy(true);
                  setMessage("");
                  try {
                    const data = Object.fromEntries(
                      new FormData(event.currentTarget),
                    );
                    await request("invitation.revoke", {
                      id: invitation.id,
                      reason: data.reason,
                    });
                    const list = await request("invitation.list", {});
                    setInvitations(list.invitations);
                    setMessage("Invitation revoked.");
                  } catch (error) {
                    setMessage(
                      error instanceof Error ? error.message : "Request failed",
                    );
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <label>
                  Revocation reason
                  <input
                    name="reason"
                    required
                    minLength={10}
                    maxLength={2000}
                  />
                </label>
                <button className="button secondary" disabled={busy}>
                  Revoke invitation
                </button>
              </form>
            )}
        </div>
      ))}
    </section>
  );
}
