import { quoteBed, priceJson } from "./pricing";
import { APPLICATION_POLICY_VERSION, APPLICATION_POLICY } from "./policies";
import { z } from "zod";
import { transaction, type Tx } from "../lib/db";
import { type Actor, permit } from "./access";
import { event } from "./events";
import { hash } from "../lib/security";
export const datesSchema = z
  .object({ startAt: z.coerce.date(), endAt: z.coerce.date() })
  .refine(
    (v) =>
      v.startAt < v.endAt &&
      v.endAt.getTime() - v.startAt.getTime() <= 2 * 366 * 86400000,
    { message: "Select a valid stay of up to two years" },
  );
async function acceptPublishedTenancyConditions(
  tx: Tx,
  userId: string,
  propertyId: string,
  acceptedHash?: string,
) {
  const template = await tx.leaseTemplate.findFirst({
    where: { propertyId, approvedAt: { not: null } },
    orderBy: { version: "desc" },
  });
  if (!template) return;
  const fingerprint = hash(template.body);
  if (acceptedHash !== fingerprint)
    throw new Error("TENANCY_TERMS_CHANGED_REVIEW_AND_RETRY");
  await tx.consent.create({
    data: {
      userId,
      purpose: "TENANCY_CONDITIONS",
      version: `template-${template.id}-v${template.version}`,
      documentHash: fingerprint,
    },
  });
}
export async function reserve(actor: Actor, input: unknown) {
  const data = z
    .object({
      bedId: z.string(),
      startAt: z.coerce.date(),
      endAt: z.coerce.date(),
      consent: z.literal(true),
      termsVersion: z.string().min(1),
      tenancyTermsHash: z.string().optional(),
      expectedPriceMinor: z.string().regex(/^\d+$/).optional(),
      idempotencyKey: z.string().min(12).max(120).optional(),
    })
    .parse(input);
  datesSchema.parse(data);
  if (data.termsVersion !== APPLICATION_POLICY_VERSION)
    throw new Error("POLICY_VERSION_MISMATCH");
  return transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${actor.id}, 0))`;
    const user = await tx.user.findUniqueOrThrow({ where: { id: actor.id } });
    if (!user.active) throw new Error("UNAUTHENTICATED");
    if (!user.emailVerifiedAt || !user.phoneVerifiedAt)
      throw new Error("VERIFY_EMAIL_AND_PHONE");
    if (data.idempotencyKey) {
      const previous = await tx.reservation.findUnique({
        where: { idempotencyKey: data.idempotencyKey },
        include: { application: true },
      });
      if (previous) {
        if (
          previous.userId !== actor.id ||
          previous.bedId !== data.bedId ||
          previous.startAt.getTime() !== data.startAt.getTime() ||
          previous.endAt.getTime() !== data.endAt.getTime() ||
          !previous.application
        )
          throw new Error("IDEMPOTENCY_CONFLICT");
        const { application, ...reservation } = previous;
        return { application, reservation };
      }
    }
    if (data.startAt.getTime() < Date.now() - 86400000)
      throw new Error("START_DATE_IN_PAST");
    const bed = await tx.bed.findUniqueOrThrow({
      where: { id: data.bedId },
      include: {
        room: {
          include: {
            floor: { include: { building: { include: { property: true } } } },
          },
        },
      },
    });
    const property = bed.room.floor.building.property;
    if (
      !property.published ||
      bed.blocked ||
      !(
        await tx.organisation.findUnique({
          where: { id: property.organisationId },
          select: { active: true },
        })
      )?.active
    )
      throw new Error("BED_UNAVAILABLE");
    await acceptPublishedTenancyConditions(
      tx,
      actor.id,
      property.id,
      data.tenancyTermsHash,
    );
    await tx.$queryRaw`SELECT id FROM "Bed" WHERE id=${bed.id} FOR UPDATE`;
    await tx.reservation.updateMany({
      where: { bedId: bed.id, state: "HOLD", expiresAt: { lte: new Date() } },
      data: { state: "EXPIRED" },
    });
    const overlap = await tx.reservation.count({
      where: {
        bedId: bed.id,
        state: { in: ["HOLD", "CONFIRMED", "ACTIVE", "BLOCKED"] },
        startAt: { lt: data.endAt },
        endAt: { gt: data.startAt },
      },
    });
    if (overlap) throw new Error("BED_UNAVAILABLE");
    const activeApplication = await tx.application.findFirst({
      where: {
        userId: actor.id,
        propertyId: property.id,
        status: { notIn: ["DECLINED", "WITHDRAWN", "ENDED"] },
      },
    });
    if (activeApplication) throw new Error("EXISTING_APPLICATION");
    const application = await tx.application.create({
      data: {
        userId: actor.id,
        propertyId: property.id,
        history: { create: { actorId: actor.id, status: "SUBMITTED" } },
      },
    });
    await tx.consent.create({
      data: {
        userId: actor.id,
        purpose: "APPLICATION",
        version: data.termsVersion,
        documentHash: hash(APPLICATION_POLICY),
      },
    });
    const quote = await quoteBed(tx, bed.id, data.startAt, data.endAt);
    if (data.expectedPriceMinor && quote.totalMinor !== data.expectedPriceMinor)
      throw new Error("PRICE_CHANGED_REVIEW_AND_RETRY");
    const priceSnapshot = priceJson(quote);
    const reservation = await tx.reservation.create({
      data: {
        userId: actor.id,
        propertyId: property.id,
        bedId: bed.id,
        applicationId: application.id,
        idempotencyKey: data.idempotencyKey,
        priceSnapshot,
        startAt: data.startAt,
        endAt: data.endAt,
        expiresAt: new Date(Date.now() + property.holdMinutes * 60000),
      },
    });
    await event(
      tx,
      actor.id,
      property.id,
      "application.submitted",
      application.id,
      {},
      actor.id,
    );
    return { application, reservation };
  });
}
export async function expireHolds() {
  return transaction(async (tx) => {
    const expired = await tx.reservation.findMany({
      where: { state: "HOLD", expiresAt: { lte: new Date() } },
      take: 200,
    });
    for (const hold of expired) {
      const changed = await tx.reservation.updateMany({
        where: { id: hold.id, state: "HOLD", expiresAt: { lte: new Date() } },
        data: { state: "EXPIRED" },
      });
      if (changed.count) {
        await event(
          tx,
          "worker",
          hold.propertyId,
          "hold.expired",
          hold.id,
          {},
          hold.userId,
        );
        const offered = await tx.waitlist.updateMany({
          where: { offeredReservationId: hold.id, state: "OFFERED" },
          data: { state: "EXPIRED" },
        });
        if (offered.count && hold.applicationId)
          await tx.application.update({
            where: { id: hold.applicationId },
            data: { status: "WITHDRAWN" },
          });
      }
    }
    return expired.length;
  });
}
export async function joinWaitlist(actor: Actor, input: unknown) {
  const data = z
    .object({
      propertyId: z.string(),
      startAt: z.coerce.date(),
      endAt: z.coerce.date(),
    })
    .parse(input);
  datesSchema.parse(data);
  return transaction(async (tx) => {
    const user = await tx.user.findUniqueOrThrow({ where: { id: actor.id } });
    if (!user.emailVerifiedAt || !user.phoneVerifiedAt)
      throw new Error("VERIFY_EMAIL_AND_PHONE");
    const p = await tx.property.findUniqueOrThrow({
      where: { id: data.propertyId },
    });
    if (!p.published) throw new Error("NOT_AVAILABLE");
    const entry = await tx.waitlist.upsert({
      where: { userId_propertyId_startAt_endAt: { userId: actor.id, ...data } },
      create: { userId: actor.id, ...data },
      update: {},
    });
    await event(tx, actor.id, p.id, "waitlist.joined", entry.id, {}, actor.id);
    return entry;
  });
}
export async function reviewApplication(
  actor: Actor,
  id: string,
  decision: "APPROVED" | "DECLINED",
  reason: string,
) {
  return transaction(async (tx) => {
    const a = await tx.application.findUniqueOrThrow({
      where: { id },
      include: { documents: true, reservations: true },
    });
    await permit(actor, a.propertyId, "admissions", tx);
    if (a.assignedReviewerId && a.assignedReviewerId !== actor.id)
      throw new Error("ASSIGNED_ADMISSIONS_REVIEWER_REQUIRED");
    if (!["SUBMITTED", "DOCUMENTS_PENDING", "IN_REVIEW"].includes(a.status))
      throw new Error("INVALID_APPLICATION_TRANSITION");
    if (!reason.trim()) throw new Error("REASON_REQUIRED");
    let approvalStatus = "DEPOSIT_PENDING";
    if (decision === "APPROVED") {
      const user = await tx.user.findUniqueOrThrow({ where: { id: a.userId } });
      const required = [
        "IDENTITY",
        "RESIDENCE",
        ...(user.residentType === "STUDENT" ? ["REGISTRATION"] : []),
      ];
      if (
        required.some(
          (kind) =>
            a.documents
              .filter((d) => d.kind === kind)
              .sort((x, y) => y.version - x.version)[0]?.state !== "APPROVED",
        )
      )
        throw new Error("KYC_INCOMPLETE");
      const hold = a.reservations.find(
        (r) => r.state === "HOLD" && r.expiresAt! > new Date(),
      );
      if (!hold) throw new Error("HOLD_EXPIRED_RESELECT_BED");
      // Reservation remains bounded until deposit is confirmed. Approval alone never allocates a bed.
      const property = await tx.property.findUniqueOrThrow({
        where: { id: a.propertyId },
      });
      if (property.depositMinor > 0n)
        await tx.charge.create({
          data: {
            userId: a.userId,
            propertyId: a.propertyId,
            reference: `DEP-${a.id}`,
            category: "DEPOSIT",
            description: "Reservation deposit",
            amountMinor: property.depositMinor,
            currency: property.currency,
            dueAt: hold.expiresAt!,
          },
        });
      if (property.depositMinor === 0n) {
        approvalStatus = "LEASE_SIGNING_PENDING";
        await tx.reservation.update({
          where: { id: hold.id },
          data: { state: "CONFIRMED", expiresAt: null },
        });
      }
    } else
      await tx.reservation.updateMany({
        where: { applicationId: id, state: "HOLD" },
        data: { state: "CANCELLED" },
      });
    await tx.application.update({
      where: { id },
      data: {
        status: decision === "APPROVED" ? approvalStatus : "DECLINED",
        decisionReason: reason,
        history: { create: { actorId: actor.id, status: decision, reason } },
      },
    });
    await event(
      tx,
      actor.id,
      a.propertyId,
      `application.${decision.toLowerCase()}`,
      id,
      { reason },
      a.userId,
    );
  });
}
export async function reselectBed(
  actor: Actor,
  applicationId: string,
  bedId: string,
) {
  return transaction(async (tx) => {
    const a = await tx.application.findUniqueOrThrow({
      where: { id: applicationId },
    });
    if (a.userId !== actor.id)
      await permit(actor, a.propertyId, "admissions", tx);
    if (["DECLINED", "WITHDRAWN", "ACTIVE", "ENDED"].includes(a.status))
      throw new Error("INVALID_APPLICATION_TRANSITION");
    const previous = await tx.reservation.findFirstOrThrow({
      where: { applicationId },
      orderBy: { createdAt: "desc" },
    });
    if (["CONFIRMED", "ACTIVE"].includes(previous.state))
      throw new Error("USE_LEASE_TRANSFER");
    const bed = await tx.bed.findUniqueOrThrow({
      where: { id: bedId },
      include: {
        room: {
          include: {
            floor: { include: { building: { include: { property: true } } } },
          },
        },
      },
    });
    if (bed.blocked || bed.room.floor.building.propertyId !== a.propertyId)
      throw new Error("BED_UNAVAILABLE");
    await tx.$queryRaw`SELECT id FROM "Bed" WHERE id=${bedId} FOR UPDATE`;
    await tx.reservation.updateMany({
      where: { bedId, state: "HOLD", expiresAt: { lte: new Date() } },
      data: { state: "EXPIRED" },
    });
    await tx.reservation.updateMany({
      where: { applicationId, state: "HOLD" },
      data: { state: "CANCELLED" },
    });
    const hold = await tx.reservation.create({
      data: {
        userId: a.userId,
        propertyId: a.propertyId,
        applicationId,
        bedId,
        priceSnapshot: priceJson(
          await quoteBed(tx, bedId, previous.startAt, previous.endAt),
        ),
        startAt: previous.startAt,
        endAt: previous.endAt,
        expiresAt: new Date(
          Date.now() + bed.room.floor.building.property.holdMinutes * 60000,
        ),
      },
    });
    if (a.status === "DEPOSIT_PENDING") {
      const { account } = await import("./finance");
      const totals = await account(a.userId, a.propertyId, tx);
      if (
        totals.lines.some((c) => c.category === "DEPOSIT") &&
        totals.lines
          .filter((c) => c.category === "DEPOSIT")
          .every((c) => c.remaining === 0n)
      ) {
        await tx.reservation.update({
          where: { id: hold.id },
          data: { state: "CONFIRMED", expiresAt: null },
        });
        await tx.application.update({
          where: { id: a.id },
          data: { status: "LEASE_SIGNING_PENDING" },
        });
      }
    }
    await event(
      tx,
      actor.id,
      a.propertyId,
      "hold.reselected",
      hold.id,
      {},
      a.userId,
    );
    return hold;
  });
}

export async function offerWaitlist() {
  const { db } = await import("../lib/db");
  let offers = 0;
  let cursor: { priority: number; createdAt: Date; id: string } | undefined;
  // Keyset pages preserve priority/FIFO order even as earlier entries leave WAITING.
  // A full property must not monopolise the first page on every worker cycle.
  while (true) {
    const entries = await db.waitlist.findMany({
      where: {
        state: "WAITING",
        ...(cursor
          ? {
              OR: [
                { priority: { lt: cursor.priority } },
                {
                  priority: cursor.priority,
                  createdAt: { gt: cursor.createdAt },
                },
                {
                  priority: cursor.priority,
                  createdAt: cursor.createdAt,
                  id: { gt: cursor.id },
                },
              ],
            }
          : {}),
      },
      orderBy: [{ priority: "desc" }, { createdAt: "asc" }, { id: "asc" }],
      take: 50,
    });
    for (const entry of entries) {
      try {
        const offered = await transaction(async (tx) => {
          const e = await tx.waitlist.findUniqueOrThrow({
            where: { id: entry.id },
            include: { property: true, user: true },
          });
          if (
            e.state !== "WAITING" ||
            !e.property.published ||
            !e.user.active ||
            !e.user.emailVerifiedAt ||
            !e.user.phoneVerifiedAt ||
            e.endAt <= new Date()
          )
            return false;
          if (
            await tx.application.count({
              where: {
                userId: e.userId,
                propertyId: e.propertyId,
                status: { notIn: ["DECLINED", "WITHDRAWN", "ENDED"] },
              },
            })
          )
            return false;
          const candidates = await tx.bed.findMany({
            where: {
              blocked: false,
              room: { floor: { building: { propertyId: e.propertyId } } },
              // Filter occupied beds before applying the page bound. Recheck after
              // locking below because a concurrent reservation can win meanwhile.
              reservations: {
                none: {
                  state: { in: ["HOLD", "CONFIRMED", "ACTIVE", "BLOCKED"] },
                  startAt: { lt: e.endAt },
                  endAt: { gt: e.startAt },
                },
              },
            },
            take: 100,
            orderBy: { id: "asc" },
          });
          for (const bed of candidates) {
            await tx.$queryRaw`SELECT id FROM "Bed" WHERE id=${bed.id} FOR UPDATE`;
            if (
              await tx.reservation.count({
                where: {
                  bedId: bed.id,
                  state: { in: ["HOLD", "CONFIRMED", "ACTIVE", "BLOCKED"] },
                  startAt: { lt: e.endAt },
                  endAt: { gt: e.startAt },
                },
              })
            )
              continue;
            const hold = await tx.reservation.create({
              data: {
                userId: e.userId,
                propertyId: e.propertyId,
                bedId: bed.id,
                priceSnapshot: priceJson(
                  await quoteBed(tx, bed.id, e.startAt, e.endAt),
                ),
                startAt: e.startAt,
                endAt: e.endAt,
                expiresAt: new Date(
                  Date.now() + e.property.holdMinutes * 60000,
                ),
              },
            });
            await tx.waitlist.update({
              where: { id: e.id },
              data: { state: "OFFERED", offeredReservationId: hold.id },
            });
            await event(
              tx,
              "waitlist-worker",
              e.propertyId,
              "waitlist.offered",
              hold.id,
              { expiresAt: hold.expiresAt!.toISOString() },
              e.userId,
            );
            return true;
          }
          return false;
        });
        if (offered) offers++;
      } catch {
        /* Another worker or concurrent booking won; the next cycle retries the waiting entry. */
      }
    }
    if (entries.length < 50) break;
    const last = entries.at(-1)!;
    cursor = {
      priority: last.priority,
      createdAt: last.createdAt,
      id: last.id,
    };
  }
  return offers;
}

export async function acceptWaitlist(
  actor: Actor,
  id: string,
  consent: boolean,
  tenancyTermsHash?: string,
) {
  if (!consent) throw new Error("CONSENT_REQUIRED");
  return transaction(async (tx) => {
    const entry = await tx.waitlist.findUniqueOrThrow({ where: { id } });
    if (
      entry.userId !== actor.id ||
      entry.state !== "OFFERED" ||
      !entry.offeredReservationId
    )
      throw new Error("WAITLIST_OFFER_INVALID");
    const hold = await tx.reservation.findUniqueOrThrow({
      where: { id: entry.offeredReservationId },
    });
    await acceptPublishedTenancyConditions(
      tx,
      actor.id,
      entry.propertyId,
      tenancyTermsHash,
    );
    if (
      hold.state !== "HOLD" ||
      !hold.expiresAt ||
      hold.expiresAt <= new Date()
    )
      throw new Error("HOLD_EXPIRED");
    if (
      await tx.application.count({
        where: {
          userId: actor.id,
          propertyId: entry.propertyId,
          status: { notIn: ["DECLINED", "WITHDRAWN", "ENDED"] },
        },
      })
    )
      throw new Error("EXISTING_APPLICATION");
    const app = await tx.application.create({
      data: {
        userId: actor.id,
        propertyId: entry.propertyId,
        status: "SUBMITTED",
        history: { create: { actorId: actor.id, status: "WAITLIST_ACCEPTED" } },
      },
    });
    await tx.reservation.update({
      where: { id: hold.id },
      data: { applicationId: app.id },
    });
    await tx.waitlist.update({ where: { id }, data: { state: "ACCEPTED" } });
    await tx.consent.create({
      data: {
        userId: actor.id,
        purpose: "APPLICATION",
        version: APPLICATION_POLICY_VERSION,
        documentHash: hash(APPLICATION_POLICY),
      },
    });
    await event(
      tx,
      actor.id,
      entry.propertyId,
      "application.submitted",
      app.id,
      { fromWaitlist: id },
      actor.id,
    );
    return app;
  });
}
