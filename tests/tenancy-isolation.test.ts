import { beforeAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { db } from "../src/lib/db";
import { encrypt, hash } from "../src/lib/security";
import {
  configureOrganisationPaynow,
  createOrganisation,
  getOrganisation,
  grantOrganisationMembership,
  listOrganisations,
  organisationForProperty,
  organisationPaynowConfiguration,
  permitOrganisation,
  revokeOrganisationMembership,
  updateOrganisation,
} from "../src/domain/organisations";
import { permit } from "../src/domain/access";
import { download } from "../src/domain/documents";
import { withTenant } from "../src/lib/tenant-context";
import { assertTestDatabase } from "./safety";

assertTestDatabase();
process.env.DATA_KEY ||= randomBytes(32).toString("hex");
const run = randomUUID();
async function user(label: string) {
  return db.user.create({
    data: {
      email: `org-${label}-${run}@example.invalid`,
      phone: `+999${randomBytes(6).readUIntBE(0, 6)}`,
      name: `Synthetic organisation ${label}`,
      passwordHash: "unused",
      active: true,
      emailVerifiedAt: new Date(),
      phoneVerifiedAt: new Date(),
      mfaSecret: encrypt("synthetic fixture secret"),
      mfaConfirmed: true,
    },
  });
}
async function organisationFixture(label: string) {
  const actor = await user(label);
  const organisation = await db.organisation.create({
    data: {
      slug: `${label}-${run}`,
      name: `Synthetic ${label}`,
      legalEntity: `Synthetic ${label} entity`,
      memberships: { create: { userId: actor.id, role: "ADMIN" } },
    },
  });
  const property = await db.property.create({
    data: {
      organisationId: organisation.id,
      slug: `prop-${label}-${run}`,
      name: `Synthetic ${label} property`,
      description: "Synthetic organisation isolation fixture",
      location: "Test only",
      memberships: { create: { userId: actor.id, role: "ADMIN" } },
    },
  });
  const building = await db.building.create({
    data: { propertyId: property.id, name: "A" },
  });
  const floor = await db.floor.create({
    data: { buildingId: building.id, name: "Ground", level: 0 },
  });
  const room = await db.room.create({
    data: {
      floorId: floor.id,
      name: "101",
      category: "SINGLE",
      monthlyMinor: 0n,
      beds: { create: { label: "A" } },
    },
    include: { beds: true },
  });
  const application = await db.application.create({
    data: { propertyId: property.id, userId: actor.id, status: "ACTIVE" },
  });
  const reservation = await db.reservation.create({
    data: {
      propertyId: property.id,
      userId: actor.id,
      applicationId: application.id,
      bedId: room.beds[0].id,
      state: "ACTIVE",
      startAt: new Date("2030-01-01"),
      endAt: new Date("2030-02-01"),
    },
  });
  const document = await db.document.create({
    data: {
      userId: actor.id,
      propertyId: property.id,
      applicationId: application.id,
      kind: "IDENTITY",
      filename: "synthetic.pdf",
      storageKey: randomUUID(),
      hash: hash("synthetic"),
      bytes: 10,
      mime: "application/pdf",
      state: "CLEAN",
    },
  });
  const charge = await db.charge.create({
    data: {
      userId: actor.id,
      propertyId: property.id,
      reference: `INV-${label}-${run}`,
      category: "RENT",
      description: "Synthetic test charge",
      amountMinor: 100n,
      currency: "USD",
      dueAt: new Date(),
    },
  });
  const payment = await db.payment.create({
    data: {
      userId: actor.id,
      propertyId: property.id,
      reference: `PAY-${label}-${run}`,
      idempotencyKey: randomUUID(),
      amountMinor: 100n,
      currency: "USD",
      method: "PAYNOW",
      status: "PAID",
      settledAt: new Date(),
    },
  });
  const receipt = await db.receipt.create({
    data: {
      paymentId: payment.id,
      number: `REC-${label}-${run}`,
      snapshot: { synthetic: true },
    },
  });
  await db.allocation.create({
    data: { paymentId: payment.id, chargeId: charge.id, amountMinor: 100n },
  });
  const template = await db.leaseTemplate.create({
    data: {
      propertyId: property.id,
      version: 1,
      title: "Synthetic only",
      body: "Synthetic tenancy",
      hash: hash("Synthetic tenancy"),
      approvedAt: new Date(),
    },
  });
  const lease = await db.lease.create({
    data: {
      propertyId: property.id,
      userId: actor.id,
      applicationId: application.id,
      reservationId: reservation.id,
      templateId: template.id,
      status: "EXECUTED",
      documentSnapshot: "Synthetic tenancy",
      documentHash: hash("Synthetic tenancy"),
      executedAt: new Date(),
    },
  });
  const ticket = await db.ticket.create({
    data: {
      propertyId: property.id,
      userId: actor.id,
      type: "SUPPORT",
      category: "Synthetic",
      subject: "Synthetic isolation test",
      body: "Test only",
      dueAt: new Date(),
    },
  });
  const audit = await db.auditEvent.create({
    data: {
      actorId: actor.id,
      propertyId: property.id,
      action: "test.created",
      objectId: property.id,
      detail: {},
      traceId: randomUUID(),
    },
  });
  const outbox = await db.outboxEvent.create({
    data: {
      propertyId: property.id,
      userId: actor.id,
      type: "test.created",
      payload: {},
      traceId: randomUUID(),
    },
  });
  return {
    actor,
    organisation,
    property,
    building,
    floor,
    room,
    application,
    reservation,
    document,
    charge,
    payment,
    receipt,
    template,
    lease,
    ticket,
    audit,
    outbox,
  };
}
let a: Awaited<ReturnType<typeof organisationFixture>>;
let b: Awaited<ReturnType<typeof organisationFixture>>;
beforeAll(async () => {
  a = await organisationFixture("tenant-a");
  b = await organisationFixture("tenant-b");
});

describe("organisation ownership and restricted PostgreSQL tenant context", () => {
  it("creates the organisation hierarchy and denies foreign service/object access", async () => {
    expect(await organisationForProperty(a.property.id)).toBe(
      a.organisation.id,
    );
    await permitOrganisation(a.actor, a.organisation.id, "admin");
    await expect(
      permitOrganisation(a.actor, b.organisation.id),
    ).rejects.toThrow("ORGANISATION_FORBIDDEN");
    await expect(getOrganisation(a.actor, b.organisation.id)).rejects.toThrow(
      "ORGANISATION_FORBIDDEN",
    );
    await expect(
      permit(a.actor, b.property.id, "finance.read"),
    ).rejects.toThrow("FORBIDDEN");
    await expect(download(a.actor, b.document.id)).rejects.toThrow("FORBIDDEN");
    await expect(
      withTenant(a.actor, b.organisation.id, (tx) => tx.property.findMany()),
    ).rejects.toThrow("ORGANISATION_FORBIDDEN");
    const mine = await listOrganisations(a.actor);
    expect(mine.data.map((o) => o.id)).toContain(a.organisation.id);
    expect(mine.data.map((o) => o.id)).not.toContain(b.organisation.id);
  });

  it("RLS filters every tested domain graph and does not expose credentials or identity control-plane tables", async () => {
    const counts = await withTenant(a.actor, a.organisation.id, async (tx) => ({
      properties: await tx.property.findMany({ select: { id: true } }),
      beds: await tx.bed.findMany({ select: { id: true } }),
      applications: await tx.application.findMany({ select: { id: true } }),
      documents: await tx.document.findMany({ select: { id: true } }),
      charges: await tx.charge.findMany({ select: { id: true } }),
      payments: await tx.payment.findMany({ select: { id: true } }),
      receipts: await tx.receipt.findMany({ select: { id: true } }),
      leases: await tx.lease.findMany({ select: { id: true } }),
      tickets: await tx.ticket.findMany({ select: { id: true } }),
      audits: await tx.auditEvent.findMany({ select: { id: true } }),
      outbox: await tx.outboxEvent.findMany({ select: { id: true } }),
    }));
    for (const rows of Object.values(counts)) expect(rows).toHaveLength(1);
    expect(counts.documents[0].id).toBe(a.document.id);
    expect(counts.receipts[0].id).toBe(a.receipt.id);
    await expect(
      withTenant(
        a.actor,
        a.organisation.id,
        (tx) => tx.$queryRaw`SELECT "passwordHash" FROM "User"`,
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      withTenant(a.actor, a.organisation.id, (tx) => tx.session.findMany()),
    ).rejects.toThrow(/permission denied/);
    await expect(
      withTenant(
        a.actor,
        a.organisation.id,
        (tx) =>
          tx.$queryRaw`SELECT "paymentCredentialsEncrypted" FROM "Organisation"`,
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it("the restricted role hides staff internal notes from residents in the same organisation", async () => {
    const resident = await user("note-resident");
    await db.application.create({
      data: { userId: resident.id, propertyId: a.property.id },
    });
    const ticket = await db.ticket.create({
      data: {
        userId: resident.id,
        propertyId: a.property.id,
        type: "SUPPORT",
        category: "Synthetic",
        subject: "Private-note visibility",
        body: "Synthetic test",
        dueAt: new Date(),
      },
    });
    const external = await db.ticketMessage.create({
      data: {
        ticketId: ticket.id,
        actorId: a.actor.id,
        body: "Resident-visible progress",
        internal: false,
      },
    });
    const internal = await db.ticketMessage.create({
      data: {
        ticketId: ticket.id,
        actorId: a.actor.id,
        body: "Staff-only synthetic note",
        internal: true,
      },
    });
    const staffRows = await withTenant(a.actor, a.organisation.id, (tx) =>
      tx.ticketMessage.findMany({ where: { ticketId: ticket.id } }),
    );
    expect(staffRows.map((m) => m.id)).toEqual(
      expect.arrayContaining([external.id, internal.id]),
    );
    const residentRows = await withTenant(resident, a.organisation.id, (tx) =>
      tx.ticketMessage.findMany({ where: { ticketId: ticket.id } }),
    );
    expect(residentRows.map((m) => m.id)).toEqual([external.id]);
    await expect(
      withTenant(resident, a.organisation.id, (tx) =>
        tx.ticketMessage.create({
          data: {
            ticketId: ticket.id,
            actorId: resident.id,
            body: "Cannot create internal record",
            internal: true,
          },
        }),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("RLS prevents foreign inserts, updates and deletes even when SQL omits the tenant predicate", async () => {
    await expect(
      withTenant(a.actor, a.organisation.id, (tx) =>
        tx.charge.create({
          data: {
            propertyId: b.property.id,
            userId: b.actor.id,
            reference: `ATTACK-${run}`,
            category: "RENT",
            description: "Must fail",
            amountMinor: 1n,
            currency: "USD",
            dueAt: new Date(),
          },
        }),
      ),
    ).rejects.toThrow(/row-level security/);
    const result = await withTenant(a.actor, a.organisation.id, async (tx) => ({
      updated: await tx.ticket.updateMany({
        where: { id: b.ticket.id },
        data: { subject: "Must not be changed" },
      }),
      deleted: await tx.document.deleteMany({ where: { id: b.document.id } }),
    }));
    expect(result.updated.count).toBe(0);
    expect(result.deleted.count).toBe(0);
    expect(
      (await db.ticket.findUniqueOrThrow({ where: { id: b.ticket.id } }))
        .subject,
    ).toBe("Synthetic isolation test");
    expect(await db.document.count({ where: { id: b.document.id } })).toBe(1);
  });

  it("requires context and clears role and tenant settings when a pooled transaction finishes or rolls back", async () => {
    const noContext = await db.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE legacy_tenant`;
      return tx.property.count();
    });
    expect(noContext).toBe(0);
    await expect(
      withTenant(a.actor, a.organisation.id, async () => {
        throw new Error("synthetic rollback");
      }),
    ).rejects.toThrow("synthetic rollback");
    const contexts = await Promise.all(
      Array.from({ length: 12 }, (_, i) => {
        const f = i % 2 ? a : b;
        return withTenant(f.actor, f.organisation.id, async (tx) => {
          const rows = await tx.$queryRaw<
            { organisation: string; role: string }[]
          >`SELECT current_setting('app.organisation_id') AS organisation,current_user AS role`;
          expect(rows[0]).toEqual({
            organisation: f.organisation.id,
            role: "legacy_tenant",
          });
          expect(
            (await tx.property.findMany({ select: { id: true } }))[0].id,
          ).toBe(f.property.id);
          return rows[0].organisation;
        });
      }),
    );
    expect(contexts.filter((id) => id === a.organisation.id)).toHaveLength(6);
    const unrestricted = await db.$queryRaw<
      { role: string; organisation: string | null }[]
    >`SELECT current_user AS role,nullif(current_setting('app.organisation_id',true),'') AS organisation`;
    expect(unrestricted[0].role).not.toBe("legacy_tenant");
    expect(unrestricted[0].organisation).toBeNull();
    const role = await db.$queryRaw<
      {
        rolcanlogin: boolean;
        rolsuper: boolean;
        rolbypassrls: boolean;
        rolcreatedb: boolean;
        rolcreaterole: boolean;
      }[]
    >`SELECT rolcanlogin,rolsuper,rolbypassrls,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname='legacy_tenant'`;
    expect(Object.values(role[0]).every((v) => v === false)).toBe(true);
  });

  it("database constraints reject cross-property relation laundering and organisation reassignment", async () => {
    await expect(
      db.reservation.create({
        data: {
          propertyId: a.property.id,
          userId: a.actor.id,
          bedId: b.room.beds[0].id,
          state: "HOLD",
          startAt: new Date("2032-01-01"),
          endAt: new Date("2032-02-01"),
          expiresAt: new Date("2032-01-01"),
        },
      }),
    ).rejects.toThrow("CROSS_PROPERTY_BED");
    await expect(
      db.document.create({
        data: {
          propertyId: a.property.id,
          userId: a.actor.id,
          applicationId: b.application.id,
          kind: "SUPPORT",
          filename: "synthetic.pdf",
          storageKey: randomUUID(),
          hash: hash("synthetic"),
          bytes: 10,
          mime: "application/pdf",
        },
      }),
    ).rejects.toThrow("CROSS_PROPERTY_APPLICATION");
    await expect(
      db.allocation.create({
        data: {
          paymentId: a.payment.id,
          chargeId: b.charge.id,
          amountMinor: 1n,
        },
      }),
    ).rejects.toThrow("CROSS_PROPERTY_ALLOCATION");
    await expect(
      db.property.update({
        where: { id: a.property.id },
        data: { organisationId: b.organisation.id },
      }),
    ).rejects.toThrow("PROPERTY_ORGANISATION_IMMUTABLE");
  });

  it("separates operator provisioning from tenant personal-data authority", async () => {
    const operator = await user("operator");
    const input = {
      name: "Synthetic provisioned client",
      slug: `provision-${run}`,
      legalEntity: "Synthetic third entity",
      adminUserId: a.actor.id,
    };
    await expect(createOrganisation(operator, input)).rejects.toThrow(
      "PLATFORM_OPERATOR_REQUIRED",
    );
    await db.platformGrant.create({ data: { userId: operator.id } });
    const created = await createOrganisation(operator, input);
    expect(created.paymentMode).toBe("disabled");
    expect(JSON.stringify(created)).not.toMatch(
      /paymentCredentialsEncrypted|integrationKey/,
    );
    await permitOrganisation(a.actor, created.id, "admin");
    await expect(permitOrganisation(operator, created.id)).rejects.toThrow(
      "ORGANISATION_FORBIDDEN",
    );
    await expect(permit(operator, a.property.id, "medical")).rejects.toThrow(
      "FORBIDDEN",
    );
  });

  it("stores independent validated organisation settings and encrypts merchant credentials without returning them", async () => {
    const settings = {
      name: "Synthetic Tenant A",
      legalEntity: "Synthetic entity A",
      branding: {
        displayName: "Synthetic A",
        primaryColour: "#174f3b",
        supportEmail: "support@example.invalid",
      },
      residencyRegion: "LOCAL TEST ONLY",
      retentionPolicy: {
        policyReference: "SYNTHETIC-POLICY",
        noticeVersion: "test-v1",
      },
    };
    await expect(
      updateOrganisation(b.actor, a.organisation.id, settings),
    ).rejects.toThrow("ORGANISATION_ADMIN_REQUIRED");
    await updateOrganisation(a.actor, a.organisation.id, settings);
    expect(
      (await getOrganisation(a.actor, a.organisation.id)).branding,
    ).toEqual(settings.branding);
    expect(
      (await getOrganisation(b.actor, b.organisation.id)).branding,
    ).toEqual({});
    await expect(
      configureOrganisationPaynow(a.actor, a.organisation.id, { mode: "live" }),
    ).rejects.toThrow("MERCHANT_CREDENTIALS_REQUIRED");
    const credentials = {
      integrationId: "synthetic-merchant-a",
      integrationKey: "synthetic-key-no-real-provider",
      currency: "USD",
    };
    const configured = await configureOrganisationPaynow(
      a.actor,
      a.organisation.id,
      { mode: "disabled", credentials },
    );
    expect(configured).toEqual({ mode: "disabled", configured: true });
    const stored = await db.organisation.findUniqueOrThrow({
      where: { id: a.organisation.id },
    });
    expect(stored.paymentCredentialsEncrypted).not.toContain(
      credentials.integrationKey,
    );
    expect(
      (await organisationPaynowConfiguration(a.property.id)).credentials,
    ).toEqual(credentials);
    expect(
      (await organisationPaynowConfiguration(b.property.id)).credentials,
    ).toBeNull();
    expect(
      JSON.stringify(await getOrganisation(a.actor, a.organisation.id)),
    ).not.toContain(credentials.integrationKey);
    const audits = await db.auditEvent.findMany({
      where: { objectId: a.organisation.id },
    });
    expect(JSON.stringify(audits)).not.toContain(credentials.integrationKey);
  });

  it("requires individual property capabilities despite org membership and invalidates sessions on grant and revocation", async () => {
    const delegated = await user("delegated");
    await db.session.create({
      data: {
        userId: delegated.id,
        tokenHash: hash(randomUUID()),
        expiresAt: new Date(Date.now() + 60000),
      },
    });
    const membership = await grantOrganisationMembership(
      a.actor,
      a.organisation.id,
      delegated.id,
      "MEMBER",
    );
    expect(await db.session.count({ where: { userId: delegated.id } })).toBe(0);
    await permitOrganisation(delegated, a.organisation.id);
    await expect(permit(delegated, a.property.id, "finance")).rejects.toThrow(
      "FORBIDDEN",
    );
    await db.session.create({
      data: {
        userId: delegated.id,
        tokenHash: hash(randomUUID()),
        expiresAt: new Date(Date.now() + 60000),
      },
    });
    await revokeOrganisationMembership(
      a.actor,
      membership.id,
      "Synthetic grant revoked after validation",
    );
    expect(await db.session.count({ where: { userId: delegated.id } })).toBe(0);
    await expect(
      permitOrganisation(delegated, a.organisation.id),
    ).rejects.toThrow("ORGANISATION_FORBIDDEN");
    const admin = await db.organisationMembership.findFirstOrThrow({
      where: {
        userId: a.actor.id,
        organisationId: a.organisation.id,
        role: "ADMIN",
      },
    });
    await expect(
      revokeOrganisationMembership(
        a.actor,
        admin.id,
        "Must preserve an organisation administrator",
      ),
    ).rejects.toThrow("LAST_ORGANISATION_ADMIN_REQUIRED");
  });
});
