# Domain model

```mermaid
erDiagram
 User ||--o{ Membership : scopes
 Property ||--o{ Building : contains
 Building ||--o{ Floor : contains
 Floor ||--o{ Room : contains
 Room ||--o{ Bed : contains
 Bed ||--o{ Reservation : dates
 User ||--o{ Application : submits
 Application ||--o{ Document : evidence
 Application ||--o| Lease : concludes
 User ||--o{ Charge : owes
 Payment ||--o{ Allocation : settles
 Charge ||--o{ Allocation : receives
 Payment ||--o| Receipt : evidences
 Property ||--o{ Ticket : services
```

All sensitive domain changes produce AuditEvent and OutboxEvent in the same transaction. Roles grant capabilities within a property; resident ownership is checked separately. Executed lease evidence and financial postings use restrictive relations and immutable-record triggers. Reservation states HOLD→CONFIRMED→ACTIVE→ENDED; expiry/cancel release inventory, maintenance blocks overlap. Application, KYC, payment and lease states remain separate.
