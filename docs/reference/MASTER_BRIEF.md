# CODEX MASTER EXECUTION BRIEF

## Legacy Heights — Enterprise Hybrid Student Accommodation & Property Management Platform

**Client:** Legacy Heights Student Accommodation (also referred to as Legacy Housing)
**Implementer:** Codex, acting as principal software architect, lead full-stack engineer, security engineer, database architect, QA lead, and DevOps engineer
**Date:** 22 October 2026
**Mandate:** Build a real, production-oriented application in a NEW, SEPARATE GitHub repository using the existing student housing system as a reference, while implementing the attached client scope in full and extending it into an integration-ready hybrid accommodation operating system.

---

## 0. NON-NEGOTIABLE SAFETY BOUNDARY: SOURCE VS DESTINATION

You have TWO different repository roles. Never confuse them.

**READ-ONLY SOURCE REPOSITORY:** `seanshairah/Student-housing-management-` (https://github.com/seanshairah/Student-housing-management-). This is the existing system. Inspect its code, schema, migrations, tests, workflows, and UX. Reuse, refactor, or adapt proven concepts and code as appropriate, subject to licensing and security review. NEVER commit, push, rebase, open write PRs, change branches, migrate its database, run destructive scripts against its deployment, or modify any file in the source working tree.

**NEW WRITE DESTINATION:** `LEGACY_TARGET_REPO=<the explicitly selected, separately created new GitHub repository for Legacy Heights>`. This is the ONLY repository into which you may write, commit, push, and create PRs. **Do not assume** that `seanshairah/ivyhouse-student-management` is the target: that is another existing branded housing project. If the correct target repo cannot be unambiguously identified from the active Codex working directory/repo URL, the user-provided repository selection, or a verified Git remote, stop all writes and request only the missing destination `owner/repo` name. Read-only analysis and planning may proceed.

**CLIENT SOURCE OF TRUTH:** `Scope of Work-Legacy Heights website.docx` — “Development of a Secure Tenant Portal and Accommodation Management Website for Legacy Heights Student Accommodation.” It is the client brief, not a source-code repository. If the DOCX is mounted or checked into a reference directory, read it and preserve all requirements. The complete checklist is repeated in Section 3 so you can start the audit even if the DOCX has not been attached in your Codex runtime. Do not claim you read the DOCX if you only have this transcription.

Before editing anything:

1. Print `pwd`, `git remote -v`, current branch, last commit, and clean/dirty status of the TARGET; identify source and target separately.
2. Verify that target and source remotes differ. Make an explicit repository-boundary assertion in `docs/REPOSITORY_BOUNDARY.md`.
3. Clone/open the source separately with read-only credentials and never run mutating commands in that working tree.
4. Create a new feature branch in the TARGET, e.g. `codex/legacy-heights-enterprise-platform`; avoid working directly on `main` if the repository uses protected workflows.
5. Examine target existing files before deciding how to initialise it; preserve intended work already in the target and never force-push or overwrite unrelated code.
6. If the source repo, document, target repo, or required credentials are unavailable, record the precise blocker, continue all independent work where safe, and never substitute an invented asset, fabricated verification, or wrong repository.

**Ultimate expected deliverable:** Working source code, migrations, interfaces, tested workflows, integration adapters, operations documentation, and deployment instructions in the NEW target repository. **Not** a specification-only answer, a copied and rebranded marketing page, screenshots, mock dashboards, or a superficial scaffold.

---

## 1. WORKING PRINCIPLES AND EXECUTION DIRECTIVE

You are responsible for end-to-end implementation. First reverse engineer the actual existing application, then map it against the client scope, then produce the architecture and ADRs, then implement in coherent tested vertical slices. Do not immediately perform a blind file copy or mass refactor. Do not erase good existing features. Preserve a working single source of truth for account balances and payment state while improving it. Build the best practical system using measurable evidence rather than unverifiable claims of zero bugs.

Use these decision rules:

- **Mandatory scope:** Every expressly stated client requirement is P0 and must be implemented or represented by an explicitly tracked external credential/compliance dependency. No silent omissions.
- **Enterprise extensions:** Add carefully chosen capabilities necessary for modern operations, accessibility, trust, integrations, auditability, resilience, and extensibility. Classify these as P1 or P2; do not let attractive optional features delay core safety and finance requirements.
- **Reuse:** Retain working concepts/modules when verified safe and well-tested. Do not preserve a bug merely because it already exists. Write regression tests before altering sensitive code.
- **Integrity:** Financial, occupancy, identity, lease, and KYC data take precedence over visuals and animations.
- **Transparency:** Do not label a simulated flow as live, do not hide a failing test, do not invent provider approvals, and do not mark integrations complete without a real sandbox integration test or clearly described test limitation.
- **Autonomy:** Make documented conservative assumptions for routine architectural choices. Request user input only when it is genuinely essential to identify the target repo, provide external credentials, approve legal terms or branding content, configure a real merchant account, or perform production/destructive changes.
- **Security:** Never expose credentials, private ID documents, medical declarations, or payment provider secrets in logs, source control, screenshots, tests, or third-party AI prompts.
- **Scope discipline:** Preserve “student” and “tenant/resident” concepts. This is a hybrid platform, not merely student information software. It must support university-linked student housing AND privately managed accommodation/property operations, with workflows configurable per property and occupant type, without pretending it is a full university academic ERP.

At the end of EVERY major phase publish concrete progress in `docs/IMPLEMENTATION_STATUS.md`: files changed, migrations added, test command/results, demo paths, blockers, known risks, and next work. Continue through implementation rather than stopping after producing a plan.

---

## 2. FIRST TASK: FORENSIC REPOSITORY AUDIT (REQUIRED BEFORE IMPLEMENTATION)

### 2.1 Audit the existing source code comprehensively

Audit the complete directory tree, package manifest/lockfile, TypeScript/Next.js versions, Prisma schema, migration history, seed data, routes, API handlers, server actions, auth/session layers, billing services, Paynow flows, email/SMS, templates, PDFs/printables, error handling, deployment configuration, performance, test suite, and coverage. Inspect BOTH server-side and UI flows and follow data through to persistence. Verify what runs rather than accepting README claims.

Known entry points to inspect first:

- `README.md`, `docs/OPERATING-SYSTEM.md`, `.env.example`, `package.json`
- `prisma/schema.prisma`, `prisma/migrations/**`, `prisma/seed.ts`
- `src/platform/config.ts`, `src/core/platform/**`
- `src/core/auth/**`, `src/lib/auth.ts`, `src/lib/session.ts`, `src/middleware.ts`
- `src/services/applications/index.ts`, `src/app/book/**`, `src/app/owner/applications/**`
- `src/core/billing/**`, `src/services/payments/**`, `src/app/api/payments/paynow/result/route.ts`
- `src/services/documents/index.ts`, document API routes, invoice/receipt/statement services
- `src/services/messaging/**`, `src/services/notifications/**`, `src/services/email/**`, `src/services/sms/**`, `src/services/audit.ts`
- `src/app/student/**`, `src/app/owner/**`, `src/app/caretaker/**`, `src/components/**`
- `tests/**`, `vitest.config.ts`, `next.config.ts`, `vercel.json`

**Preliminary findings from an initial remote source-code inspection. These are audit leads, not conclusively proven defects; verify each with exact file/line, reproduction and tests:**

1. README describes a working MVP with public listing, applications, owner/student/caretaker portals, Paynow, financial ledger, notifications, maintenance, reports, and import facilities. Reuse these ideas; do not rebuild proven finance functions without cause.
2. README explicitly calls student document upload a schema placeholder and acknowledges no multi-tenant application model. The source documents also distinguish separate databases for existing Ivy House and Blessbri deployments. This is a deliberate existing architecture, NOT proof of universal in-app tenant isolation.
3. `src/platform/config.ts` is configured for **Blessbri Properties** whereas `.env.example` contains **Ivy House** examples. Ensure no brand, email, rent rate, contact detail, test profile, property name, or domain leaks into the Legacy Heights target.
4. Source schema has `Room.floor` as an optional string, but a floor-by-floor, accessible, interactive room selection engine and configurable building/floor/bed hierarchy have not been established. Audit UI and underlying model.
5. In `src/services/applications/index.ts`, booking and renewal re-read a room and then update it by `id` to `PENDING_APPLICATION`; investigate true race safety under concurrent transactions and database isolation level. Include deterministic concurrent booking tests. A transaction alone is not a proof of atomic availability enforcement.
6. Room `status` appears to be a room-wide resource, while `occupied` and `capacity` support sharing; examine whether one application unfairly blocks all remaining beds in a shared room. Design reservations for individual beds/spaces and bounded, recoverable holds.
7. New-account approval flows appear able to transmit generated temporary passwords through email/SMS. Replace with secure invitation/verification/password-setup or passkey flows; never send plaintext passwords or secrets over SMS.
8. `src/core/auth/access.ts` currently treats `OWNER` and `CARETAKER` broadly as staff with access to any student’s certain records within their deployment. Implement property-scoped and job-specific least-privilege authorization (finance vs caretaker vs KYC vs administrator) and test cross-property access.
9. `src/services/documents/index.ts` assembles HTML documents using interpolated database values. Review every dynamic value for output encoding/injection risk and ensure produced documents are safe, access-controlled, immutable when issued, and printable/downloadable as actual PDFs where appropriate.
10. `src/services/audit.ts` catches failed audit writes. Design durable auditable events for sensitive financial, KYC, leasing and permission changes; critical events cannot silently vanish.
11. Existing Paynow code shows provider polling, transition logic, a ledger, idempotent allocation goals and mock/live distinctions. Preserve correct parts but test forged callbacks, webhook replay, out-of-order events, ambiguous provider errors, double settlement, reversal, refund, overpayment, partial payment and outage recovery.
12. Existing tests appear meaningful but not exhaustive; establish whether they run against ephemeral/test databases, whether every test is isolated, and whether they cover complete browser journeys, concurrency, tenancy and provider edges.

For every discrepancy classify **Confirmed Defect / Confirmed Missing / Partially Implemented / Works but Needs Hardening / Requires External Integration / Requires Client Decision / Not Applicable**. Include repo file paths, source lines, a reproducible failure or evidence, risk level (Critical/High/Medium/Low), client scope mapping, proposed change, owner, and verification test.

### 2.2 Required audit outputs, written to the TARGET repository

Create before large implementation changes:

- `docs/audit/CODEBASE_INVENTORY.md`: stack, modules, endpoints, entities, roles, integrations, jobs, architecture map, test results and versions.
- `docs/audit/LEGACY_SCOPE_TRACEABILITY_MATRIX.md`: one row per client requirement, with original scope section and status in old source/new target, priority, owner, acceptance test and implementation path.
- `docs/audit/GAP_AND_RISK_REGISTER.md`: specific gaps, contradictions, races, security, UX, performance, financial reconciliation, dependencies, PII, retention, monitoring, integration and operations.
- `docs/audit/REUSE_VS_REWRITE_DECISIONS.md`: retain/refactor/replace/new by module and rationale.
- `docs/architecture/ADRS.md` and `docs/architecture/DATA_MODEL.md`: architectural decisions and diagrams.
- `docs/implementation/PHASE_PLAN.md`: dependency-ordered execution plan with test gates. This is a living plan, not a stopping point.

Before migrating anything, identify all repo-specific sample data, merchant keys, pricing, contact info, organization names, copyright/licensing constraints, branded assets, seed users, domains and defaults, and remove or replace them in the target.

---

## 3. COMPLETE CLIENT SCOPE: TREAT EVERY ITEM AS REQUIRED (P0)

This section transcribes the substantive requirements of the nine-page Legacy Heights scope. The DOCX, where available, remains authoritative. Build traceability for each item. Do not collapse multiple requirements into a single checkbox.

### LH-A. Student registration and user management

- Secure self-registration and login, verified email **and** mobile number, password recovery/reset, account recovery, available MFA (prefer passkeys or TOTP; assess SMS OTP risk), audit logs, session management and revocation.
- At minimum implement roles: **Student**, **Accommodation Administration**, **Finance Team**, **Property Management Team**, and **System Administrator**.
- Extend with carefully permissioned caretaker/maintenance, leasing/KYC reviewers, property managers, finance approvers and optional read-only auditors. Student identity and tenant/resident identity should coexist; do not create duplicate people on each application.

### LH-B. Room selection and booking

- Interactive room availability; building/floor-by-floor navigation; room categories: single, shared, premium, accessible where applicable; live occupancy; pricing by room/bed/date/lease term; online reservation.
- Safe temporary holds during payment, expiration and release, waiting lists when full, priority controls and transparent wait-list notifications.
- Strong reservation concurrency, accessible room selection without visual floor plans, configurable occupancy/capacity, prevention of overlapping bookings and over-allocation.

### LH-C. Online lease application

- Complete application online, submit electronically, review terms, versioned consent to terms and conditions, stage/status tracking and review workflow.
- Require a resident to see the exact status and next required action: incomplete, submitted, documents pending, in review, approved/declined, deposit pending, lease signing pending, ready for move-in, active or withdrawn, as applicable.

### LH-D. KYC and document management

- Secure upload for national ID/passport, student registration letter, proof of residence when applicable, emergency contact details, sponsor letters, medical declarations and additional supporting material.
- Encrypted private file storage, MIME and content checks, allowlists/size limits, malware scanning, upload quarantine, secure access/short-lived downloads, version history, reviewer approval/rejection, reasons and resubmission.
- Treat medical declarations as sensitive data with much narrower access than standard KYC. Add retention, audit, consent/legal-basis records and access request workflows.

### LH-E. Online payments

- Actual integration with **Paynow Zimbabwe** for deposits, rents, utilities where applicable, penalties and miscellaneous invoices.
- Secure transaction initiation, authoritative settlement confirmation, instant update **after verified confirmation**, immutable receipts, downloadable receipts, transaction history, failed/pending alerts, status visibility, reconciliation and refund support.
- Support EcoCash, OneMoney, and card/hosted flows to the extent verified available from the configured Paynow merchant integration; do not hardcode unsupported payment methods or currencies.

### LH-F. Proof-of-payment workflow

- Resident uploads proof plus bank/reference metadata; finance reviewer accepts/rejects and records decisions; maker-checker approvals configurable; mismatch/duplicate detection and reconciliation reports.
- Uploading evidence is NEVER itself payment confirmation. A reviewer must verify bank/payment evidence, and posting a verified payment must be atomic, idempotent, permissioned, audited, reversible with controlled adjustments and connected to its corresponding invoice/charge.

### LH-G. Digital lease execution

- Generate a lease from approved, versioned templates; send to resident; electronic signing capability; manual signed document upload; secure storage; legal evidence trail; student online view/download; lease approval, renewal and expiry reminders/status.
- Capture exact signed document hash, signer identity, document version, timestamp, signing event evidence and immutable final copy. Use a proper electronic-signature provider or reliable auditable signing implementation, with final local legal enforceability verified by qualified Zimbabwean counsel. Do not invent legal compliance certification.

### LH-H. Feedback, maintenance and support

- Compliments, complaints, maintenance requests and support requests; unique tickets; status tracking; responses; severity, category, SLA, escalation, notifications; communication history; attachment support where safe.
- Manager views with time-to-first-response, time-to-resolution, reopened cases, repeat issues, backlog and service performance reports.

### LH-I. Student dashboard

- Assigned room, lease, balance, invoice/payment history, document checklist, maintenance requests, announcements/notices, application and feedback status, next actions, receipts and downloadable agreements.
- Show accurate real-time or timely refreshed data and never inconsistent fake analytics.

### LH-J. Administration portal

- Room allocation/vacancy, move-in/check-in, check-out, turnover, occupancy; lease approvals/renewals/expiry; invoicing, collections and outstanding debtors; relevant reports.
- Reports explicitly include occupancy, revenue, leases, maintenance, complaints and feedback.

### LH-3. Security and protection

- HTTPS/TLS, MFA capability, RBAC, strong passwords/session controls, encrypted private files, anti-malware scanning, intrusion monitoring, regular audits, automated daily backups, disaster recovery, comprehensive auditable user activity.
- Build controls to a traceable OWASP ASVS 5.0 baseline suited to the data risk; review data obligations under Zimbabwe’s Cyber and Data Protection Act and applicable regulations, with legal sign-off on the actual deployment.

### LH-4. Notifications

- Email, in-app notifications, and optional SMS/WhatsApp (as actually configured) for applications, payments, lease approvals, lease expiry, maintenance and feedback updates.
- Delivery status, retry/dead-letter handling, preferences, templates and opt-in/opt-out where applicable.

### LH-5. Integrations

- Paynow; accounting/ERP; student information systems (SIS); property management systems; email/SMS gateways. Implement open APIs, events and adapter contracts, not merely a list of integration logos.

### LH-6. Analytics

- Occupancy level and utilisation, revenue collected, unpaid rent/debtors, lease renewals, complaints trends, maintenance response times and collections performance. Filters by property/building/floor/room/time period with finance vs operations authorization boundaries.

### LH-7. Client deliverables

- Secure responsive public website; student/tenant portal; admin platform; live-capable Paynow connector; digital leases; KYC/document control; ticketing; source code; data migrations; deployment/infrastructure definition; setup and operations docs; user manuals and training materials; post-launch maintenance guide.

**Specific unresolved business rules to capture in a `docs/CLIENT_DECISIONS.md` template instead of guessing:** real Legacy Heights logo/assets/contact/directions, property inventory and floor plans, available room/bed types, pricing and currency per property, deposit and cancellation policy, minimum booking duration, hold TTL, accessible room policy, lease terms/signing provider, data retention periods, payment/merchant credentials, proof verification rules, escalation SLA, exact property owner/legal entity and email/SMS/WhatsApp providers. Provide configuration defaults that are safe and visibly changeable; never invent corporate information or lease clauses.

---

## 4. HYBRID PRODUCT VISION: THREE INTEGRATED EXPERIENCES

### A. Public accommodation website + conversion engine

Professionally designed Legacy Heights public site, mobile-first: homepage, about/brand, property and room inventory, photo galleries, facilities, pricing, accessibility, FAQ, contact, policy pages, availability search, comparison, floor browser/accessible list view, application/reserve CTA, application continuation, optional guided virtual tours, configurable content-management console and SEO/structured metadata. Genuine brand data, not leftover Blessbri/Ivy content. Do not substitute stock footage or fabricated testimonials for real client assets.

### B. Resident / applicant / student portal

Single identity across enquiry, application, document approval, sponsorship/guarantor info, room hold, deposit, lease signature, check-in, residency, billing, tickets, announcements, renewals and check-out. Work equally for individual private renters and university-associated students; student-specific fields are conditional, not mandatory for non-students. Accessible on mobile with no mandatory app download; optional PWA functionality for frequently used portal screens, with secure caching/no offline storage of sensitive documents.

### C. Operational, finance, facilities, leasing and corporate back office

Role-specific workspaces for front-desk/admin, property manager, admissions/leasing, KYC reviewer, finance officer, maintenance/caretaker, superadmin and auditor; dashboards with actionable queues. System manages multiple properties, buildings, floors, rooms, individual beds/spaces, amenities, ownership/legal entities, tenant/lease history, accounting flows, maintenance schedules and external partners. It is integration-first and can run standalone or alongside ERP/SIS/property software.

**Architectural default:** A dedicated Legacy Heights deployment with its own isolated database and object storage, supporting multiple properties/buildings. Make future multi-client SaaS support a deliberately designed boundary: per-client database/storage isolation and a control-plane/provisioning design OR independently reviewed strong tenant scoping/RLS. Do NOT retrofit a casual `tenantId` column to existing queries and call it secure. No cross-client admin access without explicit grants, tests, and auditing. The client’s current scope does not justify mixing their sensitive KYC into another client’s database by default.

---

## 5. DOMAIN DESIGN: REQUIRED DATA MODEL AND INVARIANTS

Design Prisma/PostgreSQL models/migrations and service interfaces for the following (choose robust names and avoid duplication):

**Organisations and inventory:** Organization/LegalEntity, Property, Building, Floor, Unit/Room, Bed/Space, RoomType, Amenity, ImageAsset, AccessibilityFeature, RatePlan, PriceRule, UtilityMeter/UtilityCharge (if applicable), Term/AcademicPeriod, InventoryBlock, AvailabilitySnapshot (derived/cache only), WaitlistEntry, Hold, Reservation and allocation history.

**People and identity:** User, Identity, Role, Permission, Membership/Scope, Applicant, Resident, StudentAcademicInfo, Sponsor/Guarantor, EmergencyContact, VerifiedContactMethod, MFACredential, Session, Invitation, Consent, Activity/AuditEvent. Avoid duplicate person records when email/phone changes; handle legitimate duplicate identifiers safely.

**Leasing and KYC:** Application, ApplicationStageHistory, RequirementChecklist, KYCSubmission, DocumentVersion, FileAsset, MalwareScanResult, ReviewDecision, ApprovalRule, LeaseTemplateVersion, Lease, LeaseParty, SignatureEnvelope, SignatureEvent, ExecutedLease, Renewal, Notice, MoveInInspection, MoveOutInspection, CheckInOut, DepositDisposition.

**Finance:** LedgerAccount/Charge, Invoice/InvoiceLine, CreditNote, PaymentIntent, PaymentAttempt, GatewayTransaction, Payment, PaymentAllocation, Receipt, Deposit, Refund, Adjustment/WriteOff, BankImport, ProofOfPayment, ReconciliationBatch, ReconciliationMatch, Payout/Settlement, AuditEvent, Tax/fee config where applicable. Extend the source unified charges-and-allocations design; add accounting journals where needed for ERP exports and hard financial auditability.

**Operations:** ServiceTicket, Category, Priority, SLA, TicketMessage, Attachment, Assignment, Escalation, Asset, PreventiveMaintenancePlan, WorkOrder, Contractor (optional), Announcement, ContactMessage, Notification, NotificationDelivery, Template, DeliveryPreference.

**Integrations and governance:** IntegrationConnection, EncryptedSecretReference, ApiClient, ApiKeyHash, OAuthConnection (where applicable), WebhookSubscription, WebhookDelivery, OutboxEvent, InboxEvent, SyncJob, MappingDefinition, ExternalIdMapping, ImportBatch, ExportBatch, ImportError, JobRun, AuditLog, FeatureFlag, AppSetting.

**Non-negotiable consistency rules and database constraints:**

1. A bed cannot be allocated to overlapping active leases/confirmed stays; a shared room may have multiple occupied beds but never exceed capacity; maintenance-blocked beds are unavailable. A room-level display cannot be the only inventory lock.
2. A hold belongs to a specific bed or appropriately constrained space inventory and has an expiration; expiry must be safe, idempotent and recoverable after worker downtime. Reservation/hold and lease lifecycle are explicit and separately versioned.
3. No double-booking under simultaneous submissions, retry, different API instances or different users. Use database constraints, conditional updates, SERIALIZABLE where warranted, bounded retries and contention integration tests, not a read-then-update-by-ID alone.
4. Application approval, payment and lease execution are related but separate state machines. Specify whether/when a hold becomes a confirmed reservation and whether deposit or signature is required; default to preventing physical check-in until required checks pass.
5. Every financial posting has unique external references, immutable evidence and idempotency; use integer minor units or decimal arithmetic, NEVER JavaScript binary floating-point for payable calculations. Provide explicit currency configuration and FX rules; no silent USD/ZWG conversion or settlement assumptions.
6. A receipt is issued only after verified settlement or approved/manual verified tender; proof upload cannot create settled funds. Replays and out-of-order callbacks cannot duplicate allocations or receipts.
7. Balances are deterministically derived from valid posted charges/allocations/credits. All financial corrections use explicit audited reversals, not deletion of settled history.
8. An executed lease version is immutable; amendments create superseding versions. KYC file versions have immutable evidence with controlled retention and deletion procedures.
9. All privileged actions are authorized at object and property scope on the server; UI hiding alone means nothing. Caching, jobs and exports preserve the same scope.
10. External integrations can retry without duplicate records. Use durable outbox/inbox patterns and reconcile through stable external-id mappings and replay protection.
11. No circular cascades that accidentally erase financial evidence, signed agreements, or audit records. Retention and erasure must reconcile privacy obligations with legal recordkeeping.

Produce ERD (Mermaid acceptable), unique/check/index constraints, transaction boundaries, data migration plan, seed strategy and readable domain/state diagrams. Test each invariant at database and service level.

---

## 6. END-TO-END VERTICAL WORKFLOWS TO IMPLEMENT AND DEMONSTRATE

For each journey implement UI + API/server action + permissions + validation + persistence + notifications + audit + tests, and record a demonstrable path in `docs/QA/JOURNEYS.md`.

**J01 — Discover and enquire:** anonymous user sees real property inventory, public photos/prices and accurately derived availability, chooses property/building/floor/room or accessible list, saves enquiry. No account leak.

**J02 — Register and verify:** applicant registers, verifies email/phone, securely sets password, optional MFA enrollment, recovers account, revokes sessions, manages consent. No emailed/texted passwords.

**J03 — Apply and upload KYC:** versioned application and checklist; student/tenant fields adapted by resident type; secure upload and quarantine; documents reviewed by authorized reviewer; approved/rejected/reupload state/history.

**J04 — Reserve and waitlist:** bed-level hold with TTL, simultaneous-booking contention test, expired hold release, manual allocation, accessible allocation review, fully booked -> waitlist -> offer -> expiry -> next candidate.

**J05 — Pay deposit and confirm:** finance server computes amount, payment intent initiated, verified Paynow result/poll, success/fail/timeout/retry, ledger/reconciliation/receipt, no fake settlement. Preserve a pending state during ambiguous provider outages.

**J06 — Issue and sign lease:** approved tenancy template, legal terms acceptance, verified signer, digital signature or signed-upload/manual-review, immutable version/hash/audit, notifications, lease activation only when conditions are satisfied.

**J07 — Check in / resident live:** authorised move-in verifies requirements, allocates bed, inventory updates, resident dashboard displays lease/account/messages; emergency contact and privacy handled correctly.

**J08 — Bills and evidence:** scheduled rent/utilities/fees with idempotency; invoices, partial payments, credits, overdue rules and dunning; manual cash/bank entry via restricted finance workflow; proof-of-payment review cannot create money silently.

**J09 — Maintenance/complaint:** resident logs maintenance or complaint, attachments, assignment, triage, SLA timers, escalation, status notifications, resolution and feedback; management sees accurate response metrics.

**J10 — Renew or transfer:** tenant requests renewal or room transfer, checks new availability and eligibility, records lease version and new charges, avoids overlapping commitments or misallocated beds.

**J11 — Exit and deposit:** notice, check-out checklist/inspection, damages/charges, approvals, refund/credit ledger and vacancy turn-around. Preserve history.

**J12 — Reporting, ERP and SIS:** authorized manager filters KPIs, views data lineage and exports; connector creates/updates accepted records, fails safely, retries, reconciles duplicates, emits webhooks with HMAC signatures, is permissioned and monitored.

**J13 — Disaster and provider resilience:** database restoration drill in a non-production environment; expired holds after downtime; delayed webhook; resend/retry failed email; scan service unavailable; ERP API failure; integration secrets rotation; outage health alerts.

Each scenario needs positive, negative, error-path and role-crossing tests. Automate browser E2E flows with Playwright (or equivalent), and use a separate disposable PostgreSQL test database.

---

## 7. APPLICATION ARCHITECTURE AND STACK

Start with the inherited Next.js/React/TypeScript/PostgreSQL/Prisma stack if the audit validates it; update vulnerable/deprecated dependencies deliberately and verify compatibility. Prefer a well-structured **modular monolith**, not premature distributed microservices.

Recommended structure (adjust based on actual target repo):

```
apps/web/                   # Legacy Heights public site, applicant/resident + staff portals
apps/worker/                # asynchronous jobs, notifications, reconciliation, expiry
packages/domain/            # models, states, use cases, domain policies
packages/db/                # Prisma schema, migrations, repositories, seeds
packages/integrations/      # Paynow, accounting/ERP, SIS, PMS, SMS, email, e-sign, storage
packages/contracts/         # OpenAPI schemas, Zod validation, webhooks/events
packages/ui/                # accessible design system/components
packages/config/            # policy/config/schema and tenant boundaries
docs/                       # runbooks, architecture, scope matrix, test artifacts
infra/                      # Docker, deployment manifests, backup and observability
```

A single application repository layout is acceptable if that is simpler, provided the boundaries remain clear and deployable. Do not create packages just to decorate the tree.

Engineering constraints:

- Node.js maintained LTS, package-lock discipline, pinned supported versions, no runtime unsupported packages.
- Server-side authn/authz; consistent Zod validation and DTO contracts; deny-by-default permissions; audited actions.
- PostgreSQL transactions/constraints, Prisma migrations, connection pooling; no migration by `prisma db push` in production.
- Background worker/queue for emails, webhooks, scans, invoices, holds, reconciliation, reminders; durable retry and dead-letter facilities, visible job history. Choose Redis/BullMQ, Postgres-backed job queue or equivalent with rationale.
- S3-compatible private object storage or equivalent, envelope encryption/key management and pre-signed access, upload quarantine/scanning, access revocation and lifecycle/retention policies.
- Containerised local environment for web, worker, Postgres and dependencies; one-command documented startup, safe nonproduction fixtures.
- Hosted deployment strategy selectable for Zimbabwe-accessible production hosting; provider choice should match uptime, costs, backups, storage, DB and regulations, not be asserted without verified support.
- Accessibility: responsive, keyboard operable, semantic HTML, readable focus, WCAG 2.2 AA-oriented checks, sensible loading/error/empty states, accessible calendar and floor selection alternatives, reduced motion.
- API: versioned OpenAPI 3.1 contracts `/api/v1/...` for inventory, applicants, leases, invoices, payments, tickets, analytics and integrations; pagination, filtering, scoped auth, validation, idempotency keys, stable error codes, rate limits.
- API and UI must call the same domain services; no duplication of financial or authorization rules across routes.
- Events/outbox: `resident.created`, `application.submitted`, `kyc.approved`, `hold.expired`, `lease.executed`, `invoice.issued`, `payment.settled`, `service_request.updated`, etc. Event versioning + trace IDs.

### External systems and connectors

Build an integration hub with explicit interfaces:

- `PaymentProvider` (Paynow first); sandbox/production isolation; verified merchant account currency and method capability; reconciliation jobs.
- `AccountingConnector` for CSV/manual exchange + a real adapter for a selected supported ERP (e.g., Odoo) if sandbox/docs/credentials are available; invoice/customer/payment export, chart-of-accounts/tax mapping and reversals.
- `StudentInformationConnector` with enrolment/registration confirmation, institution mapping, term dates, sponsor information and opt-in consent; API/CSV/SFTP fallback.
- `PropertyManagementConnector` for external units/leases/residents with conflict-resolution policy and declared system of record per entity.
- `MessagingProvider` for email and SMS; WhatsApp via approved official Business Platform/provider only, explicit opt-in and template approvals.
- `SignatureProvider`, `AntivirusScanner`, `ObjectStorageProvider`, and optional `IdentityProvider` (OIDC/SAML for future organizational SSO).

For each adapter implement credentials/configuration UI, test-connection operation, durable synchronization with retries/backoff, signature verification, observability, mappings, conflict management, audit logs, operator override, setup documentation, mocked tests and sandbox contract tests. Never call an integration 'live' if its credentials or external approvals are missing; mark it **Ready for credentials**, **Sandbox-validated**, or **Production-verified** with supporting evidence.

Never implement arbitrary third-party `fetch(url)`/webhook forwarding from user-controlled URLs without SSRF protections, HTTPS enforcement, DNS/IP restrictions and signing controls. Keys must be encrypted/managed, masked in UI, rotated and scoped. Do not import arbitrary PII into ERP or external services without permissions and appropriate legal basis.

---

## 8. SECURITY, PRIVACY AND LEGAL QUALITY BAR

Threat model authentication, session theft, account enumeration, IDOR/BOLA, privilege escalation, property scope leakage, sensitive KYC disclosure, malicious uploads, PDF/HTML injection, stored XSS, CSRF, SQL injection, webhook forgery/replay, SSRF, race conditions, duplicate settlement, credential theft, audit tampering, backups and admin impersonation. Use systematic OWASP ASVS 5.0 checks and an attack-path test plan.

Mandatory controls:

- TLS/secure cookies, CSRF protection for cookie-mutating requests, secure session lifetime/rotation, MFA for staff/finance/admin, controlled recovery and session revocation.
- Fine-grained role AND property AND object-scoped authorization in service layer, API, files, jobs, reports and imports; maker-checker segregation for finance/KYC when configured.
- Hashed passwords (Argon2id or vetted bcrypt policy with migration), rate limiting based on robust trusted-proxy logic, abuse monitoring, secrets scanning and least-privileged service credentials.
- Data at rest encryption, key management, versioned encrypted backups, tested restore processes, access logs, malware quarantine.
- Document access signed URLs with short TTL, permission re-check, secure headers, no public bucket exposure, no KYC in frontend analytics/logging.
- Audit chain for financial posting, permission change, KYC decision, lease signing, manual reconciliation and exports; capture who/what/when/why/previous-to-new and source. Prevent silent failure of critical audit events by storing auditable changes in same transaction/outbox when viable.
- Strong CSP, headers and output encoding on all HTML/PDF rendering, safe Markdown if used, no dangerouslySetInnerHTML with untrusted source.
- `npm audit` (or SCA equivalent), Semgrep/static scanning, type safety, and dependency provenance as part of CI.
- Privacy notice, lawful basis/consent evidence, retention/deletion/export workflow and configurable data minimization; privacy impact assessment for ID/passport/medical documents. Confirm applicable Zimbabwe legislation and regulations with competent legal/data protection review before going live; do not claim certification.
- Signature enforceability and document retention legal validation gate before live agreement execution.
- Full separation of dev/test and production, no default production admin accounts, no fallback mock Paynow or SMS in live mode, fail-closed provider configuration checks.

Follow official provider and standards documentation when implementing, particularly:

- OWASP ASVS 5.0: https://asvs.owasp.org/
- Zimbabwe Cyber and Data Protection Act (legislation; verify applicable changes): https://zimlii.org/akn/zw/act/2021/5
- Paynow Developer Hub: https://developers.paynow.co.zw/docs/paynow/status_update/ and https://developers.paynow.co.zw/docs/paynow/initiate_transaction/

---

## 9. PREMIUM UX / DESIGN DIRECTION

Make Legacy Heights feel like a coherent, polished enterprise accommodation product, significantly more refined than the inherited MVP, without sacrificing usability or performance.

**Design language:** spacious, modern, restrained, premium, trustworthy, warm yet professional. Establish proper Legacy Heights brand tokens only from real client identity or provide neutral, clearly replaceable placeholders pending branding assets. Consistent typography, spacing, shadows, surfaces, color contrast, icons and microinteractions, not decorative heavy animation. Responsive from small phones through desktop; optimal information hierarchy and task-oriented navigation.

**Distinct dashboards, not one admin screen with hidden tabs:**

- **Resident:** action-first dashboard (complete documents, sign lease, pay invoice, upcoming check-in, open ticket).
- **Front desk/admissions:** new applications, identity checks, waitlist, holds, allocations, lease signing.
- **Finance:** collection trends, bank/proof queue, invoices, arrears, reconciliation exceptions and exports.
- **Property operations:** occupancy, floor plans, service tickets, contractor assignments, inspections, vacancies.
- **Executive:** cross-property trends, projections using labeled assumptions, audit status and service KPIs.
- **System admin:** permissions, properties, integrations, templates, policies and security events.

Provide loading/empty/error/success states, bulk operations with confirmations and undo where safe, server-side pagination/search, charts with readable accessible tables, property and date filters, guided onboarding, real audit history, and keyboard/mobile parity. Document UI flows and design tokens. Do not show real private student records in unauthorised demos or use hard-coded production dashboard numbers.

---

## 10. PHASED IMPLEMENTATION — BUILD, NOT JUST PLAN

### Phase 0 — Discovery and safeguards

- Confirm target repository; make source read-only; read DOCX; inventory source; run baseline tests; dependency/security checks; map roles and workflows; deliver traceability and risk register.
- Identify assumptions and client decisions without inventing details.
  **Gate:** exact target asserted; source untouched; scope matrix covers every client item; baseline findings are reproducible.

### Phase 1 — Foundation and security

- Initialise/upgrade target with clean Legacy Heights branding/config and layouts, environment validation, DB/test/worker environment, auth/MFA, scoped roles, audit, safe seeded fixtures, CI and health/observability.
- Establish property/building/floor/room/bed architecture and safe migrations.
  **Gate:** build/typecheck/lint/tests pass, no imported demo data in production, negative authorization tests green, audited admin access.

### Phase 2 — Applications, inventory, KYC and reservations

- Public site and catalogue, floor/accessible selection, registration/verification, applications/status, bed-level holds and waitlist, KYC upload scan/review and status updates.
  **Gate:** simultaneous applications never overbook; expired holds recover; only authorized reviewers see sensitive documents.

### Phase 3 — Financial engine and Paynow

- Adapt proven ledger; charges/invoices/deposits/penalties/utilities, verified gateway states, payments/receipts, manual proof review, reconcile/reporting, partial/over/refund flows, finance permissions.
  **Gate:** provider sandbox verified where credentials available, callback replay does not duplicate money/receipts, finance statements exactly reconcile.

### Phase 4 — Leases, resident operations, service tickets

- Lease template, signature/manual approval, reminders/renewal/expiry, check-in/out and moves, ticket workflows/SLA/escalations, resident dashboard and notifications.
  **Gate:** signed lease immutable, unauthorized edits rejected, all 12 core journeys tested.

### Phase 5 — Integration platform, analytics and expansion

- Versioned REST/OpenAPI, webhooks/outbox, connectors for ERP/SIS/PMS, SMS/WhatsApp/email, import/export/sync dashboard, comprehensive analytics, enhanced reporting and roles.
  **Gate:** contract tests and robust integration failure recovery pass; status accurately reflects live/sandbox/pending external dependencies.

### Phase 6 — Hardening and release readiness

- End-to-end browser suite, accessibility audit, load/concurrency/performance tests, SAST/SCA/security checks, secrets scan, incident/backup restore drill, production env verification, manuals/training, deployment plan, rollback, support handover.
  **Gate:** no open Critical/High security or data integrity defects; all mandatory scope rows trace to verified tests; operator can follow runbooks on a fresh environment.

**Do not defer Phase 2–4 to “future work” without marking a genuine blocker.** Implement vertical slices fully rather than scaffolding every page with disconnected buttons. Do not abandon the task after writing the design documents.

---

## 11. TESTING AND RELEASE ACCEPTANCE CONTRACT

Set up CI to run reliably on PRs and default branch as appropriate:

1. Clean install, dependency integrity, typecheck, lint, format, build.
2. Unit tests for pricing, ledger invariants, allocation, notices, roles, KYC/checklist rules, lease states, inventory and dates.
3. PostgreSQL integration tests for migrations up/down/forward, concurrency, uniqueness, double booking, rollback, reservations, payment idempotency and provider out-of-order callbacks.
4. Playwright (or equivalent) E2E for J01–J13 across desktop and mobile, including unauthorized ID swaps, property-role violations, failed uploads and network failures.
5. Security tests for IDOR/BOLA, XSS, malicious upload, CSRF, brute-force limits, signing verification, webhook replay and data scope.
6. Integration contract tests using provider stubs/sandbox; record exactly which real provider checks occurred and which are blocked by keys/approvals.
7. Accessibility, visual regression for high-use pages, screen-reader/keyboard checks and WCAG-oriented review.
8. Performance and load tests on representative test data; report p95 response times, concurrency, SQL query counts, memory, error rate and configuration. Set measurable agreed service objectives, not empty claims of instant/perfect performance.
9. Disaster recovery drill: backup created, encrypted, restore completed to clean nonproduction environment, data reconciled, recovery time/recovery point measured.
10. Audit/financial reconciliation checks: no unbalanced ledger corrections, duplicate receipts, orphaned objects, past-due unpaid status misrepresentation or data across property/organization scope.

**Release policy:** Block release for Critical/High defects involving security, authorization, finance, residency allocation, executed leases, or data loss. Maintain a known-issues register for accepted lower-severity work. No fake green tests or bypassing CI; if a check cannot run, mark it BLOCKED with the reason and a reproduction command. Document actual test output in `docs/QA/RELEASE_EVIDENCE.md`.

**Definition of done for each feature:** frontend, backend, database, validation, permissions, domain events, audit, notifications as required, error handling, API contract, tests, observability, documentation, accessibility, and demonstrated end-to-end user flow. A rendered UI card without these is NOT feature completion.

---

## 12. OPERATIONS, TRAINING AND HANDOVER

Ship these real deliverables inside the TARGET:

- `README.md`: product identity, architecture overview, local setup, service diagram, env list, test/build commands, data migration guide and demo instructions.
- `.env.example` with Legacy placeholders only (no real secrets, no copied brand/company defaults).
- `docs/architecture/**`: ERD, sequence diagrams, ADRs, cross-system integration diagrams and permission matrix.
- `docs/audit/**`: inventory, scope traceability, discrepancy/risk register, reuse decisions.
- `docs/QA/**`: test strategy, journey test cases, provider sandbox evidence and release report.
- `docs/ops/RUNBOOK.md`: configure/install, backup/restore, log/metric inspection, job retries, inventory repair, payment reconciliation, provider outage playbooks, incident response, key rotation, rollbacks.
- `docs/USER_GUIDES/`: resident, receptionist/admin, leasing/KYC, finance, caretaker/maintenance, executive and superadmin user guides with screenshots using synthetic records only.
- `docs/CLIENT_DECISIONS.md`: pending real-world inputs and default policies that must be signed off.
- `docs/INTEGRATIONS.md`: provider setup, API specification, secrets handling, events/webhooks, Odoo/ERP/SIS/PMS mapping examples, verification status and limitations.
- `docs/IMPLEMENTATION_STATUS.md`: delivered modules, verified tests, remaining blockers and exact next steps.
- Container/dev infra, reproducible seed/test data, `prisma migrate deploy` strategy, CI workflow(s), production readiness checklist, deployment/rollback script(s), monitoring alerts and post-implementation maintenance checklist.

No assumption that the site is already deployed. If the environment lacks production credentials, deliver full working local flows with clearly identifiable mocks only in dev/test and documented handoff for verified live configuration. Do not invent a deployed URL, merchant status or legally binding e-sign certificate.

---

## 13. EXPECTED CODEX REPORTING FORMAT

After Phase 0, give a concise evidence-led assessment containing:

**A. Verified baseline:** actual source commit, target commit, frameworks, database/migrations, working features, test/build results.

**B. Mandatory client scope matrix:** each LH-A through LH-J plus LH-3 through LH-7; detailed sub-requirements with status, evidence, planned implementation and acceptance test.

**C. Defects and discrepancies:** file + line, severity, user consequence, reproduction and fix strategy. Separate known defects from plausible risks.

**D. New system architecture:** decisions on modules, inventory holds, database isolation, identity/KYC, payment settlement, lease signing, APIs and integration hub, with trade-offs.

**E. Execution:** changes committed **only to the target branch**, test commands/output, demo credentials created only for local testing, unresolved outside dependencies.

At the final handover report:

- Exact TARGET repo and branch/PR/commit links.
- Confirm SOURCE repo unchanged and state evidence (source SHA before/after, no writes).
- Exact implemented features against scope, with links to code, tests and docs.
- Verified user journeys and screenshots/video only if generated from a functioning build and synthetic data.
- Production configuration items still requiring Legacy Heights' input, legal approval, or a paid provider subscription.
- Measured performance, security/reliability verification, bugs and remaining risks (if any).
- Deployment, migration, rollback and support instructions.

**START NOW:** Resolve repo roles; read the client scope and source; perform an accurate, reproducible audit; create the complete gap matrix and architecture; THEN build and test the Legacy Heights system in the new target repository through the phases above. Be meticulous, continue until the end-to-end required workflows are implemented and verified to the extent permitted by the environment, and always report unverified items without pretending they work.
