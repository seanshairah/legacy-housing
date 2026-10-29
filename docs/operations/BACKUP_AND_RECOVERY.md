# Backup and recovery

Implementation: `scripts/backup.ts`, `compose.yaml` backup service, and authenticated encryption in `src/lib/security.ts`. Historical local evidence is in [RELEASE_EVIDENCE.md](../QA/RELEASE_EVIDENCE.md); current-candidate execution belongs in [TEST_EVIDENCE.md](../testing/TEST_EVIDENCE.md). Local restore success does not establish production disaster recovery.

## Backup contents and controls

The version-2 backup command uses PostgreSQL `pg_dump -Fc --no-owner --snapshot`, packs the dump and referenced private encrypted file bytes with SHA-256 integrity values, and includes a document plaintext-hash/size manifest plus canonical count/content fingerprints for every public table. The entire bundle is encrypted with independent AES-256-GCM BACKUP_KEY. Local directories use mode 0700 and new bundles mode 0600. The database name must be a dedicated `legacy_*` database. PostgreSQL 16 client tools are included in the application image to match the database major version.

Preserve DATA_KEY, FILE_KEY and BACKUP_KEY versions outside the backup destination under separate controlled escrow. DATA_KEY protects MFA/delivery/configuration secrets; FILE_KEY protects document bytes; BACKUP_KEY protects the bundle. Possessing only the bundle is insufficient to recover encrypted records. Replacing a key without controlled re-encryption makes prior data unreadable.

The backup acquires a shared session advisory lock before opening its repeatable-read/exported snapshot. Private-file deletion uses the matching exclusive transaction lock across unlink and tombstone commit. Uploads may continue: only live references visible in the exported snapshot are bundled. DELETION_PENDING/DELETED payloads are excluded while their metadata remains. Every bundled plaintext is decrypted and checked against the snapshot's document hash and byte count. Acquiring the coordination lock before the snapshot prevents waiting on a deletion and then reading an older reference to an already removed blob.

All private-file deletion paths must retain this coordination contract. An external storage lifecycle task that unlinks bytes outside it requires separate snapshot integration or a quiesced backup window. A manual operator filesystem change can still break recoverability; missing referenced bytes cause backup failure. The current in-memory bundle and five-minute snapshot timeout require scale testing for the chosen document volume.

## Create and protect a bundle

From the target checkout with authorized dedicated database credentials and retained local key configuration:

```bash
npm run backup
```

On this cloud development machine, matching tools can run inside its existing database container:

```bash
BACKUP_DOCKER_CONTAINER=housing-onboarding-db npm run backup
```

This command is for dedicated Legacy databases only. It must not read the original housing application databases. Protect the output path; do not attach bundles to issues or publish them as CI artifacts.

The Compose backup process repeats every 86400 seconds and exits on failure. Monitor its exit state and last successful bundle age. It writes only local retained volume storage; configure encrypted offsite/versioned or immutable copies and verify their retrieval separately. Snapshot retention, object-lock duration and storage jurisdiction require client/operator approval.

## Restore drill

Use a nonproduction machine/network and a new destination. The current helper creates a new `legacy_restore_<timestamp>` database and isolated local file directory; it does not overwrite the running database:

```bash
node --env-file=.env --import tsx scripts/backup.ts --restore-drill /protected/path/legacy-bundle.enc
```

For the cloud Docker tool route, also set `BACKUP_DOCKER_CONTAINER=housing-onboarding-db`. Retain the restored database and evidence until the reviewer finishes. Never connect restored notification/payment workers to real providers during a drill.

Record and verify:

1. Source commit/image, dump start/completion times, encrypted bundle hash/size, storage origin, file count and key versions; never record the keys themselves.
2. Authentication failure for a tampered bundle/wrong key and integrity rejection for a corrupt dump/file or incomplete manifest. Version 2 validates these before creating the restored database. Recovery must stop rather than produce a partly trusted live system.
3. All schema/migration versions, per-table count/content fingerprints, organisation/property relationships and expected indexes/triggers/policies/roles. Version-2 restore compares all public-table fingerprints and the exact live document manifest; version-1 bundles remain readable but do not receive this complete verification.
4. Charge/payment/allocation/credit/refund/reversal totals, unique receipts, outstanding balances, reservation exclusions and immutable agreement/audit evidence.
5. Every retained private-file reference, restored ciphertext integrity and plaintext hash after decryption with the correct file key; missing/unexpected references require investigation.
6. Authenticated application startup with providers disabled, correct tenant/role boundaries, readable authorized documents and denied foreign access.
7. Elapsed recovery time from retrieval through application validation, the age of the recovered source point and work required to reconcile events after that point.

## Objectives and production acceptance

| Measure                  | Current evidence                                                        | Production decision                                                                                                                                                     |
| ------------------------ | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backup interval          | Local Compose configuration: 24 hours                                   | Approve interval based on acceptable loss; add WAL/PITR if a shorter RPO is required                                                                                    |
| RPO                      | No production objective has been approved or measured                   | Define maximum data loss, including private files and payment events; daily cadence alone can imply up to a day's loss plus a failed/late backup window                 |
| RTO                      | Historical local restore phase was measured at 474 ms on a tiny fixture | Define full recovery target covering offsite retrieval, key access, infrastructure recreation, restore, tests and reconciliation; local restore time is not that target |
| Fresh-host/offsite drill | Unverified                                                              | Retrieve the approved offsite copy on a separate host, restore all components, reconcile and obtain operator sign-off                                                   |
| Key-loss recovery        | Escrow/version requirements documented                                  | Demonstrate independent authorized key retrieval without depending on the failed host                                                                                   |

The 29 October synthetic regression `scripts/verify-recovery.ts` executed a fresh local source/restore pair, matched 50 public tables and three private-PDF plaintext hashes, preserved restored ledger/lease/audit invariants, rejected eight corruption/immutability cases and proved backup waits for an exclusive deletion before taking its snapshot. The recorded restore phase was 633 ms and restore-plus-acceptance 691 ms for that small fixture. See the current test evidence for exact revision/commands; these local timings are not a production RTO.

After real data deletion, backup copies remain subject to the approved retention schedule and recovery procedures. Retain a deletion ledger outside ordinary restored application history where necessary, and reapply completed deletion/hold decisions before exposing restored records. File unlink is not proof of erasure from snapshots, SSD media or provider copies.
