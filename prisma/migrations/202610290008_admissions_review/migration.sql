ALTER TABLE "Application" ADD COLUMN "assignedReviewerId" TEXT REFERENCES "User"(id) ON DELETE RESTRICT;
CREATE TABLE "ApplicationReviewNote" (
  id TEXT PRIMARY KEY,
  "applicationId" TEXT NOT NULL REFERENCES "Application"(id) ON DELETE RESTRICT,
  "propertyId" TEXT NOT NULL REFERENCES "Property"(id) ON DELETE RESTRICT,
  "actorId" TEXT NOT NULL REFERENCES "User"(id) ON DELETE RESTRICT,
  body TEXT NOT NULL CHECK (char_length(body) BETWEEN 3 AND 5000),
  kind TEXT NOT NULL DEFAULT 'NOTE' CHECK (kind IN ('NOTE','ASSIGNMENT','STAGE')),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE FUNCTION protect_application_review_assignment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."assignedReviewerId" IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM "User" u JOIN "Membership" m ON m."userId"=u.id
    WHERE u.id=NEW."assignedReviewerId" AND u.active AND m."propertyId"=NEW."propertyId" AND m.role IN ('ADMIN','ADMISSIONS')
  ) THEN RAISE EXCEPTION 'ADMISSIONS_REVIEWER_REQUIRED'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER review_assignment_scope BEFORE INSERT OR UPDATE ON "Application" FOR EACH ROW EXECUTE FUNCTION protect_application_review_assignment();
CREATE FUNCTION protect_application_review_note() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM "Application" a WHERE a.id=NEW."applicationId" AND a."propertyId"=NEW."propertyId") THEN RAISE EXCEPTION 'APPLICATION_NOTE_PROPERTY_MISMATCH'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER review_note_scope BEFORE INSERT ON "ApplicationReviewNote" FOR EACH ROW EXECUTE FUNCTION protect_application_review_note();
CREATE TRIGGER immutable_application_review_note BEFORE UPDATE OR DELETE ON "ApplicationReviewNote" FOR EACH ROW EXECUTE FUNCTION reject_mutation();
ALTER TABLE "ApplicationReviewNote" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON "ApplicationReviewNote" TO legacy_tenant
USING (legacy_property_visible("propertyId") AND EXISTS(
  SELECT 1 FROM "Membership" m JOIN "User" u ON u.id=m."userId"
  WHERE m."propertyId"="ApplicationReviewNote"."propertyId" AND m."userId"=legacy_user_context() AND u.active AND m.role IN ('ADMIN','ADMISSIONS')
))
WITH CHECK (legacy_property_visible("propertyId") AND "actorId"=legacy_user_context() AND EXISTS(
  SELECT 1 FROM "Membership" m JOIN "User" u ON u.id=m."userId"
  WHERE m."propertyId"="ApplicationReviewNote"."propertyId" AND m."userId"=legacy_user_context() AND u.active AND m.role IN ('ADMIN','ADMISSIONS')
));
GRANT SELECT,INSERT ON "ApplicationReviewNote" TO legacy_tenant;
