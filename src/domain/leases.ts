import { db, transaction } from "../lib/db";
import { type Actor, permit, ownerOrPermit } from "./access";
import { hash } from "../lib/security";
import { event } from "./events";
import { account } from "./finance";
export async function issueLease(
  actor: Actor,
  applicationId: string,
  templateId: string,
) {
  return transaction(async (tx) => {
    const a = await tx.application.findUniqueOrThrow({
      where: { id: applicationId },
      include: {
        reservations: {
          include: {
            bed: {
              include: {
                room: { include: { floor: { include: { building: true } } } },
              },
            },
          },
        },
        user: true,
        property: true,
      },
    });
    await permit(actor, a.propertyId, "leases", tx);
    if (a.status !== "LEASE_SIGNING_PENDING")
      throw new Error("APPLICATION_NOT_READY_FOR_LEASE");
    const depositAccount = await account(a.userId, a.propertyId, tx);
    if (
      depositAccount.lines.some(
        (c) => c.category === "DEPOSIT" && c.remaining > 0n,
      )
    )
      throw new Error("DEPOSIT_REQUIRED");
    const reservation = a.reservations.find((r) => r.state === "CONFIRMED");
    if (!reservation) throw new Error("CONFIRMED_RESERVATION_REQUIRED");
    const template = await tx.leaseTemplate.findUniqueOrThrow({
      where: { id: templateId },
    });
    if (template.propertyId !== a.propertyId || !template.approvedAt)
      throw new Error("APPROVED_TEMPLATE_REQUIRED");
    const snapshot = JSON.stringify({
      version: template.version,
      terms: template.body,
      electronicSigningDisclosure: template.signingDisclosure || null,
      resident: a.user.name,
      property: a.property.name,
      legalEntity: a.property.legalEntity,
      location: a.property.location,
      space: `${reservation.bed.room.floor.building.name} / ${reservation.bed.room.floor.name} / Room ${reservation.bed.room.name} / ${reservation.bed.label}`,
      reservationId: reservation.id,
      startAt: reservation.startAt.toISOString(),
      endAt: reservation.endAt.toISOString(),
      pricing: reservation.priceSnapshot,
    });
    const lease = await tx.lease.create({
      data: {
        userId: a.userId,
        propertyId: a.propertyId,
        applicationId,
        reservationId: reservation.id,
        templateId,
        documentSnapshot: snapshot,
        documentHash: hash(snapshot),
        events: {
          create: {
            actorId: actor.id,
            type: "ISSUED",
            evidence: { hash: hash(snapshot) },
          },
        },
      },
    });
    await event(
      tx,
      actor.id,
      a.propertyId,
      "lease.issued",
      lease.id,
      {},
      a.userId,
    );
    return lease;
  });
}
export async function submitSignedLease(
  actor: Actor,
  leaseId: string,
  documentId: string,
  consent: boolean,
) {
  if (!consent) throw new Error("CONSENT_REQUIRED");
  return transaction(async (tx) => {
    const lease = await tx.lease.findUniqueOrThrow({ where: { id: leaseId } });
    if (lease.userId !== actor.id || lease.status !== "AWAITING_SIGNATURE")
      throw new Error("LEASE_SIGNATURE_DENIED");
    const doc = await tx.document.findUniqueOrThrow({
      where: { id: documentId },
    });
    if (
      doc.userId !== actor.id ||
      doc.propertyId !== lease.propertyId ||
      doc.applicationId !== lease.applicationId ||
      doc.kind !== "SIGNED_LEASE" ||
      !["CLEAN", "APPROVED"].includes(doc.state)
    )
      throw new Error("CLEAN_SIGNED_COPY_REQUIRED");
    await tx.lease.update({
      where: { id: leaseId },
      data: {
        status: "REVIEW",
        signedDocumentId: doc.id,
        signedHash: doc.hash,
        signedAt: new Date(),
      },
    });
    await tx.leaseEvent.create({
      data: {
        leaseId,
        actorId: actor.id,
        type: "SIGNED_UPLOAD",
        evidence: {
          documentId,
          hash: doc.hash,
          originalHash: lease.documentHash,
          consent: true,
        },
      },
    });
    await event(
      tx,
      actor.id,
      lease.propertyId,
      "lease.signed_upload",
      leaseId,
      {},
      actor.id,
    );
  });
}
export async function executeLease(actor: Actor, id: string, reason: string) {
  return transaction(async (tx) => {
    const l = await tx.lease.findUniqueOrThrow({ where: { id } });
    await permit(actor, l.propertyId, "leases", tx);
    if (l.userId === actor.id || l.status !== "REVIEW" || !reason.trim())
      throw new Error("LEASE_NOT_READY");
    const doc = await tx.document.findUniqueOrThrow({
      where: { id: l.signedDocumentId! },
    });
    if (
      doc.hash !== l.signedHash ||
      doc.scanResult !== "CLEAN" ||
      !["CLEAN", "APPROVED"].includes(doc.state)
    )
      throw new Error("SIGNED_COPY_INVALID");
    await tx.lease.update({
      where: { id },
      data: {
        status: "EXECUTED",
        executedAt: new Date(),
        approvedBy: actor.id,
      },
    });
    await tx.leaseEvent.create({
      data: {
        leaseId: id,
        actorId: actor.id,
        type: "EXECUTED",
        evidence: { signedHash: l.signedHash, reason },
      },
    });
    await tx.application.update({
      where: { id: l.applicationId },
      data: { status: "READY_FOR_MOVE_IN" },
    });
    await event(tx, actor.id, l.propertyId, "lease.executed", id, {}, l.userId);
  });
}
export async function returnSignedLease(
  actor: Actor,
  id: string,
  reason: string,
) {
  if (reason.trim().length < 10 || reason.length > 2000)
    throw new Error("REVIEW_REASON_REQUIRED");
  return transaction(async (tx) => {
    const l = await tx.lease.findUniqueOrThrow({ where: { id } });
    await permit(actor, l.propertyId, "leases", tx);
    if (l.status !== "REVIEW" || l.userId === actor.id || !l.signedDocumentId)
      throw new Error("LEASE_NOT_READY");
    await tx.leaseEvent.create({
      data: {
        leaseId: id,
        actorId: actor.id,
        type: "SIGNATURE_RETURNED",
        evidence: {
          reason,
          documentId: l.signedDocumentId,
          signedHash: l.signedHash,
        },
      },
    });
    await tx.document.update({
      where: { id: l.signedDocumentId },
      data: { state: "REJECTED", reviewerId: actor.id, reason },
    });
    await tx.leaseSigningChallenge.updateMany({
      where: { leaseId: id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    await tx.lease.update({
      where: { id },
      data: {
        status: "AWAITING_SIGNATURE",
        signedDocumentId: null,
        signedHash: null,
        signedAt: null,
      },
    });
    await event(
      tx,
      actor.id,
      l.propertyId,
      "lease.signature_returned",
      id,
      { reason },
      l.userId,
    );
  });
}
export async function checkIn(actor: Actor, id: string) {
  return transaction(async (tx) => {
    const l = await tx.lease.findUniqueOrThrow({
      where: { id },
      include: { user: true, reservation: true },
    });
    await permit(actor, l.propertyId, "operations", tx);
    if (
      l.status !== "EXECUTED" ||
      l.reservation.state !== "CONFIRMED" ||
      !l.user.emergencyName ||
      !l.user.emergencyPhone
    )
      throw new Error("MOVE_IN_REQUIREMENTS_INCOMPLETE");
    if (l.reservation.startAt > new Date() || l.reservation.endAt <= new Date())
      throw new Error("OUTSIDE_STAY_DATES");
    const totals = await account(l.userId, l.propertyId, tx);
    if (totals.lines.some((c) => c.category === "DEPOSIT" && c.remaining > 0n))
      throw new Error("DEPOSIT_REQUIRED");
    await tx.reservation.update({
      where: { id: l.reservationId },
      data: { state: "ACTIVE" },
    });
    await tx.application.update({
      where: { id: l.applicationId },
      data: { status: "ACTIVE" },
    });
    await tx.leaseEvent.create({
      data: { leaseId: id, actorId: actor.id, type: "CHECK_IN", evidence: {} },
    });
    await event(
      tx,
      actor.id,
      l.propertyId,
      "resident.checked_in",
      id,
      {},
      l.userId,
    );
  });
}
export async function requestExit(actor: Actor, id: string, reason: string) {
  const l = await db.lease.findUniqueOrThrow({ where: { id } });
  await ownerOrPermit(actor, l.userId, l.propertyId, "leases");
  if (!reason.trim()) throw new Error("REASON_REQUIRED");
  await transaction(async (tx) => {
    await tx.leaseEvent.create({
      data: {
        leaseId: id,
        actorId: actor.id,
        type: "EXIT_REQUESTED",
        evidence: { reason },
      },
    });
    await event(
      tx,
      actor.id,
      l.propertyId,
      "lease.exit_requested",
      id,
      { reason },
      l.userId,
    );
  });
}
export async function checkOut(actor: Actor, id: string, inspection: string) {
  return transaction(async (tx) => {
    const l = await tx.lease.findUniqueOrThrow({
      where: { id },
      include: { reservation: true },
    });
    await permit(actor, l.propertyId, "operations", tx);
    if (
      l.status !== "EXECUTED" ||
      l.reservation.state !== "ACTIVE" ||
      !inspection.trim()
    )
      throw new Error("CHECKOUT_INSPECTION_REQUIRED");
    await tx.reservation.update({
      where: { id: l.reservationId },
      data: { state: "ENDED" },
    });
    await tx.application.update({
      where: { id: l.applicationId },
      data: { status: "ENDED" },
    });
    await tx.bed.update({
      where: { id: l.reservation.bedId },
      data: { blocked: true },
    });
    await tx.leaseEvent.create({
      data: {
        leaseId: id,
        actorId: actor.id,
        type: "CHECK_OUT",
        evidence: { inspection, turnoverRequired: true },
      },
    });
    await event(
      tx,
      actor.id,
      l.propertyId,
      "resident.checked_out",
      id,
      { inspection },
      l.userId,
    );
  });
}
