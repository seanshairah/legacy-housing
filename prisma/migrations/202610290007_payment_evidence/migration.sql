-- Separate manual evidence from immutable posted financial ledger records.
CREATE TABLE "PaymentEvidence" (
 id TEXT PRIMARY KEY,
 "paymentId" TEXT NOT NULL UNIQUE REFERENCES "Payment"(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
 "propertyId" TEXT NOT NULL REFERENCES "Property"(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
 "paymentDate" TIMESTAMP(3) NOT NULL,
 "bankName" TEXT,
 "accountLast4" TEXT CHECK ("accountLast4" IS NULL OR "accountLast4" ~ '^[0-9]{4}$'),
 "assignedReviewerId" TEXT REFERENCES "User"(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
 "recordedBy" TEXT NOT NULL REFERENCES "User"(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
 "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "PaymentEvidence_propertyId_assignedReviewerId_idx" ON "PaymentEvidence"("propertyId","assignedReviewerId");
CREATE TABLE "PaymentDispute" (
 id TEXT PRIMARY KEY,
 "paymentId" TEXT NOT NULL REFERENCES "Payment"(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
 "propertyId" TEXT NOT NULL REFERENCES "Property"(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
 "userId" TEXT NOT NULL REFERENCES "User"(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
 reason TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'OPEN' CHECK (state IN ('OPEN','INVESTIGATING','RESOLVED','REJECTED')),
 "reviewedBy" TEXT REFERENCES "User"(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
 resolution TEXT,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" TIMESTAMP(3) NOT NULL,
 CHECK (state='OPEN' OR ("reviewedBy" IS NOT NULL AND "reviewedBy"<>"userId" AND resolution IS NOT NULL))
);
CREATE INDEX "PaymentDispute_propertyId_state_idx" ON "PaymentDispute"("propertyId",state);
CREATE UNIQUE INDEX payment_one_open_dispute ON "PaymentDispute"("paymentId") WHERE state IN ('OPEN','INVESTIGATING');
CREATE TABLE "PaymentDisputeEvent" (
 id TEXT PRIMARY KEY,
 "disputeId" TEXT NOT NULL REFERENCES "PaymentDispute"(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
 "actorId" TEXT NOT NULL REFERENCES "User"(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
 state TEXT NOT NULL CHECK (state IN ('OPEN','INVESTIGATING','RESOLVED','REJECTED')),
 reason TEXT NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "PaymentDisputeEvent_disputeId_createdAt_idx" ON "PaymentDisputeEvent"("disputeId","createdAt");
CREATE FUNCTION protect_payment_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p "Payment"%ROWTYPE;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Payment evidence history cannot be deleted'; END IF;
 SELECT * INTO p FROM "Payment" WHERE id=NEW."paymentId" FOR UPDATE;
 IF p.id IS NULL OR p."propertyId"<>NEW."propertyId" THEN RAISE EXCEPTION 'Payment evidence property mismatch'; END IF;
 IF p.method NOT IN ('BANK','CASH') OR p.status<>'PROOF_REVIEW' OR p."settledAt" IS NOT NULL THEN RAISE EXCEPTION 'Posted payment evidence is immutable'; END IF;
 IF NEW."paymentDate"::date>(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date OR NEW."paymentDate"<'1900-01-01'::timestamp THEN RAISE EXCEPTION 'Invalid tender date'; END IF;
 IF p.method='BANK' AND (NEW."bankName" IS NULL OR length(trim(NEW."bankName"))<2) THEN RAISE EXCEPTION 'Bank name required'; END IF;
 IF p.method='CASH' AND (NEW."bankName" IS NOT NULL OR NEW."accountLast4" IS NOT NULL) THEN RAISE EXCEPTION 'Cash evidence cannot contain bank details'; END IF;
 IF NEW."assignedReviewerId" IS NOT NULL AND (NEW."assignedReviewerId"=p."userId" OR NEW."assignedReviewerId" IS NOT DISTINCT FROM p."proposedBy" OR NOT EXISTS (SELECT 1 FROM "User" u JOIN "Membership" m ON m."userId"=u.id WHERE u.id=NEW."assignedReviewerId" AND u.active AND u."mfaConfirmed" AND u."emailVerifiedAt" IS NOT NULL AND u."phoneVerifiedAt" IS NOT NULL AND m."propertyId"=p."propertyId" AND m.role IN ('FINANCE','FINANCE_APPROVER'))) THEN RAISE EXCEPTION 'Independent active finance reviewer required'; END IF;
 IF TG_OP='UPDATE' AND (NEW.id<>OLD.id OR NEW."paymentId"<>OLD."paymentId" OR NEW."propertyId"<>OLD."propertyId" OR NEW."recordedBy"<>OLD."recordedBy") THEN RAISE EXCEPTION 'Payment evidence identity is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER protect_payment_evidence_record BEFORE INSERT OR UPDATE OR DELETE ON "PaymentEvidence" FOR EACH ROW EXECUTE FUNCTION protect_payment_evidence();
CREATE FUNCTION protect_payment_dispute() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p "Payment"%ROWTYPE;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Payment dispute history cannot be deleted'; END IF;
 SELECT * INTO p FROM "Payment" WHERE id=NEW."paymentId";
 IF p.id IS NULL OR p."propertyId"<>NEW."propertyId" OR p."userId"<>NEW."userId" THEN RAISE EXCEPTION 'Payment dispute scope mismatch'; END IF;
 IF TG_OP='UPDATE' AND (NEW.id<>OLD.id OR NEW."paymentId"<>OLD."paymentId" OR NEW."propertyId"<>OLD."propertyId" OR NEW."userId"<>OLD."userId" OR NEW.reason<>OLD.reason OR NEW."createdAt"<>OLD."createdAt" OR OLD.state IN ('RESOLVED','REJECTED') OR (OLD.state='INVESTIGATING' AND NEW.state NOT IN ('INVESTIGATING','RESOLVED','REJECTED'))) THEN RAISE EXCEPTION 'Payment dispute evidence is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER protect_payment_dispute_record BEFORE INSERT OR UPDATE OR DELETE ON "PaymentDispute" FOR EACH ROW EXECUTE FUNCTION protect_payment_dispute();
CREATE TRIGGER immutable_payment_dispute_event BEFORE UPDATE OR DELETE ON "PaymentDisputeEvent" FOR EACH ROW EXECUTE FUNCTION reject_mutation();
ALTER TABLE "PaymentEvidence" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PaymentDispute" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PaymentDisputeEvent" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON "PaymentEvidence" TO legacy_tenant USING (legacy_property_visible("propertyId")) WITH CHECK (legacy_property_visible("propertyId"));
CREATE POLICY tenant_scope ON "PaymentDispute" TO legacy_tenant USING (legacy_property_visible("propertyId")) WITH CHECK (legacy_property_visible("propertyId"));
CREATE POLICY tenant_scope ON "PaymentDisputeEvent" TO legacy_tenant USING (EXISTS (SELECT 1 FROM "PaymentDispute" d WHERE d.id="disputeId" AND legacy_property_visible(d."propertyId"))) WITH CHECK (EXISTS (SELECT 1 FROM "PaymentDispute" d WHERE d.id="disputeId" AND legacy_property_visible(d."propertyId")));
GRANT SELECT, INSERT, UPDATE, DELETE ON "PaymentEvidence", "PaymentDispute", "PaymentDisputeEvent" TO legacy_tenant;
