# Implementation status

Target: `seanshairah/legacy-housing`, branch `codex/legacy-heights-enterprise-platform`. Reference remains unchanged at `a795d790533b31209c820311f27ebb035ae30872`. The original DOCX was supplied on 23 October 2026 and is preserved under docs/reference/client. Its 141 substantive leaf items are individually audited in docs/audit/ORIGINAL_SCOPE_COMPLETENESS.md; the master brief remains supplementary engineering guidance.

## Delivered locally

- Phase 0: boundaries, source inventory, classified evidence/risk register, per-client-item traceability, reuse/rewrite decisions, architecture, data and permission model, plan.
- Foundation: dedicated target, Next/React/TypeScript, PostgreSQL/Prisma, ten migrations, scoped roles, opaque/revocable sessions, strong scrypt hashes, contact challenge/recovery, staff TOTP enrollment/confirmation auditing and session revocation, nonce script CSP, exact-origin mutation checks, audit/outbox/inbox, API keys and CI.
- Admissions: property/building/floor/room/bed management, accessible list, date/bed/term quotes and retained snapshots, SQL overlap constraints, holds/expiry, prioritized waiting offers with explicit acceptance, application/KYC/history/withdrawal.
- Files: private authenticated encryption, version hashes, 10 MB allowlist, quarantine, bounded parser child process, real ClamAV, bounded exponential scan retries with reviewer recovery, reviewer decisions, medical consent and separate medical access.
- Finance: server pricing, minor-unit charges and allocations, partial/unallocated balances, bank/cash voucher maker-checker and duplicate fingerprints, verified receipts, statements and Unicode PDFs, credits and refund reversals, monthly idempotent billing, Paynow signed poll/callback/replay/ambiguity/late-refund controls.
- Residency: template versions and approved source snapshots, manual signed-upload and native authenticator-backed electronic signing with document-bound one-use review, approved disclosure, exact signed-file hash, immutable executed evidence, check-in/out and turnover, renewal/transfer requests/review, lease reminders.
- Operations: maintenance/complaint/compliment/support, scoped assignment, responses/history and scanned resident/staff attachments, SLA escalation, reports, real account/resident/staff views, property notices, notification preferences, durable delivery retries/dead letters.
- Integration and governance: scoped versioned read/API command boundary, expiring delegated read keys, accounting/SIS/PMS CSV adapters, consent-gated student exchange, local connection checks, audit exports, resident data export and client-admin privacy review.
- Handover: Docker web/worker/Postgres/scanner/daily backup definition, matching database client tools, encrypted backup/verified local restore, operational/user guides, seven synthetic-data screenshots, threat map and release evidence.

## Verified

The 22 October baseline passed 33 PostgreSQL/domain tests and 5 browser/accessibility tests. The expanded scope audit verification is recorded in QA/SCOPE_AUDIT_EVIDENCE. Baseline checks included type/lint/format, production build and image build. Real clean-PDF/EICAR scan; local encrypted restore with file hash verification. npm audit zero advisories; four-rule Semgrep scan zero findings. Measured local catalogue p95 74.63 ms at concurrency 5 on the documented small dataset. See QA/RELEASE_EVIDENCE for exact scope and limits.

## Outstanding inputs / release gates

Actual client brand/property/rate policies, approved legal/privacy/retention/signature terms, merchant/provider credentials and sandbox tests, selected external ERP/SIS/PMS APIs/mappings, production managed keys/storage/monitoring/TLS/offsite recovery, and independent security/accessibility/load acceptance. Production is not deployed or certified. Do not describe unconfigured adapters, local fixtures or bank demonstration postings as real integrations or funds.

Property/user data access is scoped and audited. Client-wide privacy review requires explicit admin grants for every property; self-service account exports omit authentication secrets. Erasure is held pending legally approved retention/holds and controlled execution. Complete external write synchronization/third-party signature certificates/WhatsApp capabilities are not fabricated.

The GitHub feature branch, PR and remote CI status are recorded at handoff. Updating environment configuration does not itself publish a snapshot or deploy the application.

The source baseline was subsequently validated in an isolated /tmp archive and its own database: 146/146 tests, typecheck and production build passed. This does not erase the separately evidenced security/scope gaps. Fresh local Compose stack startup, health/public page and initial encrypted backup also passed. Docker VFS disk pressure was diagnosed and resolved by removing only obsolete target image/build outputs; source containers and data were retained.

Final financial regressions cover zero-deposit admission without fabricated payment, and idempotent application of verified excess funds to subsequent invoices without another receipt.

## Original Word scope audit — 23 October

Added native electronic signing and direct signed-copy download; in-page agreement reading; published tenancy condition review/hash/consent; source-record renewal/collection/debtor/reconciliation/trend/utilisation reports and CSV; privacy-preserving attack/scan alerts with scoped audited response; missing activity audits and atomic registration/challenge creation; visible-data refresh; weekly security audit and practical training exercises. The signing artifact, consent challenge, evidence event and REVIEW transition commit atomically. Prepared files stay unreachable before commit and are discarded on rollback. New migration protects issued lease source and adds signing/security tables. Exact validation commands/results, source boundary and outstanding legal/provider/host/service gates are in QA/SCOPE_AUDIT_EVIDENCE and the 141-row audit.

Current audit checks: **41 domain/PostgreSQL tests, 8 production-browser/accessibility journeys**, type/lint/format, production and container builds pass locally; zero npm advisories and zero findings in the focused four-rule Semgrep scan (54 source files). Added regression coverage for mixed property-role overview/audit/finance controls and rejected signature return/replacement. Final GitHub run status is reported at handoff separately.
