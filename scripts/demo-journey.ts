import { PDFDocument, StandardFonts } from "pdf-lib";
import { db } from "../src/lib/db";
import { reserve, reviewApplication } from "../src/domain/inventory";
import { upload, scanDocument, reviewDocument } from "../src/domain/documents";
import { proposePayment, reviewProof } from "../src/domain/finance";
import {
  issueLease,
  submitSignedLease,
  executeLease,
  checkIn,
} from "../src/domain/leases";
import { createTicket } from "../src/domain/operations";
if (
  process.env.LOCAL_DEMO !== "true" ||
  process.env.NODE_ENV === "production" ||
  !process.env.DATABASE_URL?.includes("/legacy_dev")
)
  throw new Error("LOCAL_DEMO_ONLY");
const user = await db.user.findUniqueOrThrow({
    where: { email: "resident@demo.legacy.invalid" },
  }),
  admin = await db.user.findUniqueOrThrow({
    where: { email: "admin@demo.legacy.invalid" },
  }),
  finance = await db.user.findUniqueOrThrow({
    where: { email: "finance@demo.legacy.invalid" },
  }),
  property = await db.property.findUniqueOrThrow({
    where: { slug: "demo-residence-1" },
  });
const bed = await db.bed.findFirstOrThrow({
  where: { room: { floor: { building: { propertyId: property.id } } } },
  orderBy: { id: "asc" },
});
async function document(kind: string) {
  const old = await db.document.findFirst({
    where: { userId: user.id, propertyId: property.id, kind },
  });
  if (old) return old;
  const p = await PDFDocument.create(),
    page = p.addPage(),
    font = await p.embedFont(StandardFonts.Helvetica);
  page.drawText(
    `SYNTHETIC DEVELOPMENT ${kind}. NOT A REAL ID, BANK PROOF OR LEGAL LEASE.`,
    { x: 25, y: 700, size: 9, font },
  );
  const d = await upload(user, {
    propertyId: property.id,
    kind,
    filename: `demonstration-${kind}.pdf`,
    bytes: Buffer.from(await p.save()),
  });
  await scanDocument(d.id);
  return d;
}
let application = await db.application.findFirst({
  where: { userId: user.id, propertyId: property.id },
});
if (!application)
  application = (
    await reserve(user, {
      bedId: bed.id,
      startAt: new Date(new Date().toISOString().slice(0, 10)),
      endAt: new Date(Date.now() + 90 * 86400000),
      consent: true,
      termsVersion: "application-policy-v1",
    })
  ).application;
for (const kind of ["IDENTITY", "RESIDENCE"]) {
  const d = await document(kind);
  const current = await db.document.findUniqueOrThrow({ where: { id: d.id } });
  if (current.state === "CLEAN")
    await reviewDocument(
      admin,
      d.id,
      true,
      "Synthetic fixture checked; not genuine identity evidence",
    );
}
if (application.status === "SUBMITTED")
  await reviewApplication(
    admin,
    application.id,
    "APPROVED",
    "Development fixture only",
  );
let payment = await db.payment.findFirst({
  where: { idempotencyKey: `demo-payment-${application.id}` },
});
if (!payment) {
  const proof = await document("PAYMENT_PROOF");
  payment = await proposePayment(user, {
    propertyId: property.id,
    userId: user.id,
    amount: "30.00",
    method: "BANK",
    proofDocumentId: proof.id,
    bankReference: `SYNTHETIC-NO-FUNDS-${application.id}`,
    idempotencyKey: `demo-payment-${application.id}`,
  });
}
if (payment.status === "PROOF_REVIEW")
  await reviewProof(
    finance,
    payment.id,
    "APPROVE",
    "SYNTHETIC LOCAL FIXTURE. No money moved; demonstration posting only.",
  );
let lease = await db.lease.findUnique({
  where: { applicationId: application.id },
});
if (!lease) {
  const template = await db.leaseTemplate.findFirstOrThrow({
    where: { propertyId: property.id, version: 1 },
  });
  lease = await issueLease(admin, application.id, template.id);
}
if (lease.status === "AWAITING_SIGNATURE") {
  const signed = await document("SIGNED_LEASE");
  await submitSignedLease(user, lease.id, signed.id, true);
}
lease = await db.lease.findUniqueOrThrow({ where: { id: lease.id } });
if (lease.status === "REVIEW")
  await executeLease(
    admin,
    lease.id,
    "Synthetic signed development copy only; no legal effect",
  );
const reservation = await db.reservation.findUniqueOrThrow({
  where: { id: lease.reservationId },
});
if (reservation.state === "CONFIRMED") await checkIn(admin, lease.id);
if (!(await db.ticket.count({ where: { userId: user.id } })))
  await createTicket(user, {
    propertyId: property.id,
    type: "MAINTENANCE",
    category: "General",
    priority: "NORMAL",
    subject: "Demo: room orientation request",
    body: "Synthetic support request for exploring the resident and staff workflows.",
  });
console.log(
  "Synthetic demonstration journey prepared through KYC, bank proof, agreement review, check-in, and support. No real funds or legal agreement involved.",
);
await db.$disconnect();
