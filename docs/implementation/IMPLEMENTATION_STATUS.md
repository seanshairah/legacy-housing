# Implementation status — updated engineering brief

Baseline: branch `codex/legacy-heights-enterprise-platform`, commit `40930cb48f461516d4406c44cc133c86f119bae2`. Inspected 29 October 2026. The workspace contains preserved, uncommitted full-workflow QA additions and corrections from the interrupted 23 October session. They have not been discarded or treated as already verified in this restored environment.

The reference `Student-housing-management-` remains read-only at `a795d790533b31209c820311f27ebb035ae30872`. Ivyhouse is an additional read-only workflow reference if repository access permits. No source customer databases may be changed. Existing target architecture and the scope matrix remain the starting point. The new engineering brief extends the former dedicated-client deployment to multiple organisations; that change requires an explicit architecture update and migration.

## Current executable work

1. Restore PostgreSQL, ClamAV, dependencies and isolated test databases, preserving keys/files and prior records.
2. Complete the preserved full HTTPS browser/worker/provider-contract suite; reproduce and correct failures before recording passes.
3. Add organisation hierarchy/configuration, membership boundaries and transaction-scoped database isolation. Verify cross-organisation denial directly with a least-privileged database role as well as application checks. Shared-database SaaS must remain disabled until its complete request/worker boundaries are verified.
4. Add single-use MFA recovery and account invitations, with audit, contact verification, independent permissions and session invalidation.
5. Add policy-approved, hold-aware document retention/deletion. Keep execution disabled until explicitly configured; immutable financial and signed-lease evidence remains retained.
6. Correct dataset-boundary failures in reminders/waitlists/exports and add regression coverage.
7. Produce the requested security, compliance, integration and operational deliverables, then rerun release checks and publish exact evidence in `docs/testing/TEST_EVIDENCE.md` and `docs/MIPF_TECHNICAL_READINESS.md`.

## Existing implementation and evidence

See [previous implementation status](../IMPLEMENTATION_STATUS.md), [scope matrix](../audit/LEGACY_SCOPE_TRACEABILITY_MATRIX.md), [original Word audit](../audit/ORIGINAL_SCOPE_COMPLETENESS.md) and [previous scope-audit evidence](../QA/SCOPE_AUDIT_EVIDENCE.md). Their test results apply to their recorded revisions, not automatically to the current changed workspace. Implemented domains include identity, property inventory, applications/KYC, private scanning, financial ledger/Paynow adapter, manual/native electronic leases, resident lifecycle, tickets, transactional notifications, reporting and API adapters.

## Confirmed defects under correction

- Form redirects used the backend request URL and could downgrade HTTPS behind a TLS proxy; configured public-origin redirects are being verified.
- Waitlist acceptance rejected an empty optional tenancy hash before reaching consent validation; command parsing corrected, regression pending.
- Reminder queries selected only the first 100 eligible records and could repeatedly skip the rest; cursor traversal added, regression pending.
- Waitlist/export batch limits require executed boundary tests before completeness claims.

## Release blockers

No production deployment or live financial transaction is authorised. Merchant sandbox/approved channels, actual email/SMS delivery, client inventory/branding/rates, approved lease/privacy/retention policies, selected hosting region and managed keys/storage/TLS, offsite recovery, independent security/accessibility/load acceptance and operational/legal responsibilities remain external gates. Unknown values must not be fabricated. The system is not currently declared production-ready.

## Executed milestone — 29 October, resumed after interruption

Runtime committed as `4a6efc00c1237f07e2ba4a31308fa179046b2126`; harness-only correction `d5e53405ee21ecf19a428ed555f30dfdabebc9fc`. The restored workspace's preserved work was completed and reviewed before committing; no contributor work was discarded.

Implemented nine new migrations (19 total): organisation graph/config/grants and restricted SQL role, single-use MFA recovery/invitations, scoped privacy records, policy/hold/document disposal, private support notes/confirmation/reopening, immutable merchant binding, payment metadata/disputes, admissions assignment/private notes and booking idempotency. Actual resident/staff UI and server commands are wired. Reminder/waitlist/export dataset starvation, transactional retry, TLS redirects, note/export/attachment privacy, notification templates/logging/fanout, upload messages and accessibility defects are corrected. Patched Zod 4.6.7 resolves the newly reported collection-exhaustion advisory.

Executed consolidated results: **114/114 database/service tests**, measured lines81.99%/branches74.07%, types/lint, production build, zero dependency advisories, zero findings in four Semgrep rules and staged credential-pattern scan; current production image built. Local snapshot restore verifies all54 tables/three document hashes, ledger/immutable evidence and eight negative cases (747ms restore,808ms including acceptance). The expanded production HTTPS browser outcome and final CI state are maintained in [TEST_EVIDENCE.md](../testing/TEST_EVIDENCE.md), rather than assuming unfinished runs passed.

Requested security/compliance/operations/integration deliverables are now present. [MIPF_TECHNICAL_READINESS.md](../MIPF_TECHNICAL_READINESS.md) explicitly separates verified functionality, incomplete engineering and external gates. Shared runtime remains blocked until every persistence caller uses the restricted tenant context; complete person-wide erasure/correction remains further work beyond the implemented document-disposal workflow. Production is not deployed or declared ready.
