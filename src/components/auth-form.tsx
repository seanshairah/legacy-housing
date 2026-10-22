"use client";
import { useState } from "react";
export function AuthForm() {
  const [mode, setMode] = useState("login"),
    [message, setMessage] = useState(""),
    [secret, setSecret] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <div className="auth-panel">
      <div className="eyebrow">YOUR LEGACY STARTS HERE</div>
      <h1>
        {
          (
            {
              login: "Welcome home.",
              register: "Make room for more.",
              verify: "Verify your account.",
              forgot: "Recover access.",
              enroll: "Secure your account.",
            } as Record<string, string>
          )[mode]
        }
      </h1>
      <p className="muted">
        One account for your application, home, and everything in between.
      </p>
      <div className="tabs">
        {["login", "register", "verify", "forgot", "enroll"].map((m) => (
          <button
            type="button"
            key={m}
            className={m === mode ? "active" : ""}
            onClick={() => {
              setMode(m);
              setMessage("");
              setSecret("");
            }}
          >
            {
              (
                {
                  login: "Sign in",
                  register: "Register",
                  verify: "Verify",
                  forgot: "Recover",
                  enroll: "MFA",
                } as Record<string, string>
              )[m]
            }
          </button>
        ))}
      </div>
      <form
        method="post"
        action="/api/auth"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setMessage("");
          const d = Object.fromEntries(new FormData(e.currentTarget));
          try {
            const r = await fetch("/api/auth", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                ...d,
                action: mode === "enroll" && secret ? "confirm" : mode,
              }),
            });
            const result = await r.json();
            if (result.redirect) window.location.assign(result.redirect);
            else if (result.secret) {
              setSecret(result.secret);
              setMessage(
                "Add this secret to your authenticator, then enter its six-digit code.",
              );
            } else
              setMessage(
                result.error ||
                  result.message ||
                  "Authenticator confirmed. Sign in with its code.",
              );
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
        {secret && (
          <div className="notice">
            Authenticator secret <code className="secret">{secret}</code>Store
            it only in your authenticator.
          </div>
        )}
        {(mode === "login" || !!secret) && (
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
            />
          </label>
        )}
        {message && (
          <p role="status" className="notice">
            {message}
          </p>
        )}
        <button disabled={busy} className="button full">
          {busy
            ? "Please wait…"
            : mode === "enroll" && secret
              ? "Confirm authenticator"
              : mode === "enroll"
                ? "Set up authenticator"
                : mode === "register"
                  ? "Create account"
                  : mode === "verify"
                    ? "Verify code"
                    : mode === "forgot"
                      ? "Request recovery"
                      : "Sign in"}{" "}
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
