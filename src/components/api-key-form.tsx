"use client";
import { useState } from "react";
export function ApiKeyForm({ propertyId }: { propertyId: string }) {
  const [result, setResult] = useState("");
  return (
    <form
      method="post"
      action="/api/keys"
      onSubmit={async (e) => {
        e.preventDefault();
        const data = new FormData(e.currentTarget);
        const response = await fetch("/api/keys", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            propertyId,
            name: data.get("name"),
            scopes: data.getAll("scopes"),
          }),
        });
        const value = await response.json();
        setResult(
          value.token
            ? `Copy this key once. It expires in 30 days: ${value.token}`
            : value.error,
        );
      }}
    >
      <h3>Create a read-only integration key</h3>
      <label>
        Integration name
        <input name="name" required maxLength={100} />
      </label>
      <div className="inline-fields">
        {[
          "inventory",
          "admissions",
          "leases",
          "finance.read",
          "operations",
          "reports",
        ].map((s) => (
          <label className="check-label" key={s}>
            <input type="checkbox" name="scopes" value={s} />
            {s}
          </label>
        ))}
      </div>
      <button className="button secondary" type="submit">
        Create scoped key
      </button>
      {result && (
        <p role="status" className="notice secret">
          {result}
        </p>
      )}
    </form>
  );
}
