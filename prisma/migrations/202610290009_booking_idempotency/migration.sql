ALTER TABLE "Reservation" ADD COLUMN "idempotencyKey" TEXT;
CREATE UNIQUE INDEX "Reservation_idempotencyKey_key" ON "Reservation"("idempotencyKey");
CREATE FUNCTION protect_reservation_idempotency() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."idempotencyKey" IS NOT NULL AND NEW."idempotencyKey" IS DISTINCT FROM OLD."idempotencyKey" THEN RAISE EXCEPTION 'RESERVATION_IDEMPOTENCY_IMMUTABLE'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER immutable_reservation_idempotency BEFORE UPDATE ON "Reservation" FOR EACH ROW EXECUTE FUNCTION protect_reservation_idempotency();
CREATE INDEX "ApplicationReviewNote_applicationId_createdAt_idx" ON "ApplicationReviewNote"("applicationId","createdAt");
-- A departed reviewer must not prevent an otherwise valid withdrawal or stage
-- transition. Validate assignment only when the assignment itself changes.
CREATE OR REPLACE FUNCTION protect_application_review_assignment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND NEW."assignedReviewerId" IS NOT DISTINCT FROM OLD."assignedReviewerId" AND NEW."propertyId" IS NOT DISTINCT FROM OLD."propertyId" THEN RETURN NEW; END IF;
  IF NEW."assignedReviewerId" IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM "User" u JOIN "Membership" m ON m."userId"=u.id
    WHERE u.id=NEW."assignedReviewerId" AND u.active AND m."propertyId"=NEW."propertyId" AND m.role IN ('ADMIN','ADMISSIONS')
  ) THEN RAISE EXCEPTION 'ADMISSIONS_REVIEWER_REQUIRED'; END IF;
  RETURN NEW;
END;
$$;
