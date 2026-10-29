# Permission model

Capabilities are checked at property and object scope in domain services; route visibility is supplementary. Organisation owns Property, and organisation membership/configuration is managed separately from property personal-data permissions. A dedicated Legacy database/storage remains the current deployment boundary while complete shared-client runtime enforcement is unfinished. A resident can read/change only their own permitted application, documents, account, lease or ticket. Medical access is excluded from standard KYC/finance/operations.

| Role                | Capabilities                                                                                                     |
| ------------------- | ---------------------------------------------------------------------------------------------------------------- |
| ADMIN               | inventory, admissions, KYC, medical, finance, leasing, operations, reports, settings, audit for granted property |
| ADMISSIONS          | applications, leases, check-in/out operations                                                                    |
| FINANCE             | financial posting and read                                                                                       |
| PROPERTY_MANAGER    | inventory, operations, leases, operational reports                                                               |
| CARETAKER           | property support operations only                                                                                 |
| MAINTENANCE_OFFICER | property support operations only                                                                                 |
| LEASING_OFFICER     | leasing for explicitly granted property                                                                          |
| FINANCE_APPROVER    | financial posting/read with workflow maker-checker; currently same capability set as FINANCE                     |
| PLATFORM_OPERATOR   | no personal-data capability; explicit separate PlatformGrant can provision organisation metadata                 |
| KYC                 | standard document review only                                                                                    |
| MEDICAL_REVIEWER    | medical documents only                                                                                           |
| AUDITOR             | financial read, operational reports and audit read                                                               |
| Resident / Student  | own object access, conditional academic fields                                                                   |

Machine keys delegate only explicit read capabilities in one property, expire after 30 days, and cannot exceed current staff grants. Sensitive grant changes invalidate sessions; fresh live grants are read on every service call. Staff/organisation-admin/platform-operator sign-in and session use require confirmed MFA. Hashed one-use recovery codes permit deliberate password-plus-code authenticator recovery, revoke existing sessions and require staff reenrollment; they do not create a bypass staff session.

Organisation administration requires an explicit organisation ADMIN grant or the backward-compatible administrator grant for every property in that organisation. It never automatically grants all property capabilities. PlatformGrant authorizes provisioning/configuration metadata, not KYC, medical, finances or resident records. Property role PLATFORM_OPERATOR carries no capabilities. Global identity/control-plane signals require separate explicit authority; a partial property grant cannot view them.

`withTenant` verifies membership, sets transaction-local organisation/user settings and switches to the static NOLOGIN/NOBYPASSRLS `legacy_tenant` role. SQL policies follow the property-owned graph, and relational guards prevent cross-property foreign-key laundering. Context/role reset at transaction completion avoids pooled connection leakage. This helper does not automatically scope the existing database-owner/control-plane callers; full shared production mode remains blocked until every route/service/job/webhook/provider path is integrated and tested. Production web credentials must be least-privileged and cannot be database owner/superuser credentials that bypass RLS.

The module capabilities are narrower than broad role-only authorization but do not implement an independently configurable permission for every individual action. Approval-only refund policies require further explicit capability mapping if selected. The deployment administrator must restrict break-glass database access; application grants are not protection against a malicious database superuser. Detailed role/object cases and current test evidence are in [ACCESS_CONTROL_MATRIX.md](../security/ACCESS_CONTROL_MATRIX.md).
