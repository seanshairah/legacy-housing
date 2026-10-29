import { z } from "zod";
import { db, transaction, type Tx } from "../lib/db";
import { decrypt, encrypt } from "../lib/security";
import { type Actor } from "./access";
import { event } from "./events";

type Client = Tx | typeof db;
export const DEFAULT_ORGANISATION_ID = "mipf";
const idSchema = z.string().trim().min(1).max(100);
const publicSelection = {
  id: true,
  slug: true,
  name: true,
  legalEntity: true,
  branding: true,
  residencyRegion: true,
  retentionPolicy: true,
  paymentMode: true,
  active: true,
  createdAt: true,
} as const;

export async function organisationForProperty(
  propertyId: string,
  client: Client = db,
) {
  const property = await client.property.findUniqueOrThrow({
    where: { id: idSchema.parse(propertyId) },
    select: {
      organisationId: true,
      organisation: { select: { active: true } },
    },
  });
  if (!property.organisation.active) throw new Error("ORGANISATION_INACTIVE");
  return property.organisationId;
}

/** Organisation membership never replaces the individual property capability checks. */
export async function permitOrganisation(
  actor: Actor,
  organisationId: string,
  level: "member" | "admin" = "member",
  client: Client = db,
) {
  organisationId = idSchema.parse(organisationId);
  const user = await client.user.findUnique({
    where: { id: actor.id },
    select: { active: true },
  });
  const organisation = await client.organisation.findUnique({
    where: { id: organisationId },
    select: { active: true },
  });
  if (!user?.active) throw new Error("UNAUTHENTICATED");
  if (!organisation?.active || actor.apiPropertyId)
    throw new Error("ORGANISATION_FORBIDDEN");
  const membership = await client.organisationMembership.findFirst({
    where: {
      userId: actor.id,
      organisationId,
      ...(level === "admin" ? { role: "ADMIN" } : {}),
    },
  });
  if (membership) return;
  const properties = await client.property.findMany({
    where: { organisationId },
    select: { id: true },
  });
  const grants = await client.membership.findMany({
    where: {
      userId: actor.id,
      property: { organisationId },
      ...(level === "admin" ? { role: "ADMIN" } : {}),
    },
    select: { propertyId: true },
  });
  // Backwards compatibility for the previously dedicated deployment: only an
  // administrator explicitly granted EVERY property can manage its organisation.
  if (level === "admin") {
    if (
      properties.length &&
      properties.every((p) => grants.some((g) => g.propertyId === p.id))
    )
      return;
  } else if (
    grants.length ||
    (await client.application.count({
      where: { userId: actor.id, property: { organisationId } },
    })) ||
    (await client.reservation.count({
      where: { userId: actor.id, property: { organisationId } },
    }))
  )
    return;
  throw new Error(
    level === "admin"
      ? "ORGANISATION_ADMIN_REQUIRED"
      : "ORGANISATION_FORBIDDEN",
  );
}

async function verifiedStaff(client: Client, userId: string) {
  const user = await client.user.findUniqueOrThrow({
    where: { id: userId },
    select: {
      active: true,
      emailVerifiedAt: true,
      phoneVerifiedAt: true,
      mfaConfirmed: true,
    },
  });
  if (
    !user.active ||
    !user.emailVerifiedAt ||
    !user.phoneVerifiedAt ||
    !user.mfaConfirmed
  )
    throw new Error("VERIFIED_MFA_ACCOUNT_REQUIRED");
}

export async function listOrganisations(actor: Actor, cursor?: string) {
  const user = await db.user.findUnique({
    where: { id: actor.id },
    select: { active: true },
  });
  if (!user?.active || actor.apiPropertyId) throw new Error("UNAUTHENTICATED");
  // A platform operator may provision and inspect configuration metadata only.
  // It receives no automatic property, financial, document or resident grants.
  const operator = await db.platformGrant.findUnique({
    where: { userId: actor.id },
  });
  const rows = await db.organisation.findMany({
    where: operator
      ? {}
      : {
          OR: [
            { memberships: { some: { userId: actor.id } } },
            {
              properties: {
                some: { memberships: { some: { userId: actor.id } } },
              },
            },
            {
              properties: {
                some: { applications: { some: { userId: actor.id } } },
              },
            },
          ],
        },
    select: publicSelection,
    orderBy: { id: "asc" },
    ...(cursor ? { cursor: { id: idSchema.parse(cursor) }, skip: 1 } : {}),
    take: 51,
  });
  return {
    data: rows.slice(0, 50),
    nextCursor: rows.length > 50 ? rows[49].id : null,
  };
}

export async function getOrganisation(actor: Actor, organisationId: string) {
  await permitOrganisation(actor, organisationId);
  return db.organisation.findUniqueOrThrow({
    where: { id: organisationId },
    select: publicSelection,
  });
}

export async function createOrganisation(actor: Actor, input: unknown) {
  const data = z
    .object({
      name: z.string().trim().min(3).max(120),
      slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,79}$/),
      legalEntity: z.string().trim().min(3).max(150),
      adminUserId: idSchema,
      residencyRegion: z.string().trim().min(2).max(100).optional(),
    })
    .parse(input);
  return transaction(async (tx) => {
    const operator = await tx.platformGrant.findUnique({
      where: { userId: actor.id },
    });
    if (!operator || actor.apiPropertyId)
      throw new Error("PLATFORM_OPERATOR_REQUIRED");
    await verifiedStaff(tx, actor.id);
    await verifiedStaff(tx, data.adminUserId);
    const { adminUserId, ...fields } = data;
    const organisation = await tx.organisation.create({
      data: {
        ...fields,
        memberships: { create: { userId: adminUserId, role: "ADMIN" } },
      },
      select: publicSelection,
    });
    await tx.session.deleteMany({ where: { userId: adminUserId } });
    await event(tx, actor.id, null, "organisation.created", organisation.id, {
      organisationId: organisation.id,
    });
    return organisation;
  });
}

export async function organisationProperties(
  actor: Actor,
  organisationId: string,
  cursor?: string,
) {
  await permitOrganisation(actor, organisationId);
  let admin = false;
  try {
    await permitOrganisation(actor, organisationId, "admin");
    admin = true;
  } catch {
    /* Members retain only their individual property metadata access. */
  }
  const { withTenant } = await import("../lib/tenant-context");
  const rows = await withTenant(actor, organisationId, (tx) =>
    tx.property.findMany({
      where: {
        organisationId,
        ...(admin
          ? {}
          : {
              OR: [
                { memberships: { some: { userId: actor.id } } },
                { applications: { some: { userId: actor.id } } },
              ],
            }),
      },
      select: {
        id: true,
        organisationId: true,
        name: true,
        slug: true,
        description: true,
        location: true,
        legalEntity: true,
        currency: true,
        published: true,
      },
      orderBy: { id: "asc" },
      ...(cursor ? { cursor: { id: idSchema.parse(cursor) }, skip: 1 } : {}),
      take: 51,
    }),
  );
  return {
    data: rows.slice(0, 50),
    nextCursor: rows.length > 50 ? rows[49].id : null,
  };
}

const settingsSchema = z
  .object({
    name: z.string().trim().min(3).max(120),
    legalEntity: z.string().trim().min(3).max(150),
    branding: z
      .object({
        displayName: z.string().trim().min(2).max(120),
        primaryColour: z.string().regex(/^#[a-f0-9]{6}$/i),
        supportEmail: z.string().email().max(200).optional(),
      })
      .strict(),
    residencyRegion: z.string().trim().min(2).max(100),
    retentionPolicy: z
      .object({
        policyReference: z.string().trim().min(3).max(200),
        noticeVersion: z.string().trim().min(1).max(100),
      })
      .strict(),
  })
  .strict();
export async function updateOrganisation(
  actor: Actor,
  organisationId: string,
  input: unknown,
) {
  const data = settingsSchema.parse(input);
  return transaction(async (tx) => {
    await permitOrganisation(actor, organisationId, "admin", tx);
    await verifiedStaff(tx, actor.id);
    const organisation = await tx.organisation.update({
      where: { id: organisationId },
      data,
      select: publicSelection,
    });
    await event(
      tx,
      actor.id,
      null,
      "organisation.settings_updated",
      organisationId,
      { organisationId, changed: Object.keys(data) },
    );
    return organisation;
  });
}

const credentialsSchema = z
  .object({
    integrationId: z.string().trim().min(1).max(100),
    integrationKey: z.string().trim().min(8).max(256),
    currency: z.string().regex(/^[A-Z]{3}$/),
  })
  .strict();
export type OrganisationPaynowCredentials = z.infer<typeof credentialsSchema>;
export async function configureOrganisationPaynow(
  actor: Actor,
  organisationId: string,
  input: unknown,
) {
  const data = z
    .object({
      mode: z.enum(["disabled", "live"]),
      credentials: credentialsSchema.optional(),
    })
    .strict()
    .parse(input);
  return transaction(async (tx) => {
    await permitOrganisation(actor, organisationId, "admin", tx);
    await verifiedStaff(tx, actor.id);
    const existing = await tx.organisation.findUniqueOrThrow({
      where: { id: organisationId },
      select: { paymentCredentialsEncrypted: true },
    });
    if (
      data.mode === "live" &&
      !data.credentials &&
      !existing.paymentCredentialsEncrypted
    )
      throw new Error("MERCHANT_CREDENTIALS_REQUIRED");
    await tx.organisation.update({
      where: { id: organisationId },
      data: {
        paymentMode: data.mode,
        ...(data.credentials
          ? {
              paymentCredentialsEncrypted: encrypt(
                JSON.stringify(data.credentials),
              ),
            }
          : {}),
      },
    });
    await event(
      tx,
      actor.id,
      null,
      "organisation.payment_configured",
      organisationId,
      {
        organisationId,
        mode: data.mode,
        credentialUpdated: !!data.credentials,
      },
    );
    return {
      mode: data.mode,
      configured: !!(data.credentials || existing.paymentCredentialsEncrypted),
    };
  });
}

/** Server-only adapter boundary. Never return this result from an API or log it. */
export async function organisationPaynowConfiguration(propertyId: string) {
  const organisationId = await organisationForProperty(propertyId);
  const organisation = await db.organisation.findUniqueOrThrow({
    where: { id: organisationId },
    select: { paymentMode: true, paymentCredentialsEncrypted: true },
  });
  return {
    organisationId,
    mode: organisation.paymentMode,
    credentials: organisation.paymentCredentialsEncrypted
      ? credentialsSchema.parse(
          JSON.parse(
            decrypt(organisation.paymentCredentialsEncrypted).toString(),
          ),
        )
      : null,
  };
}

export async function grantOrganisationMembership(
  actor: Actor,
  organisationId: string,
  userId: string,
  role: "ADMIN" | "MEMBER",
) {
  role = z.enum(["ADMIN", "MEMBER"]).parse(role);
  return transaction(async (tx) => {
    await permitOrganisation(actor, organisationId, "admin", tx);
    await verifiedStaff(tx, actor.id);
    await verifiedStaff(tx, userId);
    const membership = await tx.organisationMembership.upsert({
      where: { organisationId_userId_role: { organisationId, userId, role } },
      create: { organisationId, userId, role },
      update: {},
    });
    await tx.session.deleteMany({ where: { userId } });
    await event(
      tx,
      actor.id,
      null,
      "organisation.membership_granted",
      membership.id,
      { organisationId, userId, role },
    );
    return membership;
  });
}

export async function revokeOrganisationMembership(
  actor: Actor,
  id: string,
  reason: string,
) {
  reason = z.string().trim().min(10).max(2000).parse(reason);
  return transaction(async (tx) => {
    const membership = await tx.organisationMembership.findUniqueOrThrow({
      where: { id },
    });
    await permitOrganisation(actor, membership.organisationId, "admin", tx);
    await verifiedStaff(tx, actor.id);
    if (
      membership.role === "ADMIN" &&
      (await tx.organisationMembership.count({
        where: { organisationId: membership.organisationId, role: "ADMIN" },
      })) <= 1
    )
      throw new Error("LAST_ORGANISATION_ADMIN_REQUIRED");
    await tx.organisationMembership.delete({ where: { id } });
    await tx.session.deleteMany({ where: { userId: membership.userId } });
    await tx.apiKey.updateMany({
      where: {
        userId: membership.userId,
        propertyId: {
          in: (
            await tx.property.findMany({
              where: { organisationId: membership.organisationId },
              select: { id: true },
            })
          ).map((p) => p.id),
        },
      },
      data: { active: false },
    });
    await event(
      tx,
      actor.id,
      null,
      "organisation.membership_revoked",
      membership.id,
      {
        organisationId: membership.organisationId,
        userId: membership.userId,
        reason,
      },
    );
  });
}
