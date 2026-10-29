import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import { PDFDocument } from "pdf-lib";
import { backup, restoreDrill, run } from "./backup";
import { db } from "../src/lib/db";
import { decrypt, encrypt, hash } from "../src/lib/security";
import { upload, scanDocument } from "../src/domain/documents";
import {
  issueCharge,
  proposePayment,
  reviewProof,
  account,
  applyAvailableCredit,
  creditCharge,
  refund,
} from "../src/domain/finance";
import {
  proposeRetentionPolicy,
  approveRetentionPolicy,
  requestDocumentDeletion,
  approveDocumentDeletion,
  executeDocumentDeletion,
} from "../src/domain/retention";
import {
  issueLease,
  submitSignedLease,
  executeLease,
} from "../src/domain/leases";

// Reproducible destructive-fault drills are allowed ONLY against a fresh,
// dedicated loopback synthetic database. Never reset, reuse or overwrite one.
const url = new URL(process.env.DATABASE_URL || "");
if (
  !["localhost", "127.0.0.1"].includes(url.hostname) ||
  !/^\/legacy_test_recovery(?:_[a-z0-9]+)*$/.test(url.pathname)
)
  throw new Error("FRESH_LOOPBACK_RECOVERY_TEST_DATABASE_REQUIRED");
const database = url.pathname.slice(1);
for (const name of ["DATA_KEY", "FILE_KEY", "BACKUP_KEY"])
  if (!/^[a-f0-9]{64}$/i.test(process.env[name] || ""))
    throw new Error(`${name}_REQUIRED`);
const runId = randomUUID();
process.env.STORAGE_ROOT = resolve(".data", `recovery-fixture-${runId}`);
await mkdir(process.env.STORAGE_ROOT, { recursive: true, mode: 0o700 });
const pgEnv: NodeJS.ProcessEnv = {
  ...process.env,
  PGHOST: url.hostname,
  PGPORT: url.port || "5432",
  PGUSER: decodeURIComponent(url.username),
  PGPASSWORD: decodeURIComponent(url.password),
};
async function pg(tool: string, args: string[]) {
  return process.env.BACKUP_DOCKER_CONTAINER
    ? run("docker", [
        "exec",
        "-i",
        process.env.BACKUP_DOCKER_CONTAINER,
        tool,
        "-U",
        "postgres",
        ...args,
      ])
    : run(tool, args, undefined, pgEnv);
}
await pg("createdb", [database]); // Existing database => refusal, never reset.
await run("npm", ["run", "db:deploy"]);
const started = Date.now();
let restored: PrismaClient | undefined;
try {
  const property = await db.property.create({
    data: {
      name: "SYNTHETIC RECOVERY PROPERTY",
      slug: `recovery-${runId}`,
      description: "Disposable recovery validation only",
      location: "Loopback local",
      published: true,
      depositMinor: 0n,
    },
  });
  const [finance, checker, resident] = await Promise.all(
    ["FINANCE", "ADMIN", "RESIDENT"].map((role, n) =>
      db.user.create({
        data: {
          name: `Synthetic ${role}`,
          email: `${role}-${runId}@example.invalid`,
          phone: `+990${Date.now()}${n}`,
          passwordHash: "not-a-login-fixture",
          emailVerifiedAt: new Date(),
          phoneVerifiedAt: new Date(),
        },
      }),
    ),
  );
  await db.membership.createMany({
    data: [
      { propertyId: property.id, userId: finance.id, role: "FINANCE" },
      { propertyId: property.id, userId: checker.id, role: "ADMIN" },
      { propertyId: property.id, userId: finance.id, role: "ADMIN" },
    ],
  });
  const building = await db.building.create({
    data: { propertyId: property.id, name: "Synthetic block" },
  });
  const floor = await db.floor.create({
    data: { buildingId: building.id, name: "Ground", level: 0 },
  });
  const room = await db.room.create({
    data: {
      floorId: floor.id,
      name: "R1",
      category: "SINGLE",
      monthlyMinor: 0n,
      beds: { create: { label: "A" } },
    },
    include: { beds: true },
  });
  const application = await db.application.create({
    data: {
      userId: resident.id,
      propertyId: property.id,
      status: "LEASE_SIGNING_PENDING",
    },
  });
  await db.reservation.create({
    data: {
      userId: resident.id,
      propertyId: property.id,
      applicationId: application.id,
      bedId: room.beds[0].id,
      state: "CONFIRMED",
      startAt: new Date(),
      endAt: new Date(Date.now() + 90 * 86400000),
    },
  });
  const template = await db.leaseTemplate.create({
    data: {
      propertyId: property.id,
      version: 1,
      title: "SYNTHETIC RECOVERY TERMS",
      body: "SYNTHETIC NON-OPERATIVE AGREEMENT FOR RECOVERY VALIDATION ONLY.",
      hash: hash("recovery terms"),
      approvedAt: new Date(),
      approvedBy: checker.id,
    },
  });
  const lease = await issueLease(checker, application.id, template.id);
  const pdf = await PDFDocument.create();
  pdf.addPage().drawText("SYNTHETIC RECOVERY DOCUMENT - NO PERSONAL DATA", {
    x: 30,
    y: 700,
    size: 10,
  });
  const plain = Buffer.from(await pdf.save());
  const historical = await db.application.create({
    data: {
      propertyId: property.id,
      userId: resident.id,
      status: "WITHDRAWN",
      updatedAt: new Date(Date.now() - 3 * 86400000),
    },
  });
  const docs: Awaited<ReturnType<typeof upload>>[] = [];
  for (const kind of ["SIGNED_LEASE", "IDENTITY", "MEDICAL", "SUPPORT"]) {
    const document = await upload(resident, {
      propertyId: property.id,
      applicationId: kind === "SUPPORT" ? historical.id : application.id,
      kind,
      filename: `synthetic-${kind}.pdf`,
      bytes: plain,
      medicalConsent: kind === "MEDICAL",
    });
    await scanDocument(document.id);
    assert.equal(
      (await db.document.findUniqueOrThrow({ where: { id: document.id } }))
        .state,
      "CLEAN",
    );
    docs.push(document);
  }
  await submitSignedLease(resident, lease.id, docs[0].id, true);
  await executeLease(
    checker,
    lease.id,
    "Synthetic independent verification of recovery agreement",
  );
  await issueCharge(finance, {
    propertyId: property.id,
    userId: resident.id,
    reference: `INV-${runId}`,
    category: "RENT",
    description: "Synthetic recovery rent",
    amount: "100.25",
    dueAt: new Date(),
  });
  const payments = [];
  for (const amount of ["40.00", "80.00"]) {
    const p = await proposePayment(finance, {
      propertyId: property.id,
      userId: resident.id,
      amount,
      method: "CASH",
      bankReference: `TEST-${randomUUID()}`,
      idempotencyKey: randomUUID(),
    });
    await reviewProof(
      checker,
      p.id,
      "APPROVE",
      "Synthetic independent voucher check; no real funds",
    );
    payments.push(p);
  }
  const utilities = await issueCharge(finance, {
    propertyId: property.id,
    userId: resident.id,
    reference: `UTL-${runId}`,
    category: "UTILITIES",
    description: "Synthetic recovery utilities",
    amount: "25.00",
    dueAt: new Date(),
  });
  await applyAvailableCredit(resident, resident.id, property.id);
  await creditCharge(
    finance,
    utilities.id,
    "2.25",
    "Synthetic correction for restore validation",
    `CR-${runId}`,
  );
  await refund(
    finance,
    payments[1].id,
    "20.00",
    "Synthetic externally verified reversal for recovery",
    `REF-${runId}`,
  );
  const balance = await account(resident.id, property.id);
  assert.equal(balance.outstanding, 2300n);
  assert.equal(balance.credit, 0n);

  // Approve a synthetic retention policy and an eligible historical document.
  // The test advances only its own synthetic document's retention clock.
  await db.document.update({
    where: { id: docs[3].id },
    data: { createdAt: new Date(Date.now() - 3 * 86400000) },
  });
  const policy = await proposeRetentionPolicy(checker, {
    propertyId: property.id,
    kind: "SUPPORT",
    retainDays: 1,
    basis: "SYNTHETIC TEST POLICY ONLY - NOT A CLIENT LEGAL SCHEDULE",
    policyReference: "SYNTHETIC-DR-POLICY",
  });
  await approveRetentionPolicy(
    finance,
    policy.id,
    "Independent approval of synthetic recovery test policy only",
  );
  const deletion = await requestDocumentDeletion(
    checker,
    docs[3].id,
    "Synthetic historical support payload used for recovery lock validation",
  );
  await approveDocumentDeletion(
    finance,
    deletion.id,
    "Independent approval of synthetic test document deletion",
  );
  process.env.RETENTION_EXECUTION_ENABLED = "true";

  // Queue real retention deletion before backup. Snapshot acquisition must
  // happen after the exclusive physical-deletion transaction has committed.
  let locked!: () => void, release!: () => void;
  const lockedSignal = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const releaseSignal = new Promise<void>((resolve) => {
    release = resolve;
  });
  const gate = db.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(648271430)`;
      locked();
      await releaseSignal;
    },
    { timeout: 20000 },
  );
  await lockedSignal;
  const deleting = executeDocumentDeletion(checker, deletion.id);
  let queued = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    const [result] = await db.$queryRaw<
      { waiting: boolean }[]
    >`SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype='advisory' AND objid=648271430 AND mode='ExclusiveLock' AND NOT granted) AS waiting`;
    if (result.waiting) {
      queued = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(
    queued,
    true,
    "Retention deletion must be waiting on the real file lock",
  );
  let backupFinished = false;
  const backupPending = backup().then((result) => {
    backupFinished = true;
    return result;
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(
    backupFinished,
    false,
    "Backup must wait for the physical deletion lock",
  );
  release();
  await gate;
  assert.equal((await deleting).state, "COMPLETED");
  const bundle = await backupPending;
  assert.equal(bundle.version, 2);
  assert.equal(bundle.files, 3);
  assert.equal((await stat(bundle.path)).mode & 0o777, 0o600);

  // Inject storage loss, fail before writing a bundle, then restore the fixture.
  const source = resolve(process.env.STORAGE_ROOT!, docs[1].storageKey);
  const hidden = resolve(".data", `recovery-hidden-${runId}`);
  await rename(source, hidden);
  try {
    await assert.rejects(backup(), { code: "ENOENT" });
  } finally {
    await rename(hidden, source);
  }

  const encrypted = await readFile(bundle.path, "utf8");
  const damaged = Buffer.from(encrypted, "base64");
  damaged[Math.floor(damaged.length / 2)] ^= 1;
  const corrupted = `${bundle.path}.tampered`;
  await writeFile(corrupted, damaged.toString("base64"), {
    mode: 0o600,
    flag: "wx",
  });
  await assert.rejects(restoreDrill(corrupted));
  const payload = JSON.parse(decrypt(encrypted, "BACKUP_KEY").toString());
  const wrongDump = `${bundle.path}.bad-dump`;
  await writeFile(
    wrongDump,
    encrypt(
      JSON.stringify({ ...payload, dumpHash: "0".repeat(64) }),
      "BACKUP_KEY",
    ),
    { mode: 0o600, flag: "wx" },
  );
  await assert.rejects(restoreDrill(wrongDump), /BACKUP_INTEGRITY/);
  const missingFile = `${bundle.path}.missing-file`;
  await writeFile(
    missingFile,
    encrypt(
      JSON.stringify({ ...payload, files: payload.files.slice(1) }),
      "BACKUP_KEY",
    ),
    { mode: 0o600, flag: "wx" },
  );
  await assert.rejects(restoreDrill(missingFile), /BACKUP_MANIFEST_REQUIRED/);
  const wrongKey = process.env.BACKUP_KEY!;
  try {
    process.env.BACKUP_KEY = randomBytes(32).toString("hex");
    await assert.rejects(restoreDrill(bundle.path));
  } finally {
    process.env.BACKUP_KEY = wrongKey;
  }

  const restoreStarted = Date.now();
  const restoredResult = await restoreDrill(bundle.path);
  const restoredUrl = new URL(url);
  restoredUrl.pathname = `/${restoredResult.target}`;
  restored = new PrismaClient({ datasourceUrl: restoredUrl.toString() });
  const originalLease = await db.lease.findUniqueOrThrow({
    where: { id: lease.id },
  });
  assert.deepEqual(
    await restored.lease.findUniqueOrThrow({ where: { id: lease.id } }),
    originalLease,
  );
  for (const document of docs.slice(0, 3)) {
    const bytes = decrypt(
      await readFile(
        resolve(".data", restoredResult.target, document.storageKey),
        "utf8",
      ),
      "FILE_KEY",
    );
    assert.equal(hash(bytes), document.hash);
    assert.equal(bytes.length, document.bytes);
  }
  const charges = await restored.charge.findMany({
    where: { propertyId: property.id },
    include: { credits: true, allocations: { include: { reversals: true } } },
  });
  assert.equal(
    charges.reduce(
      (sum, charge) =>
        sum +
        charge.amountMinor -
        charge.credits.reduce((s, c) => s + c.amountMinor, 0n) -
        charge.allocations.reduce(
          (s, a) =>
            s +
            a.amountMinor -
            a.reversals.reduce((v, r) => v + r.amountMinor, 0n),
          0n,
        ),
      0n,
    ),
    2300n,
  );
  const receipt = await restored.receipt.findFirstOrThrow();
  await assert.rejects(
    restored.receipt.update({
      where: { id: receipt.id },
      data: { number: "forbidden-rewrite" },
    }),
  );
  const audit = await restored.auditEvent.findFirstOrThrow();
  await assert.rejects(restored.auditEvent.delete({ where: { id: audit.id } }));
  await assert.rejects(
    restored.lease.update({
      where: { id: lease.id },
      data: { documentHash: "forbidden-rewrite" },
    }),
  );
  const evidence = {
    executedAt: new Date().toISOString(),
    sourceDatabase: database,
    restoredDatabase: restoredResult.target,
    bundleVersion: restoredResult.version,
    verifiedTables: restoredResult.verifiedTables,
    verifiedDocumentPlaintextHashes: restoredResult.verifiedDocuments,
    restoreElapsedMs: restoredResult.elapsedMs,
    restoreAndAcceptanceElapsedMs: Date.now() - restoreStarted,
    entireDrillElapsedMs: Date.now() - started,
    databaseDumpBytes: bundle.bytes,
    balanceOutstandingMinor: "2300",
    balanceUnallocatedMinor: "0",
    negativeChecks: [
      "ciphertext tamper",
      "dump hash mismatch",
      "missing file manifest",
      "wrong backup key",
      "missing source blob",
      "immutable restored receipt",
      "immutable restored audit",
      "immutable restored executed lease",
    ],
    concurrencyCheck:
      "Backup waited for exclusive deletion and acquired its database snapshot after deletion committed",
    recoveryLimit:
      "Synthetic local drill only. No production RPO/RTO, offsite availability, key escrow or failover claim.",
  };
  const output = resolve(".data", `recovery-evidence-${runId}.json`);
  await writeFile(output, JSON.stringify(evidence, null, 2) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
  console.log(JSON.stringify({ ...evidence, evidenceFile: output }));
} finally {
  await restored?.$disconnect();
  await db.$disconnect();
}
