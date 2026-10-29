import { z } from "zod";
import { db, transaction } from "../lib/db";
import { type Actor, permit } from "./access";
import { event } from "./events";
import { hash } from "../lib/security";
const idSchema = z.string().trim().min(1).max(100);
const reasonSchema = z.string().trim().min(10).max(2000);
const openReviewStates = ["SUBMITTED", "DOCUMENTS_PENDING", "IN_REVIEW"];

export async function assignApplication(
  actor: Actor,
  id: string,
  input: unknown,
) {
  id = idSchema.parse(id);
  const d = z
    .object({ reviewerId: z.string().trim().max(100), reason: reasonSchema })
    .parse(input);
  return transaction(async (tx) => {
    const application = await tx.application.findUniqueOrThrow({
      where: { id },
    });
    await permit(actor, application.propertyId, "admissions", tx);
    if (!openReviewStates.includes(application.status))
      throw new Error("APPLICATION_REVIEW_CLOSED");
    if (d.reviewerId) {
      const grant = await tx.membership.findFirst({
        where: {
          propertyId: application.propertyId,
          userId: d.reviewerId,
          role: { in: ["ADMIN", "ADMISSIONS"] },
          user: { active: true },
        },
      });
      if (!grant) throw new Error("INVALID_ADMISSIONS_REVIEWER");
    }
    if (application.assignedReviewerId === (d.reviewerId || null))
      return application;
    const updated = await tx.application.update({
      where: { id },
      data: { assignedReviewerId: d.reviewerId || null },
    });
    await tx.applicationReviewNote.create({
      data: {
        applicationId: id,
        propertyId: application.propertyId,
        actorId: actor.id,
        kind: "ASSIGNMENT",
        body: d.reason,
      },
    });
    // Assignment rationale is internal. Only identifiers and a fingerprint leave
    // the restricted notes table; residents receive no internal-review notice.
    await event(
      tx,
      actor.id,
      application.propertyId,
      "admissions.assigned",
      id,
      {
        previousReviewerId: application.assignedReviewerId,
        reviewerId: d.reviewerId || null,
        reasonHash: hash(d.reason),
      },
    );
    return updated;
  });
}
export async function addApplicationNote(
  actor: Actor,
  id: string,
  input: unknown,
) {
  id = idSchema.parse(id);
  const d = z.object({ body: z.string().trim().min(3).max(5000) }).parse(input);
  return transaction(async (tx) => {
    const application = await tx.application.findUniqueOrThrow({
      where: { id },
    });
    await permit(actor, application.propertyId, "admissions", tx);
    const note = await tx.applicationReviewNote.create({
      data: {
        applicationId: id,
        propertyId: application.propertyId,
        actorId: actor.id,
        body: d.body,
      },
    });
    await event(
      tx,
      actor.id,
      application.propertyId,
      "admissions.note_added",
      note.id,
      {
        applicationId: id,
        noteHash: hash(d.body),
      },
    );
    return note;
  });
}
export async function updateReviewStage(
  actor: Actor,
  id: string,
  input: unknown,
) {
  id = idSchema.parse(id);
  const d = z
    .object({
      stage: z.enum(["DOCUMENTS_PENDING", "IN_REVIEW"]),
      reason: reasonSchema,
    })
    .parse(input);
  return transaction(async (tx) => {
    const application = await tx.application.findUniqueOrThrow({
      where: { id },
    });
    await permit(actor, application.propertyId, "admissions", tx);
    if (!openReviewStates.includes(application.status))
      throw new Error("APPLICATION_REVIEW_CLOSED");
    if (application.status === d.stage && application.message === d.reason)
      return application;
    const updated = await tx.application.update({
      where: { id },
      data: {
        status: d.stage,
        message: d.reason,
        history: {
          create: { actorId: actor.id, status: d.stage, reason: d.reason },
        },
      },
    });
    await event(
      tx,
      actor.id,
      application.propertyId,
      "application.review_stage_changed",
      id,
      {
        previousStatus: application.status,
        status: d.stage,
      },
      application.userId,
    );
    return updated;
  });
}
const statusSchema = z.enum([
  "ALL",
  "SUBMITTED",
  "DOCUMENTS_PENDING",
  "IN_REVIEW",
  "DEPOSIT_PENDING",
  "LEASE_SIGNING_PENDING",
  "READY_FOR_MOVE_IN",
  "ACTIVE",
  "DECLINED",
  "WITHDRAWN",
  "ENDED",
]);
export async function listAdmissionsReviews(
  actor: Actor,
  propertyId: string,
  input: unknown = {},
) {
  propertyId = idSchema.parse(propertyId);
  const d = z
    .object({
      page: z.coerce.number().int().min(1).max(10000).default(1),
      status: statusSchema.default("ALL"),
      search: z.string().trim().max(80).default(""),
      assignedTo: z.string().trim().max(100).default(""),
    })
    .parse(input);
  await permit(actor, propertyId, "admissions");
  const where = {
    propertyId,
    ...(d.status !== "ALL" ? { status: d.status } : {}),
    ...(d.assignedTo ? { assignedReviewerId: d.assignedTo } : {}),
    ...(d.search
      ? { user: { name: { contains: d.search, mode: "insensitive" as const } } }
      : {}),
  };
  const [data, total, memberships] = await Promise.all([
    db.application.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (d.page - 1) * 20,
      take: 20,
      select: {
        id: true,
        status: true,
        createdAt: true,
        assignedReviewerId: true,
        message: true,
        user: { select: { id: true, name: true, email: true } },
        assignedReviewer: { select: { id: true, name: true, active: true } },
        reviewNotes: {
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: 10,
          select: {
            id: true,
            kind: true,
            body: true,
            createdAt: true,
            actor: { select: { name: true } },
          },
        },
        _count: { select: { reviewNotes: true } },
      },
    }),
    db.application.count({ where }),
    db.membership.findMany({
      where: {
        propertyId,
        role: { in: ["ADMIN", "ADMISSIONS"] },
        user: { active: true },
      },
      distinct: ["userId"],
      select: { user: { select: { id: true, name: true } } },
      orderBy: { userId: "asc" },
    }),
  ]);
  return {
    data,
    total,
    page: d.page,
    pageSize: 20,
    reviewers: memberships.map((m) => m.user),
  };
}

export async function applicationReviewNotes(
  actor: Actor,
  id: string,
  page = 1,
) {
  id = idSchema.parse(id);
  page = z.coerce.number().int().min(1).max(10000).parse(page);
  const application = await db.application.findUniqueOrThrow({
    where: { id },
    select: { propertyId: true },
  });
  await permit(actor, application.propertyId, "admissions");
  const [data, total] = await Promise.all([
    db.applicationReviewNote.findMany({
      where: { applicationId: id },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 20,
      skip: (page - 1) * 20,
      select: {
        id: true,
        kind: true,
        body: true,
        createdAt: true,
        actor: { select: { name: true } },
      },
    }),
    db.applicationReviewNote.count({ where: { applicationId: id } }),
  ]);
  return {
    applicationId: id,
    propertyId: application.propertyId,
    data,
    total,
    page,
    pageSize: 20,
  };
}
