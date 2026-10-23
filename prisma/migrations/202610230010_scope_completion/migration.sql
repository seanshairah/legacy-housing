ALTER TABLE "LeaseTemplate" ADD COLUMN "signingDisclosure" TEXT;
CREATE TABLE "LeaseSigningChallenge" (
 "id" TEXT PRIMARY KEY, "leaseId" TEXT NOT NULL REFERENCES "Lease"("id") ON DELETE RESTRICT,
 "userId" TEXT NOT NULL, "tokenHash" TEXT NOT NULL UNIQUE, "documentHash" TEXT NOT NULL,
 "expiresAt" TIMESTAMP(3) NOT NULL, "consumedAt" TIMESTAMP(3), "totpStep" BIGINT,
 UNIQUE ("userId","totpStep")
);
CREATE TABLE "SecurityAlert" (
 "id" TEXT PRIMARY KEY, "dedupeKey" TEXT NOT NULL UNIQUE, "propertyId" TEXT,
 "kind" TEXT NOT NULL, "subjectHash" TEXT NOT NULL, "severity" TEXT NOT NULL,
 "occurrences" INTEGER NOT NULL DEFAULT 1, "state" TEXT NOT NULL DEFAULT 'OPEN',
 "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "reviewedBy" TEXT, "reviewedAt" TIMESTAMP(3), "resolution" TEXT,
 CONSTRAINT security_alert_state CHECK (state IN ('OPEN','ACKNOWLEDGED','RESOLVED'))
);
CREATE INDEX "SecurityAlert_propertyId_state_lastSeenAt_idx" ON "SecurityAlert"("propertyId","state","lastSeenAt");
CREATE FUNCTION protect_issued_lease_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW."documentSnapshot" IS DISTINCT FROM OLD."documentSnapshot" OR NEW."documentHash" IS DISTINCT FROM OLD."documentHash"
 OR NEW."userId" <> OLD."userId" OR NEW."propertyId" <> OLD."propertyId" OR NEW."templateId" <> OLD."templateId"
 OR NEW."applicationId" <> OLD."applicationId" OR NEW."reservationId" <> OLD."reservationId"
 THEN RAISE EXCEPTION 'Issued lease source is immutable'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER immutable_issued_lease_source BEFORE UPDATE ON "Lease" FOR EACH ROW EXECUTE FUNCTION protect_issued_lease_source();
