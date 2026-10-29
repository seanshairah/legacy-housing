-- Policy-gated payload erasure keeps metadata, audit, financial and lease evidence.
ALTER TABLE "Document" ADD COLUMN "deletedAt" TIMESTAMP(3);
CREATE TABLE "RetentionPolicy" (
  id TEXT PRIMARY KEY,
  "propertyId" TEXT NOT NULL REFERENCES "Property"(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('IDENTITY','REGISTRATION','RESIDENCE','SPONSOR','MEDICAL','SUPPORT')),
  "retainDays" INTEGER NOT NULL CHECK ("retainDays" BETWEEN 1 AND 36500),
  basis TEXT NOT NULL,
  "policyReference" TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  state TEXT NOT NULL DEFAULT 'DRAFT' CHECK (state IN ('DRAFT','APPROVED','SUPERSEDED')),
  "proposedBy" TEXT NOT NULL REFERENCES "User"(id) ON DELETE RESTRICT,
  "approvedBy" TEXT REFERENCES "User"(id) ON DELETE RESTRICT,
  "approvedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (state='DRAFT' OR ("approvedBy" IS NOT NULL AND "approvedBy"<>"proposedBy" AND "approvedAt" IS NOT NULL))
);
CREATE UNIQUE INDEX "RetentionPolicy_propertyId_kind_version_key" ON "RetentionPolicy"("propertyId",kind,version);
CREATE INDEX "RetentionPolicy_propertyId_state_idx" ON "RetentionPolicy"("propertyId",state);
CREATE UNIQUE INDEX retention_one_approved_policy ON "RetentionPolicy"("propertyId",kind) WHERE state='APPROVED';
CREATE TABLE "DocumentLegalHold" (
  id TEXT PRIMARY KEY,
  "propertyId" TEXT NOT NULL REFERENCES "Property"(id) ON DELETE RESTRICT,
  "documentId" TEXT NOT NULL REFERENCES "Document"(id) ON DELETE RESTRICT,
  reason TEXT NOT NULL,
  "imposedBy" TEXT NOT NULL REFERENCES "User"(id) ON DELETE RESTRICT,
  "releasedBy" TEXT REFERENCES "User"(id) ON DELETE RESTRICT,
  "releasedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (("releasedAt" IS NULL AND "releasedBy" IS NULL) OR ("releasedAt" IS NOT NULL AND "releasedBy" IS NOT NULL AND "releasedBy"<>"imposedBy"))
);
CREATE INDEX "DocumentLegalHold_documentId_releasedAt_idx" ON "DocumentLegalHold"("documentId","releasedAt");
CREATE TABLE "DocumentDeletion" (
  id TEXT PRIMARY KEY,
  "propertyId" TEXT NOT NULL REFERENCES "Property"(id) ON DELETE RESTRICT,
  "documentId" TEXT NOT NULL UNIQUE REFERENCES "Document"(id) ON DELETE RESTRICT,
  "policyId" TEXT NOT NULL REFERENCES "RetentionPolicy"(id) ON DELETE RESTRICT,
  "requestedBy" TEXT NOT NULL REFERENCES "User"(id) ON DELETE RESTRICT,
  "approvedBy" TEXT REFERENCES "User"(id) ON DELETE RESTRICT,
  reason TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'REQUESTED' CHECK (state IN ('REQUESTED','APPROVED','DELETING','FAILED','COMPLETED')),
  "approvedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (state='REQUESTED' OR ("approvedBy" IS NOT NULL AND "approvedBy"<>"requestedBy" AND "approvedAt" IS NOT NULL))
);
CREATE INDEX "DocumentDeletion_propertyId_state_idx" ON "DocumentDeletion"("propertyId",state);

CREATE FUNCTION protect_retention_policy() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Retention policy evidence is immutable'; END IF;
  IF (NEW.id<>OLD.id OR NEW."propertyId"<>OLD."propertyId" OR NEW.kind<>OLD.kind OR NEW."retainDays"<>OLD."retainDays" OR NEW.basis<>OLD.basis OR NEW."policyReference"<>OLD."policyReference" OR NEW.version<>OLD.version OR NEW."proposedBy"<>OLD."proposedBy" OR NEW."createdAt"<>OLD."createdAt" OR (OLD.state<>'DRAFT' AND (NEW."approvedBy" IS DISTINCT FROM OLD."approvedBy" OR NEW."approvedAt" IS DISTINCT FROM OLD."approvedAt" OR NEW.state NOT IN ('APPROVED','SUPERSEDED'))) OR (OLD.state='SUPERSEDED' AND NEW.state<>'SUPERSEDED'))
  THEN RAISE EXCEPTION 'Approved retention policy is immutable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER immutable_retention_policy BEFORE UPDATE OR DELETE ON "RetentionPolicy" FOR EACH ROW EXECUTE FUNCTION protect_retention_policy();
CREATE FUNCTION protect_document_hold() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d "Document"%ROWTYPE;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Legal hold evidence is immutable'; END IF;
  SELECT * INTO d FROM "Document" WHERE id=NEW."documentId" FOR UPDATE;
  IF d."propertyId"<>NEW."propertyId" THEN RAISE EXCEPTION 'Legal hold property mismatch'; END IF;
  IF TG_OP='INSERT' AND (d.state IN ('DELETION_PENDING','DELETED') OR d."deletedAt" IS NOT NULL) THEN RAISE EXCEPTION 'Deletion already claimed'; END IF;
  IF TG_OP='UPDATE' AND (NEW.id<>OLD.id OR NEW."documentId"<>OLD."documentId" OR NEW."propertyId"<>OLD."propertyId" OR NEW.reason<>OLD.reason OR NEW."imposedBy"<>OLD."imposedBy" OR OLD."releasedAt" IS NOT NULL) THEN RAISE EXCEPTION 'Legal hold evidence is immutable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER immutable_document_hold BEFORE INSERT OR UPDATE OR DELETE ON "DocumentLegalHold" FOR EACH ROW EXECUTE FUNCTION protect_document_hold();
CREATE FUNCTION protect_document_deletion() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d "Document"%ROWTYPE; p "RetentionPolicy"%ROWTYPE;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Deletion evidence is immutable'; END IF;
  SELECT * INTO d FROM "Document" WHERE id=NEW."documentId";
  SELECT * INTO p FROM "RetentionPolicy" WHERE id=NEW."policyId";
  IF d."propertyId"<>NEW."propertyId" OR p."propertyId"<>d."propertyId" OR p.kind<>d.kind THEN RAISE EXCEPTION 'Deletion scope mismatch'; END IF;
  IF TG_OP='UPDATE' AND (NEW.id<>OLD.id OR NEW."documentId"<>OLD."documentId" OR NEW."propertyId"<>OLD."propertyId" OR NEW."policyId"<>OLD."policyId" OR NEW."requestedBy"<>OLD."requestedBy" OR NEW.reason<>OLD.reason OR OLD.state='COMPLETED' OR (OLD."approvedBy" IS NOT NULL AND (NEW."approvedBy" IS DISTINCT FROM OLD."approvedBy" OR NEW."approvedAt" IS DISTINCT FROM OLD."approvedAt"))) THEN RAISE EXCEPTION 'Deletion approval evidence is immutable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER immutable_document_deletion BEFORE INSERT OR UPDATE OR DELETE ON "DocumentDeletion" FOR EACH ROW EXECUTE FUNCTION protect_document_deletion();
CREATE FUNCTION protect_deleted_document() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Document version metadata is immutable'; END IF;
  IF OLD."deletedAt" IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'Deleted document metadata is immutable'; END IF;
  IF (NEW.state IN ('DELETION_PENDING','DELETED') OR NEW."deletedAt" IS NOT NULL) AND OLD.state NOT IN ('DELETION_PENDING','DELETED') THEN
    IF NEW.kind IN ('PAYMENT_PROOF','SIGNED_LEASE') OR EXISTS (SELECT 1 FROM "Payment" WHERE "proofDocumentId"=OLD.id) OR EXISTS (SELECT 1 FROM "Lease" WHERE "signedDocumentId"=OLD.id) THEN RAISE EXCEPTION 'Financial and lease evidence cannot be erased'; END IF;
    IF EXISTS (SELECT 1 FROM "DocumentLegalHold" WHERE "documentId"=OLD.id AND "releasedAt" IS NULL) THEN RAISE EXCEPTION 'Active legal hold prevents erasure'; END IF;
    IF NOT EXISTS (SELECT 1 FROM "DocumentDeletion" WHERE "documentId"=OLD.id AND state IN ('APPROVED','DELETING','FAILED') AND "approvedBy" IS NOT NULL AND "approvedBy"<>"requestedBy") THEN RAISE EXCEPTION 'Approved deletion required'; END IF;
  END IF;
  IF (NEW."deletedAt" IS NOT NULL)<>(NEW.state='DELETED') THEN RAISE EXCEPTION 'Deleted document state invalid'; END IF;
  IF OLD.state='DELETION_PENDING' AND NEW.state NOT IN ('DELETION_PENDING','DELETED') THEN RAISE EXCEPTION 'Deletion claim is irreversible'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER protect_erased_document BEFORE UPDATE OR DELETE ON "Document" FOR EACH ROW EXECUTE FUNCTION protect_deleted_document();

ALTER TABLE "RetentionPolicy" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON "RetentionPolicy" TO legacy_tenant USING (legacy_property_visible("propertyId")) WITH CHECK (legacy_property_visible("propertyId"));
GRANT SELECT, INSERT, UPDATE, DELETE ON "RetentionPolicy" TO legacy_tenant;
ALTER TABLE "DocumentLegalHold" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON "DocumentLegalHold" TO legacy_tenant USING (legacy_property_visible("propertyId")) WITH CHECK (legacy_property_visible("propertyId"));
GRANT SELECT, INSERT, UPDATE, DELETE ON "DocumentLegalHold" TO legacy_tenant;
ALTER TABLE "DocumentDeletion" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON "DocumentDeletion" TO legacy_tenant USING (legacy_property_visible("propertyId")) WITH CHECK (legacy_property_visible("propertyId"));
GRANT SELECT, INSERT, UPDATE, DELETE ON "DocumentDeletion" TO legacy_tenant;
