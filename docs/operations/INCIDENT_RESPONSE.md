# Incident response

This playbook supports application operations and evidence preservation. MIPF/Corelith must name the incident commander, technical responders, data-protection contact, finance owner, hosting/provider contacts and approved communication routes before launch. No response time or regulatory notification deadline is invented here; the responsible legal/data-protection function must confirm applicable duties.

## Detection and triage

Application security alerts record pseudonymous subject hashes, type, property/global scope, severity, occurrence count and review evidence. Repeated authentication/rate-limit/access failures escalate; malware and exhausted scans escalate immediately. Property reviewers require the appropriate audit/settings capability; global signals require explicit wider authority. Opening an alert or changing its state is not evidence the incident is resolved.

Also monitor infrastructure alerts, provider callbacks, financial reconciliation exceptions, overlap/integrity failures, queue age, scanner health/signature age, database/disk capacity and backup freshness. Application alerts are not a replacement for host/network detection or a staffed on-call service.

Record an incident reference, first observed UTC time, affected organisation/property and assets, detection source, known exposure window, severity, responder identity and correlation IDs. Keep document contents, passwords, raw tokens, keys and full merchant payloads out of tickets and general logs.

## Containment by incident type

| Trigger                           | Immediate authorized technical action                                                                                                          | Preserve / verify                                                                                                    |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Stolen session/account            | Disable affected user if necessary, revoke all sessions and delegated keys, remove compromised grants; require verified recovery and fresh MFA | Authentication, grant and access audit window; confirm revoked-session/key requests fail                             |
| Credential/merchant key exposure  | Disable affected integration, restrict egress where appropriate, rotate through secure settings and provider console                           | Key version/activation times, intent references, pending callbacks; reconcile before retry                           |
| Cross-tenant/object disclosure    | Stop affected endpoint/processing or isolate deployment, contain grants, preserve evidence                                                     | Exact candidate image/schema/role/context; reproduce with synthetic accounts before reopening                        |
| Financial invariant failure       | Freeze sensitive postings/allocations; continue only approved read access                                                                      | Original charge/payment/receipt/allocation/reversal records; no deletion or silent rewriting to make totals match    |
| Forged/replayed webhook           | Keep settlement dependent on signed authoritative poll; isolate compromised endpoint/key if required                                           | Bounded signature/result hashes and references; unique inbox/receipt evidence                                        |
| Malicious file/scanner outage     | Keep quarantine closed, restrict download, restore scanner/validation service, retry only under authorized procedure                           | Hash, scan state/result/attempts and audit; do not distribute sample bytes through ordinary support channels         |
| Infrastructure/storage compromise | Isolate host/network, preserve forensic snapshots under controlled access, revoke host secrets, prepare clean-host recovery                    | Logs, immutable backup copies, key versions and chain of custody; never reuse an untrusted host as recovery evidence |
| Queue/backup failure              | Restore dependency, inspect dead jobs and oldest age; retry only the correct scoped jobs                                                       | Idempotency keys/delivery outcomes; latest successful retrievable backup and health                                  |

Break-glass access must be explicitly approved, narrowly scoped, time-limited and audited. A Corelith operator role is not permission to browse MIPF identity or medical records. Avoid broad SQL exports; use the smallest necessary evidence set.

## Recovery and reopening

1. Correct the cause in a reviewable branch and preserve the affected revision/image. Add a failing regression that reproduces the issue and execute the fix.
2. Rebuild from trusted dependencies and deployment secrets. If infrastructure was compromised, recreate a clean host and restore a verified approved recovery point.
3. Reconcile gateway/bank events and irreversible postings after the restore point. Preserve original evidence and append corrections. Reapply approved deletion/hold decisions before restored private data becomes available.
4. Execute health, role/tenant/object, upload/scanning, queue, booking, ledger and restore-integrity checks for the affected areas. Verify external providers in their approved sandbox before resuming live operations.
5. Obtain the release/incident owner's reopening decision and document residual risk, provider/client notifications and monitoring window.

## Communication and follow-up

The designated incident owner coordinates approved notices to MIPF, Corelith, providers, affected persons or regulators. Do not send messages automatically without an authorized communication decision. Technical containment can proceed within the responder's existing grant while legal/contractual notifications are assessed.

Complete a post-incident record with timeline, root cause, confirmed affected data/accounts, containment/recovery actions, test evidence, necessary notifications, corrective owner/deadline and verification of closure. Review grants, secret rotation, retention, restore objectives and monitoring coverage. Keep sensitive incident evidence under the approved incident retention/legal-hold policy.
