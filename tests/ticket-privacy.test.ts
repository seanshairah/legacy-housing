import { afterAll, afterEach, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { PDFDocument } from "pdf-lib";
import { db } from "../src/lib/db";
import {
  createTicket,
  getTicketThread,
  updateTicket,
} from "../src/domain/operations";
import { download, scanDocument, upload } from "../src/domain/documents";
import { assertTestDatabase } from "./safety";
import { GET } from "../src/app/api/v1/[resource]/route";
const auth = vi.hoisted(() => ({ id: "" }));
vi.mock("../src/lib/current-user", () => ({
  currentUser: async () => (auth.id ? { id: auth.id } : null),
}));
assertTestDatabase();
process.env.DATA_KEY ||= randomBytes(32).toString("hex");
process.env.FILE_KEY ||= randomBytes(32).toString("hex");
const previousStorage = process.env.STORAGE_ROOT;
process.env.STORAGE_ROOT = ".data/ticket-test-private";
afterEach(() => {
  auth.id = "";
});
afterAll(async () => {
  if (previousStorage === undefined) delete process.env.STORAGE_ROOT;
  else process.env.STORAGE_ROOT = previousStorage;
  await db.$disconnect();
});
async function fixture() {
  const run = randomUUID();
  const property = await db.property.create({
    data: {
      name: "Synthetic ticket privacy",
      slug: `ticket-${run}`,
      description: "Synthetic privacy regression fixture",
      location: "Test only",
    },
  });
  const roles = [
    "RESIDENT",
    "CARETAKER",
    "MAINTENANCE_OFFICER",
    "FINANCE",
    "OTHER",
  ] as const;
  const people: Record<string, { id: string }> = {};
  for (const role of roles) {
    people[role] = await db.user.create({
      data: {
        name: `Synthetic ${role}`,
        email: `ticket-${run}-${role}@example.invalid`,
        phone: `ticket-${run}-${role}`,
        passwordHash: "not-used-by-this-test",
        emailVerifiedAt: new Date(),
        phoneVerifiedAt: new Date(),
      },
    });
    if (!["RESIDENT", "OTHER"].includes(role))
      await db.membership.create({
        data: { userId: people[role].id, propertyId: property.id, role },
      });
  }
  await db.application.create({
    data: {
      propertyId: property.id,
      userId: people.RESIDENT.id,
      status: "ACTIVE",
    },
  });
  const ticket = await createTicket(people.RESIDENT, {
    propertyId: property.id,
    type: "SUPPORT",
    category: "Synthetic privacy",
    priority: "NORMAL",
    subject: "Synthetic private-note test",
    body: "Synthetic support request, not real personal data.",
  });
  return { property, ticket, people };
}
it("staff internal notes remain private, do not count as public response, and do not notify the resident", async () => {
  const f = await fixture(),
    privateText = "SYNTHETIC INTERNAL STAFF DISCUSSION";
  const before = await db.notification.count({
    where: { userId: f.people.RESIDENT.id },
  });
  await updateTicket(f.people.CARETAKER, f.ticket.id, {
    status: "OPEN",
    body: privateText,
    internal: "on",
  });
  const ticket = await db.ticket.findUniqueOrThrow({
    where: { id: f.ticket.id },
    include: { messages: true },
  });
  expect(ticket.status).toBe("OPEN");
  expect(ticket.firstResponseAt).toBeNull();
  expect(ticket.resolvedAt).toBeNull();
  expect(ticket.messages[0].internal).toBe(true);
  expect(ticket.messages[0].body).toBe(privateText);
  expect(
    await db.notification.count({ where: { userId: f.people.RESIDENT.id } }),
  ).toBe(before);
  const audit = await db.auditEvent.findFirstOrThrow({
    where: {
      action: "service_request.internal_note_added",
      objectId: f.ticket.id,
    },
  });
  const outbox = await db.outboxEvent.findFirstOrThrow({
    where: { traceId: audit.traceId },
  });
  expect(outbox.userId).toBeNull();
  expect(JSON.stringify([audit, outbox])).not.toContain(privateText);
  await updateTicket(f.people.MAINTENANCE_OFFICER, f.ticket.id, {
    status: "IN_PROGRESS",
    body: "Public response from assigned maintenance officer",
    assignedTo: f.people.MAINTENANCE_OFFICER.id,
  });
  expect(
    (await db.ticket.findUniqueOrThrow({ where: { id: f.ticket.id } }))
      .firstResponseAt,
  ).not.toBeNull();
});
it("resident, finance-only staff and foreign-property staff cannot create or read internal notes", async () => {
  const f = await fixture(),
    foreign = await fixture();
  for (const actor of [
    f.people.RESIDENT,
    f.people.FINANCE,
    foreign.people.CARETAKER,
  ]) {
    await expect(
      updateTicket(actor, f.ticket.id, {
        status: "OPEN",
        body: "Forged private-note request",
        internal: true,
      }),
    ).rejects.toThrow("FORBIDDEN");
    await expect(getTicketThread(actor, f.ticket.id, true)).rejects.toThrow(
      "FORBIDDEN",
    );
  }
  await expect(
    updateTicket(f.people.CARETAKER, f.ticket.id, {
      status: "RESOLVED",
      body: "Cannot silently resolve through a hidden note",
      internal: true,
    }),
  ).rejects.toThrow("INTERNAL_NOTE_CANNOT_CHANGE_STATE");
  await expect(
    updateTicket(f.people.CARETAKER, f.ticket.id, {
      status: "OPEN",
      body: "Cannot silently assign through a hidden note",
      assignedTo: f.people.MAINTENANCE_OFFICER.id,
      internal: true,
    }),
  ).rejects.toThrow("INTERNAL_NOTE_CANNOT_CHANGE_STATE");
  expect(
    await db.ticketMessage.count({ where: { ticketId: f.ticket.id } }),
  ).toBe(0);
});
it("resident thread and actual account-export handler omit internal bodies and attachment identifiers", async () => {
  const f = await fixture(),
    privateText = "CONFIDENTIAL SYNTHETIC STAFF NOTE";
  await updateTicket(f.people.CARETAKER, f.ticket.id, {
    status: "OPEN",
    body: privateText,
    internal: true,
  });
  await updateTicket(f.people.CARETAKER, f.ticket.id, {
    status: "IN_PROGRESS",
    body: "Resident-visible synthetic update",
  });
  const resident = await getTicketThread(f.people.RESIDENT, f.ticket.id);
  expect(resident.messages).toHaveLength(1);
  expect(resident.messages[0].body).toBe("Resident-visible synthetic update");
  expect(
    (await getTicketThread(f.people.CARETAKER, f.ticket.id, true)).messages,
  ).toHaveLength(2);
  await expect(getTicketThread(f.people.OTHER, f.ticket.id)).rejects.toThrow(
    "FORBIDDEN",
  );
  auth.id = f.people.RESIDENT.id;
  const response = await GET(
    new Request("https://example.invalid/api/v1/me-export"),
    { params: Promise.resolve({ resource: "me-export" }) },
  );
  expect(response.status).toBe(200);
  const exported = await response.json();
  expect(exported.tickets[0].messages).toHaveLength(1);
  expect(JSON.stringify(exported)).not.toContain(privateText);
});
it("an internal staff attachment cannot be downloaded by the ticket resident even by a guessed document id", async () => {
  const f = await fixture(),
    pdf = await PDFDocument.create();
  pdf.addPage().drawText("SYNTHETIC INTERNAL ATTACHMENT");
  const document = await upload(f.people.CARETAKER, {
    propertyId: f.property.id,
    kind: "SUPPORT",
    filename: "synthetic-internal.pdf",
    bytes: Buffer.from(await pdf.save()),
  });
  await scanDocument(document.id);
  expect(
    (await db.document.findUniqueOrThrow({ where: { id: document.id } })).state,
  ).toBe("CLEAN");
  await updateTicket(f.people.CARETAKER, f.ticket.id, {
    status: "OPEN",
    body: "Internal supporting evidence",
    internal: true,
    documentId: document.id,
  });
  await expect(download(f.people.RESIDENT, document.id)).rejects.toThrow(
    "FORBIDDEN",
  );
  const own = await download(f.people.CARETAKER, document.id);
  expect(own.doc.id).toBe(document.id);
});
it("resolution needs explicit resident confirmation, preserves timestamps and tracks reopening history", async () => {
  const f = await fixture();
  await expect(
    updateTicket(f.people.RESIDENT, f.ticket.id, {
      status: "CLOSED",
      body: "Premature confirmation",
      resolutionConfirmed: true,
    }),
  ).rejects.toThrow("RESOLUTION_CONFIRMATION_REQUIRED");
  await expect(
    updateTicket(f.people.CARETAKER, f.ticket.id, {
      status: "CLOSED",
      body: "Cannot skip the resolution step",
    }),
  ).rejects.toThrow("INVALID_TICKET_TRANSITION");
  await updateTicket(f.people.CARETAKER, f.ticket.id, {
    status: "IN_PROGRESS",
    body: "Public investigation started",
  });
  await updateTicket(f.people.CARETAKER, f.ticket.id, {
    status: "RESOLVED",
    body: "Synthetic repair complete, please confirm",
  });
  const resolved = await db.ticket.findUniqueOrThrow({
    where: { id: f.ticket.id },
  });
  await expect(
    updateTicket(f.people.RESIDENT, f.ticket.id, {
      status: "CLOSED",
      body: "Missing explicit confirmation",
    }),
  ).rejects.toThrow("RESOLUTION_CONFIRMATION_REQUIRED");
  await expect(
    updateTicket(f.people.CARETAKER, f.ticket.id, {
      status: "CLOSED",
      body: "Cannot impersonate resident confirmation",
      resolutionConfirmed: true,
    }),
  ).rejects.toThrow("FORBIDDEN");
  await updateTicket(f.people.RESIDENT, f.ticket.id, {
    status: "CLOSED",
    body: "I confirm the synthetic resolution",
    resolutionConfirmed: "on",
  });
  const closed = await db.ticket.findUniqueOrThrow({
    where: { id: f.ticket.id },
  });
  expect(closed.status).toBe("CLOSED");
  expect(closed.resolutionConfirmedBy).toBe(f.people.RESIDENT.id);
  expect(closed.resolutionConfirmedAt).not.toBeNull();
  expect(closed.resolvedAt).toEqual(resolved.resolvedAt);
  await updateTicket(f.people.RESIDENT, f.ticket.id, {
    status: "CLOSED",
    body: "Repeat confirmation preserves first confirmation",
    resolutionConfirmed: true,
  });
  expect(
    (await db.ticket.findUniqueOrThrow({ where: { id: f.ticket.id } }))
      .resolutionConfirmedAt,
  ).toEqual(closed.resolutionConfirmedAt);
  await updateTicket(f.people.RESIDENT, f.ticket.id, {
    status: "OPEN",
    body: "The synthetic issue reoccurred; please reopen",
  });
  const reopened = await db.ticket.findUniqueOrThrow({
    where: { id: f.ticket.id },
  });
  expect(reopened.reopenedCount).toBe(1);
  expect(reopened.resolutionConfirmedAt).toBeNull();
  expect(reopened.resolutionConfirmedBy).toBeNull();
  expect(reopened.resolvedAt).toBeNull();
  const history = await db.auditEvent.findMany({
    where: { objectId: f.ticket.id, action: "service_request.updated" },
    orderBy: { createdAt: "asc" },
  });
  expect(
    history.some(
      (e) =>
        (e.detail as { resolutionConfirmed?: boolean }).resolutionConfirmed,
    ),
  ).toBe(true);
  expect((history.at(-1)!.detail as { reopened: boolean }).reopened).toBe(true);
});

it("a disabled resident cannot bypass service authorisation by owning the ticket", async () => {
  const f = await fixture();
  await db.user.update({
    where: { id: f.people.RESIDENT.id },
    data: { active: false },
  });
  await expect(getTicketThread(f.people.RESIDENT, f.ticket.id)).rejects.toThrow(
    "UNAUTHENTICATED",
  );
  await expect(
    updateTicket(f.people.RESIDENT, f.ticket.id, {
      status: "OPEN",
      body: "Disabled owner must not update",
    }),
  ).rejects.toThrow("UNAUTHENTICATED");
  await expect(
    createTicket(f.people.RESIDENT, {
      propertyId: f.property.id,
      type: "SUPPORT",
      category: "Synthetic",
      priority: "NORMAL",
      subject: "Disabled resident",
      body: "Disabled applicant cannot open another request",
    }),
  ).rejects.toThrow("UNAUTHENTICATED");
});
