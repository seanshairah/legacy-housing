# Permission model

Capabilities are checked at property and object scope in domain services; route visibility is supplementary. A dedicated Legacy database/storage isolates this client from other companies. A resident can read/change only their own permitted application, documents, account, lease or ticket. Medical access is excluded from standard KYC/finance/operations.

| Role | Capabilities |
|---|---|
| ADMIN | inventory, admissions, KYC, medical, finance, leasing, operations, reports, settings, audit for granted property |
| ADMISSIONS | applications, leases, check-in/out operations |
| FINANCE | financial posting and read |
| PROPERTY_MANAGER | inventory, operations, leases, operational reports |
| CARETAKER | property support operations only |
| KYC | standard document review only |
| MEDICAL_REVIEWER | medical documents only |
| AUDITOR | financial read, operational reports and audit read |
| Resident / Student | own object access, conditional academic fields |

Machine keys delegate only explicit read capabilities in one property, expire after 30 days, and cannot exceed current staff grants. Role revocation invalidates sessions; fresh live grants are read on every service call. Staff sign-in requires confirmed TOTP. The deployment administrator must restrict break-glass database access; application grants are not protection against a malicious database superuser.
