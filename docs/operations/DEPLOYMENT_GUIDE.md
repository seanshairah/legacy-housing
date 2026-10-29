# Deployment guide

This repository provides an application/container and local development stack. Production deployment is a separate approved operation. No real client database, public host, TLS certificate, region or external provider activation has been established by these instructions.

## Required deployment record

Before processing real records, the operator and MIPF must record the application commit/image digest, database/storage/backup regions, legal entity and public domain, controller/processor contacts, approved subprocessors, encryption/key versions, retention policies, merchant/sender configuration, monitoring ownership and tested recovery objectives. Use [DATA_FLOW_REGISTER.md](../compliance/DATA_FLOW_REGISTER.md) and [MIPF_TECHNICAL_READINESS.md](../MIPF_TECHNICAL_READINESS.md).

Select either a dedicated client deployment with isolated database/storage/secrets or a demonstrably enforced shared-tenant deployment. A configured organisation ID is insufficient by itself. Shared mode must pass application, SQL RLS, worker, webhook, export and credential-isolation tests using the actual runtime database role. Database owner/superuser credentials bypass PostgreSQL RLS and must not be the production web role.

## Reproducible development workflow

Use the existing `/workspace/legacy-housing` checkout and Node 24. Do not create a worktree unless requested. The original `Student-housing-management-` and `ivyhouse-student-management` repositories are read-only references; no deployment, migration or seed command may target them or their databases.

From the target checkout:

```bash
./scripts/setup-local.sh
npm run typecheck
npm run lint
npm run format:check
DATABASE_URL=postgresql://postgres@127.0.0.1:5432/legacy_test npm test
npm run build
```

The setup script preserves local keys/data and creates only dedicated Legacy databases. Tests must use a disposable loopback `legacy_test` database or an explicitly guarded `legacy_test_*` database. Keep background-worker browser tests separate from domain-test databases to prevent fixture races. Test provider transport fixtures are allowed only under the guarded test configuration; they must not be imported by production startup.

Start web and worker as separate supervised processes. Local commands are `npm run dev -- --port 3001` and `npm run worker`. `/api/health` must return `ok:true,database:up`; verify public catalogue, authenticated portal and actual scan/delivery behavior as well. Never infer readiness from a process ID or port alone.

## Build and release

1. Record `git rev-parse HEAD`, branch and clean/expected working-tree state. Complete frozen dependency installation, migrations on a fresh disposable database, types/lint/format, security scans, unit/integration tests, production browser journeys and production build. Review exact results and skips for the candidate revision.
2. Build `infra/Dockerfile` through approved registry/proxy/CA routes. On the cloud machine `node --import tsx scripts/build-cloud.ts` preserves the platform proxy route. Do not disable TLS or checksum checks. Record the resulting immutable image digest and dependency scan.
3. Back up existing production data and validate its recoverability before a schema change. Quiesce sensitive writes when database/file snapshot consistency requires it. Use a distinct migration credential and `npm run db:deploy`; do not use `db push`, `migrate reset` or development seed in production.
4. Deploy the candidate web and worker image with private database/scanner/file networks. Persist private-file and database volumes. Give the web/worker only required runtime permissions; migrations and restore use separate credentials. Complete tenant-role checks after applying grants.
5. Terminate TLS at the approved ingress. `infra/Caddyfile` is an example, not a running provisioned certificate service. Set `APP_URL` to the exact public HTTPS origin; trust only the selected ingress and reject untrusted forwarded hosts/protocols. Verify form redirects remain HTTPS, cookies are Secure/HttpOnly/Strict and CSP/HSTS/nosniff/frame protections are present.
6. Verify authenticated health, catalogue, role-isolated reads, synthetic upload/quarantine/scan, disposable booking and payment sandbox workflows, scheduler/worker retries and backup age. Delete or isolate acceptance fixtures according to approved procedure; never delete posted real evidence to hide test activity.
7. Open real processing only after the release owner records acceptance and outstanding external dependencies are resolved. Keep rollback assets and reconciliation checkpoints available.

The checked-in Compose definition is a local reference stack. Its database owner/runtime connection and startup migration behavior require hardening before production; do not expose its database or scanner ports publicly. The web port binds loopback. Do not run `docker compose down -v` on retained data.

## Configuration and secrets

| Setting                          | Production requirement                                                                                                                 |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| DATABASE_URL                     | Dedicated runtime role, private endpoint, TLS where transport leaves a trusted host; bounded pool and host-specific connection budget  |
| APP_URL                          | Exact approved HTTPS origin, used for CSRF and redirects                                                                               |
| DATA_KEY / FILE_KEY / BACKUP_KEY | Independent random 32-byte keys in a managed secret store; separately escrow version history; no source-controlled values              |
| STORAGE_ROOT                     | Private persistent encrypted volume or tested private object adapter; no public webroot; access restricted to runtime/backup operators |
| CLAMAV_HOST / PORT               | Private scanner connection, current signatures, health/age monitoring and resource limits                                              |
| LOCAL_DEMO                       | `false`; create a clean production database and factual unpublished catalogue instead of promoting synthetic records                   |
| Provider settings                | Activate only after approved merchant/sender contracts and real sandbox tests; see integration requirements                            |
| Retention execution              | Disabled until approved versioned policy, legal holds, independent approval and controlled execution are verified                      |

The initial scoped administrator must be an already registered user with verified contacts and confirmed MFA. `scripts/bootstrap.ts` creates only the first unpublished property and administrator grant, rejects a second bootstrap, and expects approved property/legal-entity JSON. Supply factual values through a controlled operator invocation; never manufacture client identities, prices or legal text.

## Monitoring and rollback

Monitor web errors/latency, database saturation, scheduler progress, oldest outbox/scan age, dead jobs, scanner signature age, backup age, free disk and integrity alerts. Configure actual alert destinations and named responders. Log correlation IDs and bounded outcome codes; exclude credentials, raw recovery codes, document bodies and full provider payloads.

Rollback must match schema compatibility. For compatible changes restore the prior immutable application image and verify worker compatibility. For incompatible changes stop writes, restore database and private files together to an approved recovery point, redeploy the matching image, reconcile gateway/bank events since that point, and reopen only after invariants pass. An image rollback alone cannot reverse posted money or schema changes.

GitHub branch protection, protected production environments and deployment credentials must be configured in GitHub by the repository operator. The current verification workflow does not itself publish or deploy a production site. Weekly scheduled jobs only run from the default branch once merged and enabled.

Trusted platform bootstrap: `node --env-file=.env --import tsx scripts/bootstrap-platform.ts <verified-operator-email>` creates only the first explicit PlatformGrant, audits it and revokes prior sessions. It requires an active verified MFA account and trusted terminal/database authorization; it grants no tenant personal-data access. Organisation administration on newly provisioned providers requires an explicit ADMIN organisation membership, independently of property ADMIN grants. The all-properties compatibility rule is limited to the original MIPF deployment.
