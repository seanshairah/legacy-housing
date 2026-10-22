# Verified source findings

Static evidence, not an executed exploit or concurrency proof. Owner of target remediation: implementation team.

| Classification                | Risk   | Source evidence                                     | Impact / verification                                                                                                                  |
| ----------------------------- | ------ | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Confirmed missing             | High   | prisma/schema.prisma:16; src/core/auth/access.ts:22 | Three broad roles; implement role/property/object authorization and crossing tests (LH-A,J,3).                                         |
| Confirmed missing             | High   | schema:161; src/lib/auth.ts:49                      | No MFA/session revocation/contact verification; test credential reset revokes sessions (LH-A).                                         |
| Confirmed unsafe              | High   | src/app/caretaker/actions.ts:38                     | Ticket updated by id without property/assignment filter; test ID substitution (LH-H).                                                  |
| Confirmed missing             | High   | schema:262,320                                      | Documents are string placeholders; medical text not isolated. Build private quarantine/review (LH-D).                                  |
| Confirmed missing             | High   | schema:252                                          | Lease dates are not a signed document/evidence model (LH-G).                                                                           |
| Confirmed mismatch            | High   | src/services/applications/index.ts:73,82            | Whole room held for one applicant; bed-level model required (LH-B).                                                                    |
| Risk to reproduce             | High   | applications/index.ts:69,82                         | Read then unconditional update does not prove concurrent safety. PostgreSQL exclusion constraints and contention tests required.       |
| Confirmed unsafe              | High   | applications/index.ts:326,528,537                   | Temporary passwords passed to email/SMS. Use single-use invitations (LH-A).                                                            |
| Confirmed unsafe rendering    | High   | src/services/documents/index.ts:59,64,94,153        | DB text interpolated into HTML; escape and test hostile strings (LH-E).                                                                |
| Confirmed missing durability  | High   | src/services/audit.ts:25; payments/index.ts:1086    | Critical audit after commit, errors caught. Same-transaction audit/outbox required (LH-3).                                             |
| Confirmed gap                 | High   | payments/index.ts:659,719,856                       | PAID early return prevents later refund polling (LH-E).                                                                                |
| Confirmed mismatch            | Medium | src/core/billing/ledger.ts:108,341                  | JS number conversions despite Decimal DB. Use minor-unit BigInt (LH-E,F).                                                              |
| Risk to reproduce             | High   | ledger.ts:417,449,456                               | Two payments may allocate same remaining charge concurrently. Account row lock and aggregate invariant tests required.                 |
| Partially implemented         | Medium | schema:522; notifications/index.ts:16               | Ticket and notification bases exist, but no durable queue, SLA history, complaints workflow (LH-H,4).                                  |
| Requires external integration | High   | Client scope                                        | Merchant sandbox, real messaging, legal sign-off, branding, inventory and data retention require client input. Never label mocks live. |
