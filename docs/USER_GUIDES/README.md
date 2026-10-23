# Role guides

All screenshots, when present, use synthetic local records. See screenshots/ for captures from the functioning local build.

## Resident / student

Register with a strong password; students add their institution, private tenants do not. Verify both email and mobile using configured provider codes. Use MFA if desired. Browse the accessible room list by property, dates, floor and category. Reserve one available bed after reading the application policy; holds expire. Upload identity/residence and student registration evidence where required. Files stay quarantined until scanned; rejection reasons support resubmission. Medical files have narrower staff access.

Track status and next actions in My home. After approval, pay the issued deposit through a configured gateway or upload bank proof and submit its reference; proof is not settlement. Download issued invoices, verified receipts and your account statement. Apply verified available credit to later invoices where offered. Read your agreement online or download it. If the issued template includes an approved electronic-signing disclosure, enroll an authenticator, open the electronic review, check the exact terms/disclosure, enter your matching full name and current code, confirm intent and sign. The review expires after ten minutes and cannot be reused. Alternatively upload its signed copy and submit for review. Download the exact scanned signed copy from the lease card. Staff approve execution and check-in separately. Keep emergency contacts current. Create maintenance, complaint, compliment or support tickets and follow responses. Upload support files, wait for a clean scan, then attach them to a ticket reply. Request renewal/transfer with the target bed and dates; approval requires clear arrears and fresh availability. Give exit notice; checkout/inspection and deposit disposition require staff approval. Revoke sessions, update notification preferences or submit a privacy request under Profile & security.

## Admissions / front desk

Enroll MFA before staff sign-in. Select your property; other properties remain denied. Review application history and required KYC approvals. Approval requires a live bed hold and verified required documents. Expired holds must be reselected safely. Decline with a reason. Deposits and signing remain separate from admission approval. Use the waitlist priority command only under approved priority policy and record a reason.

## KYC / leasing

Download only files authorized for your role/property. A clean scan is required before review; record approval/rejection and reasons. Standard KYC does not grant medical access. If scanning has exhausted its retries after an outage, authorized reviewers may retry it after the scanner recovers; failed files remain inaccessible. Issue the latest legally approved template after deposit confirmation. If signing evidence is incomplete, use Return for a new signature and record the reason; the resident can submit a new scanned version. Rejected evidence cannot execute. Verify the exact scanned signed copy and resident identity, record execution review, and preserve immutable hash/version/time evidence. Never edit executed terms; renewals/transfers produce new agreements.

## Finance

Use the collections/debtors/reconciliation panel and CSV to compare net verified funds, allocations, unused credit, receipts and exceptions; report cohorts and correction dates are stated on screen. Use real charge references and correct currency; recurring billing uses a stable reservation/month key. Check derived balances, open invoices and unallocated credit. Verify bank evidence against the actual bank source; reject mismatches. Staff can record actual cash tenders against a unique voucher reference, which still require independent review when maker-checker applies. Makers cannot approve their own proof proposal when maker-checker is enabled. Settlement posts allocations and receipt atomically. Download receipts; retain corrections through credits/refunds/reversals. A refund command records an externally verified transfer; it does not move money. Use scoped accounting CSV exports and reconcile their receiving-system mappings. Never delete financial records.

## Property operations / caretaker

Manage bed blocks and turnover only with your granted permissions; committed inventory cannot be casually blocked. Check-in requires an executed agreement, confirmed reservation, required deposit and emergency contacts. Checkout captures inspection and blocks the bed for turnover. Resolve the maintenance block explicitly after inspection. Assign tickets only to authorized property staff, record first response and resolution, and respond to SLA escalations. Upload support attachments and wait for a clean scan before including them in a response. The ticket owner can download attached staff files. Another property's ticket ID does not grant access.

## Executive / auditor

Use property reports with definitions and actual denominators. Occupancy counts checked-in residents; unoccupied capacity is not a date-specific availability claim. Finance exports require separate finance-read permission. The read-only audit view preserves actor, time, object and trace reference. CSV and API pagination must be followed; one page is not the full ledger.

## System administrator

Review security signals in the property security workspace; client-wide administrators can also review global authentication signals. Investigate high-severity alerts, acknowledge/resolve with a reason and preserve audit evidence. Grant minimum scoped roles only after the user enrolls MFA. Revoke access promptly; check audit records. Add verified property inventory and approved template versions. Use integration local connection checks with their stated limits. Create expiring scoped read-only keys; copy them once into the receiving system's secure store and revoke old ones. Never paste private records or keys into support chats. Follow RUNBOOK for backups, restore, failures, security response and production gates.

Practical role-based exercises and operator acceptance are in [TRAINING.md](TRAINING.md). New synthetic captures show electronic review and security monitoring. No live training session or ongoing staffed support is implied by these materials.
