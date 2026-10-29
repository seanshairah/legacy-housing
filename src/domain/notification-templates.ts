export const NOTIFICATION_TEMPLATE_VERSION = 1;
export function assertNotificationVersion(version: number) {
  if (version !== NOTIFICATION_TEMPLATE_VERSION)
    throw new Error("UNSUPPORTED_NOTIFICATION_TEMPLATE_VERSION");
}
const messages: Record<string, [string, string]> = {
  "application.submitted": [
    "Application received",
    "Your application was received. Review its status and required documents in your portal.",
  ],
  "application.approved": [
    "Application approved",
    "Your application has been approved. Check your portal for deposit and agreement steps.",
  ],
  "application.declined": [
    "Application decision",
    "A decision is available. Read the reason and available next steps in your portal.",
  ],
  "application.withdrawn": [
    "Application withdrawn",
    "Your application was withdrawn. Review your account and any finance follow-up in your portal.",
  ],
  "document.uploaded": [
    "Document received",
    "Your uploaded document is awaiting security scanning and review. Check the portal for its status.",
  ],
  "document.rejected": [
    "Document needs attention",
    "A document could not be accepted. Read the reason and submit a replacement through your portal.",
  ],
  "document.scanned": [
    "Document scan updated",
    "Security scanning has updated your document status. Check whether reviewer approval or resubmission is needed.",
  ],
  "kyc.approved": [
    "Document approved",
    "A reviewer approved your document. Check your application for remaining steps.",
  ],
  "kyc.rejected": [
    "Document review decision",
    "A reviewer requested replacement evidence. Read the reason before resubmitting.",
  ],
  "hold.expired": [
    "Reservation hold expired",
    "Your temporary hold expired. Select an available space before continuing your application.",
  ],
  "hold.reselected": [
    "New reservation hold",
    "A new space is temporarily held. Check the expiry and required next steps in your portal.",
  ],
  "waitlist.joined": [
    "Waiting list entry received",
    "You have joined the property waiting list. Watch your portal for a time-limited offer.",
  ],
  "waitlist.offered": [
    "Space offered",
    "A time-limited space offer is available. Review the terms and accept before it expires.",
  ],
  "invoice.issued": [
    "Invoice available",
    "A new invoice is available. Review the amount, currency and due date in your portal.",
  ],
  "payment.initiated": [
    "Payment pending verification",
    "A payment was initiated. It is pending verification; an upload or browser return does not confirm settlement.",
  ],
  "payment.settled": [
    "Payment verified",
    "Your payment was independently verified. View its receipt, allocation and current account balance in your portal.",
  ],
  "payment.refunded": [
    "Refund recorded",
    "A refund was recorded. Review the refund history and updated balance in your portal.",
  ],
  "proof.rejected": [
    "Payment evidence needs attention",
    "Your payment evidence was rejected. Read the finance review reason before resubmitting evidence.",
  ],
  "credit.applied": [
    "Account credit allocated",
    "Verified available credit was allocated to your invoices. Review the updated statement in your portal.",
  ],
  "lease.issued": [
    "Agreement ready to review",
    "Your agreement is ready. Read the exact terms and follow the signing steps in your portal.",
  ],
  "lease.signed_upload": [
    "Signed agreement received",
    "Your uploaded agreement is awaiting independent review. Check the portal before planning move-in.",
  ],
  "lease.signed_electronically": [
    "Electronic signature recorded",
    "Your electronic signature was recorded. Independent agreement execution review is still required.",
  ],
  "lease.executed": [
    "Agreement executed",
    "Your agreement has been executed. Review the move-in instructions and keep your signed copy.",
  ],
  "lease.signature_returned": [
    "Agreement signature needs attention",
    "Your signed copy was returned for correction. Read the review reason and sign the required replacement.",
  ],
  "lease.expiry_reminder": [
    "Agreement expiry approaching",
    "Your agreement is approaching expiry. Review renewal or departure options in your portal.",
  ],
  "lease.exit_requested": [
    "Departure request received",
    "Your departure request was received. Follow the inspection and finance instructions in your portal.",
  ],
  "resident.checked_in": [
    "Move-in recorded",
    "Your move-in was recorded. Use the portal for your account, agreements and accommodation support.",
  ],
  "resident.checked_out": [
    "Move-out recorded",
    "Your move-out was recorded. Review any outstanding account or deposit follow-up in your portal.",
  ],
  "tenancy.change_requested": [
    "Tenancy request received",
    "Your renewal or transfer request is awaiting review. Your current agreement remains on record.",
  ],
  "tenancy.change_approved": [
    "Tenancy change approved",
    "Your request was approved. Review and sign the new agreement before treating the change as complete.",
  ],
  "tenancy.change_declined": [
    "Tenancy change decision",
    "Your tenancy request was declined. Read the review reason and discuss options through the portal.",
  ],
  "service_request.created": [
    "Support request received",
    "Your service request was received. Follow its assignment, responses and status in your portal.",
  ],
  "service_request.updated": [
    "Support request updated",
    "Your service request has an update. Read the response and confirm resolution or reopen if necessary.",
  ],
  "service_request.sla_escalated": [
    "Service request escalated",
    "An overdue service request has been escalated for review. Check its current status in your portal.",
  ],
  "announcement.available": [
    "New property notice",
    "A new notice is available for your property. Read the complete notice in your portal.",
  ],
  "identity.mfa_enabled": [
    "Authenticator enabled",
    "An authenticator was enabled for your account. Keep recovery codes secure and review any unrecognised activity.",
  ],
  "identity.mfa_recovered": [
    "Authenticator recovery completed",
    "Authenticator recovery ended all sessions. Enroll a replacement before accessing staff tools. Report unrecognised activity.",
  ],
  "identity.mfa_recovery_codes_replaced": [
    "Recovery codes replaced",
    "Your authenticator recovery codes were replaced and sessions ended. Report this immediately if you did not request it.",
  ],
  "identity.invitation_accepted": [
    "Staff invitation accepted",
    "A staff invitation was accepted. Sign in again with your authenticator to use the granted role.",
  ],
};
export function notificationTemplate(
  type: string,
  version: number,
  appUrl: string,
) {
  assertNotificationVersion(version);
  const url = new URL(appUrl);
  if (
    url.username ||
    url.password ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1"].includes(url.hostname)
      ))
  )
    throw new Error("APP_URL_REQUIRES_HTTPS");
  const portal = new URL("/portal", url).toString();
  const known = Object.hasOwn(messages, type);
  const [subject, instruction] = (known ? messages[type] : undefined) || [
    "Accommodation update",
    "Your accommodation record was updated. Review the details in your portal.",
  ];
  return {
    id: known ? type : "accommodation.update",
    version,
    subject: `Legacy Heights: ${subject}`,
    email: `${instruction} Sign in at ${portal}. No private documents are included in this message.`,
    sms: `Legacy Heights: ${subject}. Sign in at ${portal} for details.`,
  };
}
export function identityNotification(
  type: string,
  version: number,
  code: string,
) {
  assertNotificationVersion(version);
  if (
    !["identity.email", "identity.phone", "identity.reset"].includes(type) ||
    !/^[A-Za-z0-9_-]{8,100}$/.test(code)
  )
    throw new Error("INVALID_IDENTITY_NOTIFICATION");
  return {
    subject:
      type === "identity.reset"
        ? "Legacy Heights account recovery"
        : "Legacy Heights account verification",
    email: `Enter this single-use code on the verification page: ${code}`,
    sms: `Legacy Heights verification: ${code}`,
  };
}
