"use client";
import { useState } from "react";
const modes: Record<string, { tab: string; title: string; submit: string }> = {
  login: { tab: "Sign in", title: "Welcome home.", submit: "Sign in" },
  register: {
    tab: "Register",
    title: "Make room for more.",
    submit: "Create account",
  },
  verify: {
    tab: "Verify",
    title: "Verify your account.",
    submit: "Verify code",
  },
  forgot: {
    tab: "Recover",
    title: "Recover access.",
    submit: "Request recovery",
  },
  enroll: {
    tab: "MFA",
    title: "Secure your account.",
    submit: "Set up authenticator",
  },
  "mfa-recover": {
    tab: "Lost authenticator",
    title: "Recover your authenticator.",
    submit: "Recover authenticator",
  },
  "recovery-codes": {
    tab: "Recovery codes",
    title: "Replace recovery codes.",
    submit: "Replace recovery codes",
  },
  "invitation.accept": {
    tab: "Accept invitation",
    title: "Join your property team.",
    submit: "Accept staff invitation",
  },
};
export function AuthForm() {
  const [mode, setMode] = useState("login"),
    [message, setMessage] = useState(""),
    [secret, setSecret] = useState(""),
    [recoveryCodes, setRecoveryCodes] = useState<string[]>([]),
    [busy, setBusy] = useState(false);
  return (
    <div className="auth-panel">
      <div className="eyebrow">YOUR LEGACY STARTS HERE</div>
      <h1>{modes[mode].title}</h1>
      <p className="muted">
        One account for your application, home, and everything in between.
      </p>
      <div className="tabs">
        {Object.entries(modes).map(([value, details]) => (
          <button
            type="button"
            key={value}
            className={value === mode ? "active" : ""}
            disabled={busy}
            onClick={() => {
              setMode(value);
              setMessage("");
              setSecret("");
              setRecoveryCodes([]);
            }}
          >
            {details.tab}
          </button>
        ))}
      </div>
      {mode === "mfa-recover" && (
        <p className="notice">
          Use your password and one saved recovery code. This ends every session
          and removes the lost authenticator. Staff must enroll a new
          authenticator before signing in.
        </p>
      )}
      {mode === "recovery-codes" && (
        <p className="notice">
          Enter your password and current authenticator code. Replacing recovery
          codes invalidates all previous codes and ends every session.
        </p>
      )}
      {mode === "invitation.accept" && (
        <p className="notice">
          Register your own account, verify both contacts and set up MFA first.
          Use the invitation supplied by your property administrator. Acceptance
          requires your password and current authenticator code.
        </p>
      )}
      <form
        method="post"
        action="/api/auth"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setMessage("");
          const data = Object.fromEntries(new FormData(e.currentTarget));
          try {
            const response = await fetch("/api/auth", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                ...data,
                action: mode === "enroll" && secret ? "confirm" : mode,
              }),
            });
            const result = await response.json();
            if (result.redirect) window.location.assign(result.redirect);
            else if (result.secret) {
              setSecret(result.secret);
              setMessage(
                "Add this secret to your authenticator, then enter its six-digit code.",
              );
            } else if (Array.isArray(result.recoveryCodes)) {
              setRecoveryCodes(result.recoveryCodes);
              setSecret("");
              setMode("login");
              setMessage(result.message);
            } else
              setMessage(result.error || result.message || "Request complete.");
          } catch {
            setMessage("Connection failed. Please try again.");
          } finally {
            setBusy(false);
          }
        }}
      >
        <input
          type="hidden"
          name="action"
          value={mode === "enroll" && secret ? "confirm" : mode}
        />
        {mode === "register" && (
          <>
            <label>
              Full name
              <input name="name" required maxLength={120} autoComplete="name" />
            </label>
            <label>
              Mobile number
              <input
                name="phone"
                required
                placeholder="+263…"
                autoComplete="tel"
              />
            </label>
            <label>
              Resident type
              <select name="residentType">
                <option value="PRIVATE">Private tenant</option>
                <option value="STUDENT">Student</option>
              </select>
            </label>
            <label>
              Institution <span className="muted">(students only)</span>
              <input name="institution" />
            </label>
          </>
        )}
        {mode !== "verify" && (
          <label>
            Email address
            <input name="email" type="email" required autoComplete="email" />
          </label>
        )}
        {!["forgot", "verify"].includes(mode) && (
          <label>
            Password
            <input
              name="password"
              type="password"
              required
              minLength={mode === "register" ? 12 : 1}
              maxLength={128}
              autoComplete={
                mode === "register" ? "new-password" : "current-password"
              }
            />
          </label>
        )}
        {mode === "verify" && (
          <>
            <label>
              Single-use verification or recovery code
              <input name="token" required autoComplete="one-time-code" />
            </label>
            <label>
              New password <span className="muted">(recovery only)</span>
              <input
                name="password"
                type="password"
                minLength={12}
                autoComplete="new-password"
              />
            </label>
          </>
        )}
        {mode === "invitation.accept" && (
          <label>
            Staff invitation code
            <input
              name="token"
              required
              minLength={30}
              maxLength={100}
              autoComplete="off"
            />
          </label>
        )}
        {mode === "mfa-recover" && (
          <label>
            Saved authenticator recovery code
            <input
              name="recoveryCode"
              required
              maxLength={40}
              placeholder="xxxxxxxx-xxxxxxxx-xxxxxxxx-xxxxxxxx"
              autoComplete="off"
            />
          </label>
        )}
        {secret && (
          <div className="notice">
            Authenticator secret <code className="secret">{secret}</code>Store
            it only in your authenticator.
          </div>
        )}
        {(mode === "login" ||
          mode === "recovery-codes" ||
          mode === "invitation.accept" ||
          !!secret) && (
          <label>
            Authenticator code{" "}
            <span className="muted">
              {mode === "login" ? "(if enabled; required for staff)" : ""}
            </span>
            <input
              name="code"
              inputMode="numeric"
              pattern="[0-9]{6}"
              autoComplete="one-time-code"
              required={
                mode === "recovery-codes" ||
                mode === "invitation.accept" ||
                !!secret
              }
            />
          </label>
        )}
        {message && (
          <p role="status" className="notice">
            {message}
          </p>
        )}
        {recoveryCodes.length > 0 && (
          <div className="notice" aria-label="New authenticator recovery codes">
            <strong>Save these recovery codes now.</strong>
            <p>
              They are shown only once. Keep them in a secure password manager
              or offline. Each code expires after one year and can be used once.
              Leaving this tab hides them.
            </p>
            <ul>
              {recoveryCodes.map((code) => (
                <li key={code}>
                  <code>{code}</code>
                </li>
              ))}
            </ul>
          </div>
        )}
        <button disabled={busy} className="button full">
          {busy
            ? "Please wait…"
            : mode === "enroll" && secret
              ? "Confirm authenticator"
              : modes[mode].submit}{" "}
          <span>↗</span>
        </button>
      </form>
      <p className="small muted">
        Staff accounts require an authenticator. Email and mobile verification
        require configured delivery providers; messages are never simulated as
        sent.
      </p>
    </div>
  );
}
