# Architecture decisions

1. One dedicated client deployment, PostgreSQL database and encrypted private object namespace. Properties are permission scopes inside this client, not casual SaaS tenant IDs.
2. Modular monolith: Next web and separate PostgreSQL-backed worker use the same domain services. Durable outbox/inbox, retry leases and dead letters avoid extra queue infrastructure.
3. Bed-level dated reservations. PostgreSQL GiST exclusion is the final overlap guard. Lock the bed before expiry/reallocation; serializable financial transactions use account-row locking and bounded retries.
4. Integer currency minor units stored as BigInt; currency explicit, no FX. Posted history is immutable; corrections append reversals. Proof upload is not settlement.
5. Opaque hashed sessions, scrypt password hashes, property role grants, contact challenges, staff TOTP. Secret payloads and private file bytes use AES-256-GCM with separate managed keys required in production.
6. Private storage adapter with local encrypted volume for local development; scanner quarantine fails closed. Manual approved signed-upload leases supported; external signature provider remains a declared integration dependency.
7. No fabricated client legal clauses or property inventory. Synthetic development fixtures only; approved versioned terms/templates required for real operation.
