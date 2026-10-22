import { testConnector } from "../integrations";
import { requestTenancyChange, reviewTenancyChange } from "./tenancy";
import { z } from "zod";
import { db, transaction } from "../lib/db";
import { type Actor, permit, permitClientAdmin } from "./access";
import { event } from "./events";
import {
  reserve,
  acceptWaitlist,
  joinWaitlist,
  reviewApplication,
  reselectBed,
} from "./inventory";
import {
  issueCharge,
  proposePayment,
  reviewProof,
  refund,
  minor,
  creditCharge,
  applyAvailableCredit,
} from "./finance";
import { reviewDocument } from "./documents";
import {
  issueLease,
  submitSignedLease,
  executeLease,
  checkIn,
  checkOut,
  requestExit,
} from "./leases";
import { createTicket, updateTicket } from "./operations";
import { initiatePaynow, reconcilePaynow } from "./paynow";
import { hash } from "../lib/security";
const text = (v: unknown) => z.string().trim().min(1).max(5000).parse(v);
export async function command(
  actor: Actor,
  action: string,
  d: Record<string, unknown>,
) {
  const id = () => text(d.id),
    reason = () => text(d.reason);
  switch (action) {
    case "tenancy.request":
      return requestTenancyChange(actor, d);
    case "tenancy.review":
      return reviewTenancyChange(
        actor,
        id(),
        d.decision === "APPROVED",
        reason(),
      );
    case "connector.test":
      return testConnector(actor, text(d.propertyId), text(d.provider));
    case "consent.sis":
      return transaction(async (tx) => {
        const purpose = "SIS_EXCHANGE";
        await tx.consent.create({
          data: {
            userId: actor.id,
            purpose,
            version: "v1",
            documentHash: hash(
              "I authorize institution-only registration metadata exchange with my property admissions team.",
            ),
          },
        });
        await event(tx, actor.id, null, "consent.sis_recorded", actor.id);
      });
    case "privacy.review":
      return transaction(async (tx) => {
        await permitClientAdmin(actor, tx);
        const r = await tx.privacyRequest.findUniqueOrThrow({
          where: { id: id() },
        });
        const state = z
          .enum(["IN_REVIEW", "ON_HOLD", "DECLINED"])
          .parse(d.state);
        await tx.privacyRequest.update({
          where: { id: r.id },
          data: { state, resolution: reason() },
        });
        await event(
          tx,
          actor.id,
          null,
          "privacy.reviewed",
          r.id,
          { state, reason: reason() },
          r.userId,
        );
      });
    case "property.create": {
      const data = z
        .object({
          name: z.string().min(3).max(120),
          slug: z.string().regex(/^[a-z0-9-]+$/),
          legalEntity: z.string().min(3).max(150),
          description: z.string().min(20).max(3000),
          location: z.string().min(3).max(200),
          currency: z.enum(["USD", "ZWG"]),
          deposit: z.string(),
          holdMinutes: z.coerce.number().int().min(5).max(1440),
        })
        .parse(d);
      return transaction(async (tx) => {
        await permitClientAdmin(actor, tx);
        const { deposit, ...fields } = data;
        const p = await tx.property.create({
          data: { ...fields, depositMinor: minor(deposit) },
        });
        await tx.membership.create({
          data: { userId: actor.id, propertyId: p.id, role: "ADMIN" },
        });
        await event(tx, actor.id, p.id, "property.created", p.id);
        return p;
      });
    }
    case "property.publish":
      return transaction(async (tx) => {
        await permit(actor, text(d.propertyId), "settings", tx);
        if (d.approved !== "on")
          throw new Error("CLIENT_CONTENT_APPROVAL_REQUIRED");
        if (
          !(await tx.bed.count({
            where: {
              room: { floor: { building: { propertyId: text(d.propertyId) } } },
            },
          }))
        )
          throw new Error("ADD_VERIFIED_INVENTORY_FIRST");
        await tx.property.update({
          where: { id: text(d.propertyId) },
          data: { published: true },
        });
        await event(
          tx,
          actor.id,
          text(d.propertyId),
          "property.published",
          text(d.propertyId),
          { clientContentApproved: true },
        );
      });
    case "privacy.request":
      return db.privacyRequest.create({
        data: {
          userId: actor.id,
          type: z
            .enum(["ACCESS", "EXPORT", "CORRECTION", "ERASURE"])
            .parse(d.type),
          reason: reason(),
        },
      });
    case "preferences":
      return db.notificationPreference.upsert({
        where: { userId: actor.id },
        create: {
          userId: actor.id,
          email: d.email === "on",
          sms: d.sms === "on",
        },
        update: { email: d.email === "on", sms: d.sms === "on" },
      });
    case "reserve":
      return reserve(actor, {
        ...d,
        consent: d.consent === true || d.consent === "on",
        termsVersion: "application-policy-v1",
      });
    case "waitlist.accept":
      return acceptWaitlist(
        actor,
        id(),
        d.consent === true || d.consent === "on",
      );
    case "waitlist":
      return joinWaitlist(actor, d);
    case "waitlist.priority":
      return transaction(async (tx) => {
        const w = await tx.waitlist.findUniqueOrThrow({ where: { id: id() } });
        await permit(actor, w.propertyId, "admissions", tx);
        const priority = z.coerce
          .number()
          .int()
          .min(0)
          .max(10)
          .parse(d.priority);
        await tx.waitlist.update({ where: { id: w.id }, data: { priority } });
        await event(
          tx,
          actor.id,
          w.propertyId,
          "waitlist.priority_changed",
          w.id,
          { priority, reason: reason() },
        );
      });
    case "reselect":
      return reselectBed(actor, id(), text(d.bedId));
    case "application.withdraw":
      return transaction(async (tx) => {
        const a = await tx.application.findUniqueOrThrow({
          where: { id: id() },
          include: { lease: true },
        });
        if (a.userId !== actor.id)
          await permit(actor, a.propertyId, "admissions", tx);
        if (a.status === "ACTIVE" || a.lease?.executedAt)
          throw new Error("USE_EXIT_WORKFLOW");
        await tx.application.update({
          where: { id: a.id },
          data: {
            status: "WITHDRAWN",
            history: {
              create: {
                actorId: actor.id,
                status: "WITHDRAWN",
                reason: reason(),
              },
            },
          },
        });
        await tx.reservation.updateMany({
          where: { applicationId: a.id, state: { in: ["HOLD", "CONFIRMED"] } },
          data: { state: "CANCELLED" },
        });
        await event(
          tx,
          actor.id,
          a.propertyId,
          "application.withdrawn",
          a.id,
          {
            reason: reason(),
            depositDisposition: "REQUIRES_FINANCE_POLICY_REVIEW",
          },
          a.userId,
        );
      });
    case "application.review":
      return reviewApplication(
        actor,
        id(),
        z.enum(["APPROVED", "DECLINED"]).parse(d.decision),
        reason(),
      );
    case "document.retry":
      return transaction(async (tx) => {
        const doc = await tx.document.findUniqueOrThrow({
          where: { id: id() },
        });
        await permit(
          actor,
          doc.propertyId,
          doc.kind === "MEDICAL"
            ? "medical"
            : doc.kind === "PAYMENT_PROOF"
              ? "finance"
              : doc.kind === "SIGNED_LEASE"
                ? "leases"
                : "kyc",
          tx,
        );
        if (doc.state !== "SCAN_FAILED")
          throw new Error("RETRY_REQUIRES_SCAN_FAILURE");
        await tx.document.update({
          where: { id: doc.id },
          data: {
            state: "QUARANTINED",
            scanAttempts: 0,
            nextScanAt: new Date(),
            reason: reason(),
          },
        });
        await event(
          tx,
          actor.id,
          doc.propertyId,
          "document.scan_retried",
          doc.id,
          { reason: reason() },
          doc.userId,
        );
      });
    case "document.review":
      return reviewDocument(actor, id(), d.decision === "APPROVED", reason());
    case "credit.apply":
      return applyAvailableCredit(actor, text(d.userId), text(d.propertyId));
    case "credit":
      return creditCharge(
        actor,
        id(),
        text(d.amount),
        reason(),
        text(d.reference),
      );
    case "charge":
      return issueCharge(actor, d);
    case "payment": {
      const payment = await proposePayment(actor, d);
      if (payment.method === "PAYNOW")
        return { redirect: await initiatePaynow(actor, payment.id) };
      return payment;
    }
    case "proof.review":
      return reviewProof(
        actor,
        id(),
        z.enum(["APPROVE", "REJECT"]).parse(d.decision),
        reason(),
      );
    case "payment.reconcile": {
      const p = await db.payment.findUniqueOrThrow({ where: { id: id() } });
      await permit(actor, p.propertyId, "finance");
      return reconcilePaynow(p.id);
    }
    case "refund":
      return refund(actor, id(), text(d.amount), reason(), text(d.reference));
    case "lease.issue":
      return issueLease(actor, text(d.applicationId), text(d.templateId));
    case "lease.sign":
      return submitSignedLease(
        actor,
        id(),
        text(d.documentId),
        d.consent === true || d.consent === "on",
      );
    case "lease.execute":
      return executeLease(actor, id(), reason());
    case "checkin":
      return checkIn(actor, id());
    case "checkout":
      return checkOut(actor, id(), reason());
    case "exit":
      return requestExit(actor, id(), reason());
    case "ticket":
      return createTicket(actor, d);
    case "ticket.update":
      return updateTicket(actor, id(), d);
    case "profile": {
      const data = z
        .object({
          emergencyName: z.string().min(2).max(120),
          emergencyPhone: z.string().regex(/^\+[1-9]\d{7,14}$/),
        })
        .parse(d);
      await transaction(async (tx) => {
        await tx.user.update({ where: { id: actor.id }, data });
        await event(tx, actor.id, null, "profile.updated", actor.id);
      });
      return;
    }
    case "sessions.revoke":
      return transaction(async (tx) => {
        await tx.session.deleteMany({ where: { userId: actor.id } });
        await event(tx, actor.id, null, "sessions.revoked", actor.id);
      });
    case "bed.block": {
      const b = await db.bed.findUniqueOrThrow({
        where: { id: id() },
        include: {
          room: { include: { floor: { include: { building: true } } } },
        },
      });
      await transaction(async (tx) => {
        const p = b.room.floor.building.propertyId;
        await permit(actor, p, "inventory", tx);
        await tx.$queryRaw`SELECT id FROM "Bed" WHERE id=${b.id} FOR UPDATE`;
        const blocked = d.blocked === "true" || d.blocked === true;
        if (
          blocked &&
          (await tx.reservation.count({
            where: {
              bedId: b.id,
              state: { in: ["ACTIVE", "CONFIRMED", "HOLD"] },
            },
          }))
        )
          throw new Error("BED_HAS_ACTIVE_COMMITMENTS");
        await tx.bed.update({ where: { id: b.id }, data: { blocked } });
        await event(
          tx,
          actor.id,
          p,
          blocked ? "bed.blocked" : "bed.released",
          b.id,
          { reason: reason() },
        );
      });
      return;
    }
    case "membership": {
      const data = z
        .object({
          propertyId: z.string(),
          userId: z.string(),
          role: z.enum([
            "ADMIN",
            "ADMISSIONS",
            "FINANCE",
            "PROPERTY_MANAGER",
            "CARETAKER",
            "KYC",
            "MEDICAL_REVIEWER",
            "AUDITOR",
          ]),
        })
        .parse(d);
      return transaction(async (tx) => {
        await permit(actor, data.propertyId, "settings", tx);
        const u = await tx.user.findUniqueOrThrow({
          where: { id: data.userId },
        });
        if (!u.mfaConfirmed) throw new Error("STAFF_MUST_ENROLL_MFA_FIRST");
        const m = await tx.membership.upsert({
          where: { userId_propertyId_role: data },
          create: data,
          update: {},
        });
        await event(tx, actor.id, data.propertyId, "permission.granted", m.id, {
          role: data.role,
        });
        return m;
      });
    }
    case "api_key.revoke":
      return transaction(async (tx) => {
        const k = await tx.apiKey.findUniqueOrThrow({ where: { id: id() } });
        await permit(actor, k.propertyId, "settings", tx);
        await tx.apiKey.update({
          where: { id: k.id },
          data: { active: false },
        });
        await event(tx, actor.id, k.propertyId, "api_key.revoked", k.id);
      });
    case "membership.revoke": {
      return transaction(async (tx) => {
        const m = await tx.membership.findUniqueOrThrow({
          where: { id: id() },
        });
        await permit(actor, m.propertyId, "settings", tx);
        if (m.userId === actor.id && m.role === "ADMIN")
          throw new Error("CANNOT_REVOKE_OWN_ADMIN_GRANT");
        await tx.membership.delete({ where: { id: m.id } });
        await tx.session.deleteMany({ where: { userId: m.userId } });
        await event(tx, actor.id, m.propertyId, "permission.revoked", m.id, {
          role: m.role,
        });
      });
    }
    case "template": {
      const data = z
        .object({
          propertyId: z.string(),
          title: z.string().min(3).max(120),
          body: z.string().min(100).max(30000),
          legalApproval: z.literal("on"),
        })
        .parse(d);
      return transaction(async (tx) => {
        await permit(actor, data.propertyId, "settings", tx);
        const last = await tx.leaseTemplate.findFirst({
          where: { propertyId: data.propertyId },
          orderBy: { version: "desc" },
        });
        const t = await tx.leaseTemplate.create({
          data: {
            propertyId: data.propertyId,
            title: data.title,
            body: data.body,
            hash: hash(data.body),
            version: (last?.version || 0) + 1,
            approvedAt: new Date(),
            approvedBy: actor.id,
          },
        });
        await event(tx, actor.id, data.propertyId, "template.approved", t.id, {
          version: t.version,
          hash: t.hash,
        });
        return t;
      });
    }
    case "announcement": {
      const data = z
        .object({
          propertyId: z.string(),
          title: z.string().min(3).max(120),
          body: z.string().min(5).max(3000),
        })
        .parse(d);
      return transaction(async (tx) => {
        await permit(actor, data.propertyId, "operations", tx);
        const a = await tx.announcement.create({ data });
        await event(
          tx,
          actor.id,
          data.propertyId,
          "announcement.published",
          a.id,
        );
        return a;
      });
    }
    case "rateplan": {
      const data = z
        .object({
          propertyId: z.string(),
          roomId: z.preprocess(
            (v) => (v === "" ? undefined : v),
            z.string().optional(),
          ),
          bedId: z.preprocess(
            (v) => (v === "" ? undefined : v),
            z.string().optional(),
          ),
          title: z.string().min(3).max(100),
          startAt: z.coerce.date(),
          endAt: z.coerce.date(),
          minNights: z.coerce.number().int().min(1).max(732),
          priority: z.coerce.number().int().min(0).max(100),
          amount: z.string(),
        })
        .parse(d);
      if (data.endAt <= data.startAt) throw new Error("INVALID_RATE_DATES");
      return transaction(async (tx) => {
        await permit(actor, data.propertyId, "inventory", tx);
        if (data.bedId) {
          const bed = await tx.bed.findUniqueOrThrow({
            where: { id: data.bedId },
            include: {
              room: { include: { floor: { include: { building: true } } } },
            },
          });
          if (bed.room.floor.building.propertyId !== data.propertyId)
            throw new Error("FORBIDDEN");
        }
        if (data.roomId) {
          const room = await tx.room.findUniqueOrThrow({
            where: { id: data.roomId },
            include: { floor: { include: { building: true } } },
          });
          if (room.floor.building.propertyId !== data.propertyId)
            throw new Error("FORBIDDEN");
        }
        const { amount, ...fields } = data;
        const plan = await tx.ratePlan.create({
          data: {
            ...fields,
            roomId: data.roomId || null,
            bedId: data.bedId || null,
            monthlyMinor: minor(amount),
          },
        });
        await event(
          tx,
          actor.id,
          data.propertyId,
          "pricing.rule_created",
          plan.id,
          { title: data.title },
        );
        return plan;
      });
    }
    case "inventory.add": {
      const data = z
        .object({
          propertyId: z.string(),
          building: z.string().min(1).max(80),
          floor: z.string().min(1).max(80),
          level: z.coerce.number().int().min(-5).max(100),
          room: z.string().min(1).max(40),
          category: z.enum(["SINGLE", "SHARED", "PREMIUM", "ACCESSIBLE"]),
          beds: z.coerce.number().int().min(1).max(10),
          monthly: z.string(),
        })
        .parse(d);
      return transaction(async (tx) => {
        await permit(actor, data.propertyId, "inventory", tx);
        const building = await tx.building.upsert({
          where: {
            propertyId_name: {
              propertyId: data.propertyId,
              name: data.building,
            },
          },
          update: {},
          create: { propertyId: data.propertyId, name: data.building },
        });
        const floor = await tx.floor.upsert({
          where: {
            buildingId_level: { buildingId: building.id, level: data.level },
          },
          update: {},
          create: {
            buildingId: building.id,
            level: data.level,
            name: data.floor,
          },
        });
        const room = await tx.room.create({
          data: {
            floorId: floor.id,
            name: data.room,
            category: data.category,
            accessible: data.category === "ACCESSIBLE",
            monthlyMinor: minor(data.monthly),
            beds: {
              create: Array.from({ length: data.beds }, (_, i) => ({
                label: `Space ${i + 1}`,
              })),
            },
          },
        });
        await event(
          tx,
          actor.id,
          data.propertyId,
          "inventory.created",
          room.id,
        );
        return room;
      });
    }
    case "job.retry": {
      return transaction(async (tx) => {
        const job = await tx.outboxEvent.findUniqueOrThrow({
          where: { id: id() },
        });
        if (!job.propertyId)
          throw new Error("IDENTITY_JOBS_REQUIRE_SECURE_OPERATOR_RECOVERY");
        await permit(actor, job.propertyId, "settings", tx);
        await tx.outboxEvent.update({
          where: { id: job.id },
          data: {
            state: "PENDING",
            attempts: 0,
            availableAt: new Date(),
            lockedAt: null,
          },
        });
        await event(tx, actor.id, job.propertyId, "job.retried", job.id);
      });
    }
    default:
      throw new Error("UNKNOWN_COMMAND");
  }
}
