# Hosting cost model

Planning estimate dated 29 October 2026, in US dollars. These are transparent budgeting assumptions, not supplier quotations, selected vendors, agreed regions or a changed MIPF commercial offer. The quoted **US$100 annual private hosting price remains US$100 annually** unless the parties separately amend it. That price equals about US$8.33/month and must be distinguished from actual operating cost.

## Assumptions

One dedicated client deployment; Next web and worker; PostgreSQL; ClamAV; encrypted private files and offsite backups; basic monitoring; monthly email allowance; two paid SMS messages per resident per month. Synthetic workload assumptions are 10% peak concurrent users, roughly 20 MB of retained source files per resident before versions/backups, and three retained encrypted file copies for budgeting. These are capacity inputs to test, not measured production demand or approved legal retention.

SMS is estimated at US$0.05/message solely for sensitivity analysis. Replace with the actual contracted Zimbabwe route/sender/tax tariff. Compute/database/storage/email amounts below are assumed monthly budget allowances. Geography, exchange rates, provider minimums, VAT/tax, storage versions, retention, traffic and availability requirements can change every amount. No free tier is assumed as a permanent production entitlement.

| Monthly direct cost assumption                 | 100 residents | 250 residents | 500 residents | 1,000 residents |
| ---------------------------------------------- | ------------: | ------------: | ------------: | --------------: |
| Web/worker/scanner compute                     |         20.00 |         30.00 |         50.00 |           80.00 |
| PostgreSQL compute/storage                     |         15.00 |         25.00 |         40.00 |           70.00 |
| Private files and offsite backup allowance     |          5.00 |          8.00 |         12.00 |           20.00 |
| Monitoring/log allowance                       |          5.00 |          8.00 |         12.00 |           20.00 |
| Email allowance                                |          5.00 |          5.00 |          8.00 |           12.00 |
| SMS: residents × 2 × 0.05                      |         10.00 |         25.00 |         50.00 |          100.00 |
| Subtotal                                       |         60.00 |        101.00 |        172.00 |          302.00 |
| Planning contingency: subtotal × 20%           |         12.00 |         20.20 |         34.40 |           60.40 |
| **Estimated direct monthly cost**              |     **72.00** |    **121.20** |    **206.40** |      **362.40** |
| **Estimated direct annual cost: monthly × 12** |    **864.00** |  **1,454.40** |  **2,476.80** |    **4,348.80** |
| Quoted annual hosting price                    |        100.00 |        100.00 |        100.00 |          100.00 |
| **Annual direct-cost gap: estimate − quote**   |    **764.00** |  **1,354.40** |  **2,376.80** |    **4,248.80** |

The gap is a planning shortfall to resolve commercially, not an instruction to invoice the client more. Corelith must identify an explicit subsidy, shared-cost allocation, reduced service scope or separately approved price change. Shared infrastructure does not remove tenant-isolation, backup, messaging or support costs.

## Operational effort and exclusions

Assume 2/3/4/6 staff hours per month for 100/250/500/1,000 residents at an illustrative internal US$25/hour. This adds US$50/75/100/150 monthly, making total planning operations US$122/196.20/306.40/512.40 monthly and US$1,464/2,354.40/3,676.80/6,148.80 annually. Staff rates and service levels require agreement; this is not a support quote.

The model excludes development, independent penetration/accessibility testing, legal/DPO work, merchant transaction fees, external signature/KYC providers, payment disputes, premium support, dedicated disaster-recovery standby, cross-region replication, network egress over allowance, domain renewal and tax. Merchant fees should be modeled separately as verified transaction volume × contracted rate plus fixed per-transaction fees.

## Capacity and sensitivity checks

Initial sizing hypotheses are 2 vCPU/4 GB, 2 vCPU/8 GB, 4 vCPU/8–16 GB and 4–8 vCPU/16 GB across the four resident counts, shared among application/worker/scanner as approved by load tests. PostgreSQL/backup resources need their own budget. ClamAV and scrypt create real memory/CPU pressure; do not choose a tiny host from student count alone. Validate scanner peaks, concurrent authentication, database connection limits, monthly billing batches and export duration.

Raw file storage under the 20 MB assumption is approximately 2/5/10/20 GB; three copies total approximately 6/15/30/60 GB before extra versions, snapshots, databases and logs. If average files double, the variable storage component doubles. Each additional SMS per resident per month adds US$5/12.50/25/50 at the assumed tariff. High availability and a tested shorter RPO/RTO need additional priced resources.

Before approval, obtain actual quotes in approved regions, measure representative peak/large-data load, confirm service/support objectives and compute total annual cost including contingency. Record the chosen design and commercial decision without silently rewriting the US$100 annual proposal.
