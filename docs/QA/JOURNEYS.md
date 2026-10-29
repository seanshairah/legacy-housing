# Journey evidence map

| Journey                | Local demonstration / verification                                                                                     | Limits                                                                               |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| J01 Discover/enquire   | Public site, date/floor/category room list; browser catalogue/mobile tests; persistent enquiry form                    | Real assets/contact/inventory pending                                                |
| J02 Register/verify    | Browser registration, hashed one-use challenges; password reset revokes sessions; staff MFA browser test               | Real email/mobile delivery unrun without credentials; no live recovery certification |
| J03 KYC                | Real encrypted PDF upload → ClamAV → property reviewer; malware and medical access tests                               | Client retention/legal basis and production managed storage approval pending         |
| J04 Reserve/waitlist   | Simultaneous reservation contention, shared beds, direct overlap rejection, expiry/recovery and waitlist advance tests | Client priority/TTL policy must be approved                                          |
| J05 Deposit            | Authoritative settlement service, replay/concurrent allocation, proof maker-checker, immutable receipt tests           | Real Paynow sandbox/method verification pending                                      |
| J06 Lease              | Versioned snapshot → scanned signed upload → reviewer execution, immutable DB trigger test                             | External e-sign provider and legal enforceability not asserted                       |
| J07 Resident live      | Domain full journey checks in and shows real portal data; demo script prepares synthetic local residency               | Production move-in policy sign-off pending                                           |
| J08 Bills/evidence     | Monthly billing idempotency, minor units, bank review, partial refunds/reversals, credit service                       | Live bank/merchant movement never simulated as real                                  |
| J09 Support            | Browser ticket creation; domain complaint, response, resolve, crossing denial; SLA scheduler                           | Manual escalation/on-call routing approval required                                  |
| J10 Renew/transfer     | Scoped request/review service, date overlap constraint, new agreement workflow; renewal/billing test                   | Real pricing/cancellation policies pending                                           |
| J11 Exit/deposit       | Notice, inspected checkout, turnover block, finance refund record                                                      | Bank refund and client disposition policy external                                   |
| J12 Reporting/exchange | Derived reports, scoped API/CSV adapters, expiring keys; cross-property export browser denial                          | Real ERP/SIS/PMS APIs and outbound synchronization not configured/verified           |
| J13 Resilience         | Audit-failure rollback, worker expiry, ClamAV failure closed, durable retries; encrypted restore drill                 | Production offsite restore, load targets and independent security assessment pending |

These are mixed domain/browser/manual checks, not a claim of complete browser E2E coverage for all thirteen journeys. Exact runner results and limitations live in RELEASE_EVIDENCE.
