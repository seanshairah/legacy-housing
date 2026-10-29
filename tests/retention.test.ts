import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  readFile,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { resolve } from "node:path";
import { db } from "../src/lib/db";
import { encrypt, hash } from "../src/lib/security";
import { download } from "../src/domain/documents";
import {
  approveDocumentDeletion,
  approveRetentionPolicy,
  executeDocumentDeletion,
  imposeDocumentHold,
  proposeRetentionPolicy,
  releaseDocumentHold,
  requestDocumentDeletion,
  retentionDryRun,
  retentionOverview,
} from "../src/domain/retention";
import { assertTestDatabase } from "./safety";
assertTestDatabase();
process.env.DATA_KEY ||= randomBytes(32).toString("hex");
process.env.FILE_KEY ||= randomBytes(32).toString("hex");
const root = resolve(".data", `retention-tests-${randomUUID()}`),
  old = new Date(Date.now() - 10 * 86400000),
  reason = "SYNTHETIC retention control verification; no real personal data";
beforeAll(async () => {
  vi.stubEnv("STORAGE_ROOT", root);
  await mkdir(root, { recursive: true, mode: 0o700 });
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});
async function fixture(kind = "IDENTITY", status = "WITHDRAWN") {
  const run = randomUUID(),
    users = await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        db.user.create({
          data: {
            name: `Synthetic retention person ${i}`,
            email: `retention-${run}-${i}@example.invalid`,
            phone: `+999${Date.now().toString().slice(-9)}${i}`,
            passwordHash: "unused",
            emailVerifiedAt: new Date(),
            phoneVerifiedAt: new Date(),
          },
        }),
      ),
    ),
    property = await db.property.create({
      data: {
        name: "Synthetic retention property",
        slug: `retention-${run}`,
        description: reason,
        location: "Test only",
      },
    });
  await db.membership.createMany({
    data: [
      { userId: users[0].id, propertyId: property.id, role: "ADMIN" },
      { userId: users[1].id, propertyId: property.id, role: "ADMIN" },
      { userId: users[2].id, propertyId: property.id, role: "FINANCE" },
    ],
  });
  const application = await db.application.create({
      data: {
        propertyId: property.id,
        userId: users[3].id,
        status,
        createdAt: old,
        updatedAt: old,
      },
    }),
    bytes = Buffer.from(
      "SYNTHETIC encrypted private payload for retention workflow only",
    ),
    storageKey = randomUUID();
  await writeFile(resolve(root, storageKey), encrypt(bytes, "FILE_KEY"), {
    mode: 0o600,
  });
  const document = await db.document.create({
    data: {
      propertyId: property.id,
      userId: users[3].id,
      applicationId: application.id,
      kind,
      filename: "synthetic.pdf",
      mime: "application/pdf",
      bytes: bytes.length,
      hash: hash(bytes),
      storageKey,
      state: "CLEAN",
      createdAt: old,
    },
  });
  return {
    property,
    application,
    document,
    maker: users[0],
    checker: users[1],
    finance: users[2],
    resident: users[3],
    bytes,
  };
}
async function policy(f: Awaited<ReturnType<typeof fixture>>) {
  const p = await proposeRetentionPolicy(f.maker, {
    propertyId: f.property.id,
    kind: f.document.kind,
    retainDays: 1,
    basis: reason,
    policyReference: "TEST-ONLY-POLICY-REFERENCE",
  });
  await approveRetentionPolicy(f.checker, p.id, reason);
  return p;
}
async function approvedDeletion(f: Awaited<ReturnType<typeof fixture>>) {
  await policy(f);
  const d = await requestDocumentDeletion(f.maker, f.document.id, reason);
  await approveDocumentDeletion(f.checker, d.id, reason);
  return d;
}

describe("policy-gated private payload retention", () => {
  it("starts disabled, requires an approved policy and independent approvals, then removes only the payload idempotently", async () => {
    const f = await fixture();
    await expect(
      requestDocumentDeletion(f.maker, f.document.id, reason),
    ).rejects.toThrow("NO_APPROVED_RETENTION_POLICY");
    const p = await proposeRetentionPolicy(f.maker, {
      propertyId: f.property.id,
      kind: "IDENTITY",
      retainDays: 1,
      basis: reason,
      policyReference: "TEST-POLICY",
    });
    await expect(approveRetentionPolicy(f.maker, p.id, reason)).rejects.toThrow(
      "INDEPENDENT_RETENTION_APPROVER_REQUIRED",
    );
    expect(
      (await retentionDryRun(f.maker, f.property.id)).items[0].reason,
    ).toBe("NO_APPROVED_RETENTION_POLICY");
    await approveRetentionPolicy(f.checker, p.id, reason);
    expect(
      (await retentionDryRun(f.maker, f.property.id)).items[0].eligible,
    ).toBe(true);
    const d = await requestDocumentDeletion(f.maker, f.document.id, reason);
    expect(
      (await requestDocumentDeletion(f.maker, f.document.id, reason)).id,
    ).toBe(d.id);
    await expect(
      approveDocumentDeletion(f.maker, d.id, reason),
    ).rejects.toThrow("INDEPENDENT_DELETION_APPROVER_REQUIRED");
    vi.stubEnv("RETENTION_EXECUTION_ENABLED", "false");
    await expect(executeDocumentDeletion(f.checker, d.id)).rejects.toThrow(
      "RETENTION_EXECUTION_DISABLED",
    );
    vi.stubEnv("RETENTION_EXECUTION_ENABLED", "true");
    await expect(executeDocumentDeletion(f.checker, d.id)).rejects.toThrow(
      "INDEPENDENT_DELETION_APPROVAL_REQUIRED",
    );
    await approveDocumentDeletion(f.checker, d.id, reason);
    expect((await executeDocumentDeletion(f.checker, d.id)).state).toBe(
      "COMPLETED",
    );
    await expect(
      access(resolve(root, f.document.storageKey)),
    ).rejects.toThrow();
    const doc = await db.document.findUniqueOrThrow({
      where: { id: f.document.id },
    });
    expect(doc.state).toBe("DELETED");
    expect(doc.deletedAt).toBeTruthy();
    expect(doc.hash).toBe(f.document.hash);
    expect(doc.filename).toBe("erased-document");
    expect(doc.storageKey).toBe(f.document.storageKey);
    await expect(download(f.resident, doc.id)).rejects.toThrow(
      "QUARANTINED_OR_REJECTED",
    );
    await executeDocumentDeletion(f.maker, d.id);
    expect(
      await db.auditEvent.count({
        where: { objectId: d.id, action: "retention.document_deleted" },
      }),
    ).toBe(1);
    await expect(
      db.document.update({
        where: { id: doc.id },
        data: { state: "CLEAN", deletedAt: null },
      }),
    ).rejects.toThrow("immutable");
    await expect(db.document.delete({ where: { id: doc.id } })).rejects.toThrow(
      "immutable",
    );
  });

  it("rechecks new legal holds immediately before execution and requires independent hold release", async () => {
    const f = await fixture("MEDICAL"),
      d = await approvedDeletion(f);
    const hold = await imposeDocumentHold(f.maker, {
      documentId: f.document.id,
      reason,
    });
    vi.stubEnv("RETENTION_EXECUTION_ENABLED", "true");
    await expect(executeDocumentDeletion(f.checker, d.id)).rejects.toThrow(
      "LEGAL_HOLD",
    );
    await expect(
      access(resolve(root, f.document.storageKey)),
    ).resolves.toBeUndefined();
    await expect(releaseDocumentHold(f.maker, hold.id, reason)).rejects.toThrow(
      "INDEPENDENT_HOLD_RELEASE_REQUIRED",
    );
    await expect(
      db.document.update({
        where: { id: f.document.id },
        data: { state: "DELETION_PENDING" },
      }),
    ).rejects.toThrow("legal hold");
    await releaseDocumentHold(f.checker, hold.id, reason);
    await expect(
      releaseDocumentHold(f.checker, hold.id, reason),
    ).rejects.toThrow("HOLD_ALREADY_RELEASED");
    await executeDocumentDeletion(f.checker, d.id);
    await expect(
      imposeDocumentHold(f.maker, { documentId: f.document.id, reason }),
    ).rejects.toThrow("DELETION_ALREADY_CLAIMED");
    await expect(
      db.documentLegalHold.delete({ where: { id: hold.id } }),
    ).rejects.toThrow("immutable");
  });

  it("denies cross-property, finance-only, resident and delegated-key administration", async () => {
    const f = await fixture(),
      other = await fixture();
    for (const actor of [
      other.maker,
      f.finance,
      f.resident,
      {
        id: f.maker.id,
        apiPropertyId: other.property.id,
        apiScopes: ["settings"],
      },
    ]) {
      await expect(retentionDryRun(actor, f.property.id)).rejects.toThrow(
        "FORBIDDEN",
      );
      await expect(
        imposeDocumentHold(actor, { documentId: f.document.id, reason }),
      ).rejects.toThrow("FORBIDDEN");
      await expect(
        proposeRetentionPolicy(actor, {
          propertyId: f.property.id,
          kind: "IDENTITY",
          retainDays: 1,
          basis: reason,
          policyReference: "TEST-POLICY",
        }),
      ).rejects.toThrow("FORBIDDEN");
    }
    await expect(
      requestDocumentDeletion(other.maker, f.document.id, reason),
    ).rejects.toThrow("FORBIDDEN");
    await expect(
      db.documentLegalHold.create({
        data: {
          propertyId: other.property.id,
          documentId: f.document.id,
          imposedBy: other.maker.id,
          reason,
        },
      }),
    ).rejects.toThrow("property mismatch");
    const ownPolicy = await policy(f);
    await expect(
      db.documentDeletion.create({
        data: {
          propertyId: other.property.id,
          documentId: f.document.id,
          policyId: ownPolicy.id,
          requestedBy: other.maker.id,
          reason,
        },
      }),
    ).rejects.toThrow("scope mismatch");
    await expect(
      db.document.update({
        where: { id: f.document.id },
        data: { state: "DELETION_PENDING" },
      }),
    ).rejects.toThrow("Approved deletion required");

    expect(
      (await readFile(resolve(root, f.document.storageKey))).length,
    ).toBeGreaterThan(0);
  });

  it("preserves active applications, recent documents and every financial or signed agreement evidence kind", async () => {
    const active = await fixture("IDENTITY", "ACTIVE");
    await policy(active);
    await expect(
      requestDocumentDeletion(active.maker, active.document.id, reason),
    ).rejects.toThrow("ACTIVE_APPLICATION");
    const recent = await fixture("IDENTITY");
    await policy(recent);
    await db.application.update({
      where: { id: recent.application.id },
      data: { updatedAt: new Date() },
    });
    await expect(
      requestDocumentDeletion(recent.maker, recent.document.id, reason),
    ).rejects.toThrow("RETENTION_NOT_EXPIRED");
    for (const kind of ["PAYMENT_PROOF", "SIGNED_LEASE"]) {
      const evidence = await fixture(kind);
      await expect(
        proposeRetentionPolicy(evidence.maker, {
          propertyId: evidence.property.id,
          kind,
          retainDays: 1,
          basis: reason,
          policyReference: "TEST-POLICY",
        }),
      ).rejects.toThrow();
      await expect(
        requestDocumentDeletion(evidence.maker, evidence.document.id, reason),
      ).rejects.toThrow("IMMUTABLE_EVIDENCE");
      await expect(
        db.document.update({
          where: { id: evidence.document.id },
          data: { state: "DELETION_PENDING" },
        }),
      ).rejects.toThrow("evidence cannot be erased");
      await access(resolve(root, evidence.document.storageKey));
    }
    const referenced = await fixture();
    await policy(referenced);
    await db.payment.create({
      data: {
        userId: referenced.resident.id,
        propertyId: referenced.property.id,
        reference: `retention-${randomUUID()}`,
        idempotencyKey: randomUUID(),
        amountMinor: 100n,
        currency: "USD",
        method: "BANK",
        proofDocumentId: referenced.document.id,
      },
    });
    await expect(
      requestDocumentDeletion(referenced.maker, referenced.document.id, reason),
    ).rejects.toThrow("IMMUTABLE_EVIDENCE");
  });

  it("keeps policy versions immutable, refuses superseded approvals and paginates bounded dry runs", async () => {
    const f = await fixture(),
      oldPolicy = await policy(f);
    const request = await requestDocumentDeletion(
      f.maker,
      f.document.id,
      reason,
    );
    const p2 = await proposeRetentionPolicy(f.maker, {
      propertyId: f.property.id,
      kind: "IDENTITY",
      retainDays: 30,
      basis: reason,
      policyReference: "TEST-REPLACEMENT-POLICY",
    });
    expect(p2.version).toBe(2);
    await approveRetentionPolicy(f.checker, p2.id, reason);
    expect(
      (
        await db.retentionPolicy.findUniqueOrThrow({
          where: { id: oldPolicy.id },
        })
      ).state,
    ).toBe("SUPERSEDED");
    await expect(
      approveDocumentDeletion(f.checker, request.id, reason),
    ).rejects.toThrow("NO_APPROVED_RETENTION_POLICY");
    await expect(
      db.retentionPolicy.update({
        where: { id: p2.id },
        data: { retainDays: 1 },
      }),
    ).rejects.toThrow("immutable");
    await expect(
      retentionDryRun(f.maker, f.property.id, 101),
    ).rejects.toThrow();
    await db.document.create({
      data: {
        ...Object.fromEntries(
          Object.entries(f.document).filter(
            ([k]) => !["id", "storageKey"].includes(k),
          ),
        ),
        storageKey: randomUUID(),
        version: 2,
      } as typeof f.document,
    });
    const first = await retentionDryRun(f.maker, f.property.id, 1);
    expect(first.items).toHaveLength(1);
    expect(first.next).toBeTruthy();
    const second = await retentionDryRun(
      f.maker,
      f.property.id,
      1,
      first.next!,
    );
    expect(second.items).toHaveLength(1);
    expect(second.items[0].id).not.toBe(first.items[0].id);
    expect(second.next).toBeNull();
    await db.retentionPolicy.createMany({
      data: Array.from({ length: 99 }, (_, i) => ({
        propertyId: f.property.id,
        kind: "IDENTITY",
        retainDays: 30,
        basis: reason,
        policyReference: "SYNTHETIC-PAGINATED-POLICY",
        version: i + 3,
        proposedBy: f.maker.id,
      })),
    });
    const history1 = await retentionOverview(f.maker, f.property.id),
      history2 = await retentionOverview(f.maker, f.property.id, 2);
    expect(history1.policies).toHaveLength(100);
    expect(history1.hasNext).toBe(true);
    expect(history2.policies).toHaveLength(1);
    expect(history2.hasNext).toBe(false);
    expect(history1.policies.map((p) => p.id)).not.toContain(
      history2.policies[0].id,
    );
  });

  it("retains service attachments until both request closure and the approved post-resolution period", async () => {
    const f = await fixture("SUPPORT");
    await policy(f);
    const ticket = await db.ticket.create({
      data: {
        propertyId: f.property.id,
        userId: f.resident.id,
        type: "SUPPORT",
        category: "Synthetic",
        subject: "Synthetic retention attachment",
        body: reason,
        dueAt: new Date(),
        messages: {
          create: {
            actorId: f.resident.id,
            body: reason,
            documentId: f.document.id,
          },
        },
      },
    });
    await expect(
      requestDocumentDeletion(f.maker, f.document.id, reason),
    ).rejects.toThrow("ACTIVE_SERVICE_REQUEST");
    await db.ticket.update({
      where: { id: ticket.id },
      data: { status: "RESOLVED", resolvedAt: new Date() },
    });
    await expect(
      requestDocumentDeletion(f.maker, f.document.id, reason),
    ).rejects.toThrow("RETENTION_NOT_EXPIRED");
    await db.ticket.update({
      where: { id: ticket.id },
      data: { resolvedAt: old, updatedAt: old },
    });
    const request = await requestDocumentDeletion(
      f.maker,
      f.document.id,
      reason,
    );
    const overview = await retentionOverview(f.checker, f.property.id);
    expect(overview.deletions.map((d) => d.id)).toContain(request.id);
    expect(overview.policies).toHaveLength(1);
    await expect(retentionOverview(f.finance, f.property.id)).rejects.toThrow(
      "FORBIDDEN",
    );
  });

  it("serializes actual unlink with backup capture and concurrent executors without duplicate completion", async () => {
    const f = await fixture(),
      request = await approvedDeletion(f);
    vi.stubEnv("RETENTION_EXECUTION_ENABLED", "true");
    let ready!: () => void, release!: () => void;
    const readyPromise = new Promise<void>((r) => {
        ready = r;
      }),
      releasePromise = new Promise<void>((r) => {
        release = r;
      });
    const capture = db.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(648271430)`;
        ready();
        await releasePromise;
      },
      { timeout: 15000 },
    );
    await readyPromise;
    const deleting = executeDocumentDeletion(f.checker, request.id);
    try {
      await expect
        .poll(
          async () =>
            (
              await db.document.findUniqueOrThrow({
                where: { id: f.document.id },
              })
            ).state,
        )
        .toBe("DELETION_PENDING");
      await expect(
        access(resolve(root, f.document.storageKey)),
      ).resolves.toBeUndefined();
      expect(
        (
          await db.documentDeletion.findUniqueOrThrow({
            where: { id: request.id },
          })
        ).state,
      ).toBe("DELETING");
    } finally {
      release();
    }
    await capture;
    await Promise.all([deleting, executeDocumentDeletion(f.maker, request.id)]);
    expect(
      await db.auditEvent.count({
        where: { objectId: request.id, action: "retention.document_deleted" },
      }),
    ).toBe(1);
    await expect(
      access(resolve(root, f.document.storageKey)),
    ).rejects.toThrow();
  });

  it("retries filesystem failures without reopening access and recovers a crash after unlink", async () => {
    vi.stubEnv("RETENTION_EXECUTION_ENABLED", "true");
    const f = await fixture(),
      request = await approvedDeletion(f),
      path = resolve(root, f.document.storageKey);
    await unlink(path);
    await mkdir(path);
    await expect(
      executeDocumentDeletion(f.checker, request.id),
    ).rejects.toThrow();
    expect(
      (
        await db.documentDeletion.findUniqueOrThrow({
          where: { id: request.id },
        })
      ).state,
    ).toBe("FAILED");
    await expect(download(f.resident, f.document.id)).rejects.toThrow(
      "QUARANTINED_OR_REJECTED",
    );
    await rm(path, { recursive: true });
    await writeFile(path, encrypt(f.bytes, "FILE_KEY"), { mode: 0o600 });
    await executeDocumentDeletion(f.checker, request.id);
    const crashed = await fixture(),
      d2 = await approvedDeletion(crashed);
    // Reproduce the committed claim + successful unlink boundary before completion.
    await db.document.update({
      where: { id: crashed.document.id },
      data: { state: "DELETION_PENDING" },
    });
    await db.documentDeletion.update({
      where: { id: d2.id },
      data: { state: "DELETING" },
    });
    await unlink(resolve(root, crashed.document.storageKey));
    expect((await executeDocumentDeletion(crashed.checker, d2.id)).state).toBe(
      "COMPLETED",
    );
    await expect(
      db.documentDeletion.update({
        where: { id: d2.id },
        data: { approvedBy: crashed.maker.id },
      }),
    ).rejects.toThrow("immutable");
  });
});
