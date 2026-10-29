import { afterAll, afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { db } from "../src/lib/db";
import {
  addApplicationNote,
  applicationReviewNotes,
  assignApplication,
  listAdmissionsReviews,
  updateReviewStage,
} from "../src/domain/admissions";
import { command } from "../src/domain/commands";
import { GET } from "../src/app/api/v1/[resource]/route";
import { assertTestDatabase } from "./safety";
import { withTenant } from "../src/lib/tenant-context";

const auth = vi.hoisted(() => ({ id: "" }));
vi.mock("../src/lib/current-user", () => ({
  currentUser: async () => (auth.id ? { id: auth.id } : null),
}));
assertTestDatabase();
afterEach(() => {
  auth.id = "";
});
afterAll(async () => {
  await db.$disconnect();
});

async function fixture(organisationId = "mipf") {
  const run = randomUUID();
  const property = await db.property.create({
    data: {
      name: "Synthetic admissions review property",
      organisationId,
      slug: `admission-${run}`,
      description: "Synthetic admissions integration test records only",
      location: "Test only",
    },
  });
  const people: Record<string, { id: string }> = {};
  for (const role of ["ADMIN", "ADMISSIONS", "FINANCE", "RESIDENT", "OTHER"]) {
    people[role] = await db.user.create({
      data: {
        name: `Synthetic ${role}`,
        email: `admission-${run}-${role}@example.invalid`,
        phone: `admission-${run}-${role}`,
        passwordHash: "not-used-by-service-tests",
        emailVerifiedAt: new Date(),
        phoneVerifiedAt: new Date(),
      },
    });
    if (["ADMIN", "ADMISSIONS", "FINANCE"].includes(role))
      await db.membership.create({
        data: {
          userId: people[role].id,
          propertyId: property.id,
          role,
        },
      });
  }
  const application = await db.application.create({
    data: {
      propertyId: property.id,
      userId: people.RESIDENT.id,
    },
  });
  return { property, people, application };
}

it("admissions assignment and append-only notes stay internal and do not notify the applicant", async () => {
  const f = await fixture(),
    reason = "SYNTHETIC INTERNAL ASSIGNMENT RATIONALE";
  const before = await db.notification.count({
    where: { userId: f.people.RESIDENT.id },
  });
  const assigned = await assignApplication(f.people.ADMIN, f.application.id, {
    reviewerId: f.people.ADMISSIONS.id,
    reason,
  });
  expect(assigned.assignedReviewerId).toBe(f.people.ADMISSIONS.id);
  const note = await addApplicationNote(f.people.ADMISSIONS, f.application.id, {
    body: "SYNTHETIC CONFIDENTIAL REVIEW NOTE",
  });
  await assignApplication(f.people.ADMIN, f.application.id, {
    reviewerId: f.people.ADMISSIONS.id,
    reason,
  });
  expect(
    await db.applicationReviewNote.count({
      where: { applicationId: f.application.id },
    }),
  ).toBe(2);
  expect(
    await db.applicationHistory.count({
      where: { applicationId: f.application.id },
    }),
  ).toBe(0);
  expect(
    await db.notification.count({ where: { userId: f.people.RESIDENT.id } }),
  ).toBe(before);
  const events = await db.auditEvent.findMany({
    where: {
      propertyId: f.property.id,
      action: { in: ["admissions.assigned", "admissions.note_added"] },
    },
  });
  const jobs = await db.outboxEvent.findMany({
    where: { traceId: { in: events.map((e) => e.traceId) } },
  });
  expect(events).toHaveLength(2);
  expect(jobs).toHaveLength(2);
  expect(jobs.every((j) => j.userId === null)).toBe(true);
  expect(JSON.stringify([events, jobs])).not.toContain(reason);
  expect(JSON.stringify([events, jobs])).not.toContain(note.body);
  await assignApplication(f.people.ADMIN, f.application.id, {
    reviewerId: "",
    reason: "Synthetic reviewer unassigned for handover",
  });
  expect(
    (
      await db.application.findUniqueOrThrow({
        where: { id: f.application.id },
      })
    ).assignedReviewerId,
  ).toBeNull();
});

it("resident, finance-only, foreign-property and disabled staff cannot read or mutate admissions reviews", async () => {
  const f = await fixture(),
    foreign = await fixture();
  const denied = [
    f.people.RESIDENT,
    f.people.FINANCE,
    foreign.people.ADMISSIONS,
    {
      ...f.people.ADMISSIONS,
      apiPropertyId: foreign.property.id,
      apiScopes: ["admissions"],
    },
  ];
  for (const actor of denied) {
    await expect(
      assignApplication(actor, f.application.id, {
        reviewerId: f.people.ADMISSIONS.id,
        reason: "Forged assignment must be denied",
      }),
    ).rejects.toThrow("FORBIDDEN");
    await expect(
      addApplicationNote(actor, f.application.id, {
        body: "Forged internal note",
      }),
    ).rejects.toThrow("FORBIDDEN");
    await expect(
      updateReviewStage(actor, f.application.id, {
        stage: "IN_REVIEW",
        reason: "Forged review stage must be denied",
      }),
    ).rejects.toThrow("FORBIDDEN");
    await expect(listAdmissionsReviews(actor, f.property.id)).rejects.toThrow(
      "FORBIDDEN",
    );
    await expect(
      applicationReviewNotes(actor, f.application.id),
    ).rejects.toThrow("FORBIDDEN");
  }
  await db.user.update({
    where: { id: f.people.ADMISSIONS.id },
    data: { active: false },
  });
  await expect(
    addApplicationNote(f.people.ADMISSIONS, f.application.id, {
      body: "Disabled reviewer note",
    }),
  ).rejects.toThrow("UNAUTHENTICATED");
  expect(
    await db.applicationReviewNote.count({
      where: { applicationId: f.application.id },
    }),
  ).toBe(0);
});

it("assignment rejects ineligible or inactive reviewers and review stages retain public next-action history", async () => {
  const f = await fixture(),
    foreign = await fixture();
  for (const reviewerId of [
    f.people.RESIDENT.id,
    f.people.FINANCE.id,
    foreign.people.ADMISSIONS.id,
  ])
    await expect(
      assignApplication(f.people.ADMIN, f.application.id, {
        reviewerId,
        reason: "Synthetic invalid reviewer assignment",
      }),
    ).rejects.toThrow("INVALID_ADMISSIONS_REVIEWER");
  await db.user.update({
    where: { id: f.people.ADMISSIONS.id },
    data: { active: false },
  });
  await expect(
    assignApplication(f.people.ADMIN, f.application.id, {
      reviewerId: f.people.ADMISSIONS.id,
      reason: "Synthetic disabled reviewer assignment",
    }),
  ).rejects.toThrow("INVALID_ADMISSIONS_REVIEWER");
  const message = "Please upload a clear synthetic proof of residence.";
  await updateReviewStage(f.people.ADMIN, f.application.id, {
    stage: "DOCUMENTS_PENDING",
    reason: message,
  });
  await updateReviewStage(f.people.ADMIN, f.application.id, {
    stage: "DOCUMENTS_PENDING",
    reason: message,
  });
  expect(
    await db.applicationHistory.count({
      where: { applicationId: f.application.id },
    }),
  ).toBe(1);
  expect(
    await db.notification.count({ where: { userId: f.people.RESIDENT.id } }),
  ).toBe(1);
  await updateReviewStage(f.people.ADMIN, f.application.id, {
    stage: "IN_REVIEW",
    reason: "Synthetic documents received; review is underway.",
  });
  const application = await db.application.findUniqueOrThrow({
    where: { id: f.application.id },
    include: { history: { orderBy: { createdAt: "asc" } } },
  });
  expect(application.status).toBe("IN_REVIEW");
  expect(application.history.map((h) => h.status)).toEqual([
    "DOCUMENTS_PENDING",
    "IN_REVIEW",
  ]);
  expect(application.history[0].reason).toBe(message);
  await db.application.update({
    where: { id: f.application.id },
    data: { status: "DEPOSIT_PENDING" },
  });
  await expect(
    updateReviewStage(f.people.ADMIN, f.application.id, {
      stage: "DOCUMENTS_PENDING",
      reason: "Cannot move an approved application backwards",
    }),
  ).rejects.toThrow("APPLICATION_REVIEW_CLOSED");
  await expect(
    assignApplication(f.people.ADMIN, f.application.id, {
      reviewerId: "",
      reason: "Cannot reassign a closed review",
    }),
  ).rejects.toThrow("APPLICATION_REVIEW_CLOSED");
});

it("database guards reject altered notes and cross-property links while preserving corrections as new notes", async () => {
  const f = await fixture(),
    foreign = await fixture();
  const original = await addApplicationNote(f.people.ADMIN, f.application.id, {
    body: "Synthetic original evidence",
  });
  await expect(
    db.applicationReviewNote.update({
      where: { id: original.id },
      data: { body: "Overwritten evidence" },
    }),
  ).rejects.toThrow();
  await expect(
    db.applicationReviewNote.delete({ where: { id: original.id } }),
  ).rejects.toThrow();
  await expect(
    db.applicationReviewNote.create({
      data: {
        applicationId: f.application.id,
        propertyId: foreign.property.id,
        actorId: foreign.people.ADMIN.id,
        body: "Foreign property reference substitution",
      },
    }),
  ).rejects.toThrow();
  await addApplicationNote(f.people.ADMIN, f.application.id, {
    body: "Correction appended to the original evidence",
  });
  expect(
    (await applicationReviewNotes(f.people.ADMIN, f.application.id)).total,
  ).toBe(2);
});

it("review and internal note histories paginate without omission and support independent filters", async () => {
  const f = await fixture();
  await db.application.createMany({
    data: Array.from({ length: 24 }, (_, n) => ({
      propertyId: f.property.id,
      userId: f.people.RESIDENT.id,
      status: n % 2 ? "IN_REVIEW" : "DOCUMENTS_PENDING",
    })),
  });
  await assignApplication(f.people.ADMIN, f.application.id, {
    reviewerId: f.people.ADMISSIONS.id,
    reason: "Synthetic assignment used for filter coverage",
  });
  const first = await listAdmissionsReviews(f.people.ADMIN, f.property.id, {
    page: 1,
  });
  const second = await listAdmissionsReviews(f.people.ADMIN, f.property.id, {
    page: 2,
  });
  expect(first.total).toBe(25);
  expect(first.data).toHaveLength(20);
  expect(second.data).toHaveLength(5);
  expect(new Set([...first.data, ...second.data].map((a) => a.id)).size).toBe(
    25,
  );
  expect(
    (
      await listAdmissionsReviews(f.people.ADMIN, f.property.id, {
        assignedTo: f.people.ADMISSIONS.id,
      })
    ).total,
  ).toBe(1);
  expect(
    (
      await listAdmissionsReviews(f.people.ADMIN, f.property.id, {
        status: "IN_REVIEW",
      })
    ).total,
  ).toBe(12);
  expect(
    (
      await listAdmissionsReviews(f.people.ADMIN, f.property.id, {
        search: "not a fixture name",
      })
    ).total,
  ).toBe(0);
  await db.applicationReviewNote.createMany({
    data: Array.from({ length: 24 }, (_, n) => ({
      applicationId: f.application.id,
      propertyId: f.property.id,
      actorId: f.people.ADMIN.id,
      body: `Synthetic retained internal note ${n}`,
    })),
  });
  const notes1 = await applicationReviewNotes(
      f.people.ADMIN,
      f.application.id,
      1,
    ),
    notes2 = await applicationReviewNotes(f.people.ADMIN, f.application.id, 2);
  expect(notes1.total).toBe(25);
  expect(notes1.data).toHaveLength(20);
  expect(notes2.data).toHaveLength(5);
  expect(new Set([...notes1.data, ...notes2.data].map((n) => n.id)).size).toBe(
    25,
  );
});

it("actual resident account-export handler excludes staff review bodies and identifiers", async () => {
  const f = await fixture(),
    secret = "CONFIDENTIAL SYNTHETIC ADMISSIONS REVIEW";
  const note = await addApplicationNote(f.people.ADMIN, f.application.id, {
    body: secret,
  });
  auth.id = f.people.RESIDENT.id;
  const response = await GET(
    new Request("https://example.invalid/api/v1/me-export"),
    { params: Promise.resolve({ resource: "me-export" }) },
  );
  expect(response.status).toBe(200);
  const text = await response.text();
  expect(text).not.toContain(secret);
  expect(text).not.toContain(note.id);
  expect(text).not.toContain("reviewNotes");
});

it("a revoked or disabled assigned reviewer cannot prevent a resident withdrawing their application", async () => {
  const f = await fixture();
  await assignApplication(f.people.ADMIN, f.application.id, {
    reviewerId: f.people.ADMISSIONS.id,
    reason: "Synthetic reviewer assigned before departure",
  });
  await db.membership.deleteMany({
    where: { userId: f.people.ADMISSIONS.id, propertyId: f.property.id },
  });
  await db.user.update({
    where: { id: f.people.ADMISSIONS.id },
    data: { active: false },
  });
  await command(f.people.RESIDENT, "application.withdraw", {
    id: f.application.id,
    reason: "Synthetic resident withdraws after assigned reviewer leaves",
  });
  expect(
    (
      await db.application.findUniqueOrThrow({
        where: { id: f.application.id },
      })
    ).status,
  ).toBe("WITHDRAWN");
});

it("restricted SQL hides review notes from residents, finance and another organisation while admitting authorised reviewers", async () => {
  const f = await fixture();
  const organisation = await db.organisation.create({
    data: {
      name: "Synthetic other admissions organisation",
      slug: `admission-org-${randomUUID()}`,
      legalEntity: "Synthetic entity",
    },
  });
  const foreign = await fixture(organisation.id);
  const note = await addApplicationNote(f.people.ADMIN, f.application.id, {
    body: "SYNTHETIC SQL-RESTRICTED ADMISSIONS NOTE",
  });
  const visible = await withTenant(f.people.ADMISSIONS, "mipf", (tx) =>
    tx.applicationReviewNote.findMany({ where: { id: note.id } }),
  );
  expect(visible).toHaveLength(1);
  for (const actor of [f.people.RESIDENT, f.people.FINANCE]) {
    const hidden = await withTenant(actor, "mipf", (tx) =>
      tx.applicationReviewNote.findMany({ where: { id: note.id } }),
    );
    expect(hidden).toHaveLength(0);
  }
  expect(
    await withTenant(foreign.people.ADMISSIONS, organisation.id, (tx) =>
      tx.applicationReviewNote.count({ where: { id: note.id } }),
    ),
  ).toBe(0);
  await expect(
    withTenant(f.people.ADMISSIONS, organisation.id, (tx) =>
      tx.applicationReviewNote.count(),
    ),
  ).rejects.toThrow("ORGANISATION_FORBIDDEN");
  await expect(
    withTenant(f.people.ADMISSIONS, "mipf", (tx) =>
      tx.applicationReviewNote.create({
        data: {
          applicationId: f.application.id,
          propertyId: f.property.id,
          actorId: f.people.ADMIN.id,
          body: "Cannot forge another reviewer identity",
        },
      }),
    ),
  ).rejects.toThrow();
});
