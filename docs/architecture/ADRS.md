# Architecture decisions

1. One dedicated client deployment, PostgreSQL database and encrypted private object namespace. Properties are permission scopes inside this client, not casual SaaS tenant IDs.
2. Modular monolith: Next web and separate PostgreSQL-backed worker use the same domain services. Durable outbox/inbox, retry leases and dead letters avoid extra queue infrastructure.
3. Bed-level dated reservations. PostgreSQL GiST exclusion is the final overlap guard. Lock the bed before expiry/reallocation; serializable financial transactions use account-row locking and bounded retries.
4. Integer currency minor units stored as BigInt; currency explicit, no FX. Posted history is immutable; corrections append reversals. Proof upload is not settlement.
5. Opaque hashed sessions, scrypt password hashes, property role grants, contact challenges, staff TOTP. Secret payloads and private file bytes use AES-256-GCM with separate managed keys required in production.
6. Private storage adapter with local encrypted volume for local development; scanner quarantine fails closed. Manual approved signed-upload leases supported; external signature provider remains a declared integration dependency.
7. No fabricated client legal clauses or property inventory. Synthetic development fixtures only; approved versioned terms/templates required for real operation.

## 29 October 2026 — organisation foundation and shared-mode gate

The updated engineering brief explicitly requests multiple accommodation-provider organisations. Add Organisation → Property ownership, organisation memberships, a separate explicit platform-provisioning grant and organisation-specific branding/residency/retention metadata and encrypted merchant configuration. Backfill the existing dedicated MIPF properties into a stable organisation without granting operators personal-data access.

Keep the proven dedicated client database/storage deployment as the default while shared-client enforcement is completed. The restricted `legacy_tenant` PostgreSQL role is NOLOGIN/NOBYPASSRLS; `withTenant` verifies membership and sets transaction-local organisation/user context and role so pooled connections cannot leak context. Policies follow property-owned relations and ownership guards reject cross-property identifier laundering. Identity/session and worker control-plane operations remain separate trust boundaries.

This foundation does not make every existing owner connection tenant-scoped. Shared mode must fail closed until routes, service calls, jobs, exports, webhooks and per-organisation provider credentials all use the enforced boundaries and pass negative tests with the actual least-privileged runtime role. Organisation metadata or an optional RLS helper alone is insufficient to declare shared SaaS production-ready. Dedicated deployments may be chosen per client; a physical database per tenant is not promised for an unconfigured shared deployment.
