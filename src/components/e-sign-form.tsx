"use client";
import { LeaseTerms } from "./lease-terms";
import { useState } from "react";
import { useRouter } from "next/navigation";
type SigningReview = {
  challenge: string;
  documentHash: string;
  snapshot: {
    resident: string;
    electronicSigningDisclosure: string;
    [key: string]: unknown;
  };
  expiresAt: string;
};
export function ElectronicSigningForm({
  leaseId,
  mfaEnabled,
}: {
  leaseId: string;
  mfaEnabled: boolean;
}) {
  const router = useRouter(),
    [review, setReview] = useState<SigningReview | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function send(action: string, data: Record<string, unknown>) {
    const response = await fetch("/api/v1/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, ...data }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "SIGNING_FAILED");
    return result.data;
  }
  async function begin() {
    setBusy(true);
    setError("");
    try {
      setReview(await send("lease.electronic.begin", { id: leaseId }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "SIGNING_FAILED");
    } finally {
      setBusy(false);
    }
  }
  async function sign(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const form = new FormData(e.currentTarget);
    try {
      await send("lease.electronic.sign", {
        leaseId,
        challenge: review!.challenge,
        documentHash: review!.documentHash,
        name: form.get("name"),
        code: form.get("code"),
        consent: form.get("consent") === "on",
      });
      router.refresh();
      setReview(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "SIGNING_FAILED");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="record-card">
      <h3>Sign electronically</h3>
      {!mfaEnabled ? (
        <p>
          Enroll an authenticator in the <a href="/auth">MFA tab</a>, then sign
          in again to sign electronically. You can also upload a manually signed
          agreement.
        </p>
      ) : !review ? (
        <button className="button secondary" disabled={busy} onClick={begin}>
          Review for electronic signing
        </button>
      ) : (
        <form onSubmit={sign}>
          <p>
            Review the exact agreement and disclosure before signing. The signed
            PDF remains subject to management execution review.
          </p>
          <details open>
            <summary>Agreement terms & signing disclosure</summary>
            <LeaseTerms snapshot={review.snapshot} />
          </details>
          <p className="small muted">
            Document SHA-256: {review.documentHash}. Signing review expires{" "}
            {new Date(review.expiresAt).toLocaleTimeString()}.
          </p>
          <label>
            Full name as shown on the agreement
            <input name="name" required maxLength={120} autoComplete="name" />
          </label>
          <label>
            Current authenticator code
            <input
              name="code"
              required
              pattern="[0-9]{6}"
              inputMode="numeric"
              autoComplete="one-time-code"
            />
          </label>
          <label className="check-label">
            <input type="checkbox" name="consent" required />I have reviewed
            this exact agreement and signing disclosure, and intend to sign it
            electronically using my typed name and authenticator verification.
          </label>
          <button className="button" disabled={busy}>
            Sign agreement electronically
          </button>
        </form>
      )}
      {error && (
        <p role="alert" className="notice error">
          {error.replaceAll("_", " ")}
        </p>
      )}
    </div>
  );
}
