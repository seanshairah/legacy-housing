const knownErrors = new Set([
  "DELIVERY_FAILED",
  "OPERATION_FAILED",
  "WORKER_CYCLE_FAILED",
  "PROVIDER_TIMEOUT",
  "EMAIL_PROVIDER_NOT_CONFIGURED",
  "SMS_PROVIDER_NOT_CONFIGURED",
  "EMAIL_DELIVERY_FAILED",
  "SMS_DELIVERY_FAILED",
  "UNSUPPORTED_NOTIFICATION_TEMPLATE_VERSION",
  "APP_URL_REQUIRES_HTTPS",
  "INVALID_IDENTITY_NOTIFICATION",
  "ANNOUNCEMENT_SCOPE_MISMATCH",
  "PAYNOW_NOT_CONFIGURED",
  "PAYNOW_SIGNATURE_INVALID",
  "PAYNOW_RESPONSE_MISMATCH",
  "PAYNOW_PAYMENT_MISMATCH",
  "PAYNOW_READY_FOR_CREDENTIALS",
  "PUBLIC_HTTPS_URL_REQUIRED",
  "MERCHANT_CURRENCY_MUST_BE_VERIFIED",
  "PROVIDER_UNAVAILABLE",
  "PROVIDER_RESPONSE_LIMIT",
  "PROVIDER_INITIATION_UNVERIFIED",
  "PROVIDER_CONFIRMATION_MISMATCH",
  "PRIOR_INITIATION_REQUIRES_RECONCILIATION",
  "POLL_URL_REQUIRED",
  "UNTRUSTED_PROVIDER_URL",
  "INVALID_WEBHOOK_SIGNATURE",
  "UNKNOWN_PAYMENT",
  "INVALID_PAYMENT",
  "ORGANISATION_INACTIVE",
  "DATA_KEY_REQUIRES_32_BYTE_HEX_KEY",
  "FILE_KEY_REQUIRES_32_BYTE_HEX_KEY",
  "DOCUMENT_INTEGRITY_FAILED",
  "SCANNER_TIMEOUT",
  "SCANNER_INVALID_RESPONSE",
  "VALIDATOR_UNAVAILABLE_OR_RESOURCE_LIMIT",
]);
export function operationalErrorCode(
  error: unknown,
  fallback = "DELIVERY_FAILED",
) {
  if (error instanceof Error && knownErrors.has(error.message))
    return error.message;
  if (
    error instanceof Error &&
    ["TimeoutError", "AbortError"].includes(error.name)
  )
    return "PROVIDER_TIMEOUT";
  return knownErrors.has(fallback) ? fallback : "OPERATION_FAILED";
}
type OperationalFields = {
  jobId?: string;
  type?: string;
  propertyId?: string | null;
  attempt?: number;
  outcome?:
    "delivered" | "retry" | "dead" | "recovered" | "failed" | "consumed";
  errorCode?: string;
  count?: number;
  durationMs?: number;
  templateVersion?: number;
  traceId?: string;
};
export function operationalLog(
  event: string,
  fields: OperationalFields = {},
  level: "info" | "error" = "info",
) {
  const safeLevel = level === "error" ? "error" : "info";
  const record: Record<string, string | number | null> = {
    timestamp: new Date().toISOString(),
    level: safeLevel,
    event: /^[a-z][a-z0-9_.]{1,80}$/.test(event) ? event : "operation.unknown",
  };
  for (const name of ["jobId", "propertyId", "traceId"] as const) {
    const value = fields[name];
    if (value === null) record[name] = null;
    else if (value && /^[A-Za-z0-9:_-]{1,100}$/.test(value))
      record[name] = value;
  }
  if (fields.type && /^[a-z][a-z0-9_.]{1,100}$/.test(fields.type))
    record.type = fields.type;
  if (
    fields.outcome &&
    ["delivered", "retry", "dead", "recovered", "failed", "consumed"].includes(
      fields.outcome,
    )
  )
    record.outcome = fields.outcome;
  if (fields.errorCode && knownErrors.has(fields.errorCode))
    record.errorCode = fields.errorCode;
  for (const name of [
    "attempt",
    "count",
    "durationMs",
    "templateVersion",
  ] as const) {
    const value = fields[name];
    if (Number.isSafeInteger(value) && value! >= 0) record[name] = value!;
  }
  if (
    process.env.NODE_ENV !== "test" ||
    process.env.LEGACY_LOG_TESTS === "true"
  ) {
    if (safeLevel === "error") console.error(JSON.stringify(record));
    else console.log(JSON.stringify(record));
  }
  return record;
}
