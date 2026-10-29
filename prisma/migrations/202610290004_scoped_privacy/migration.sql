-- Account-level privacy requests belong to the organisation chosen by the requester.
-- Historical records came from the MIPF dedicated deployment.
ALTER TABLE "PrivacyRequest" ADD COLUMN "organisationId" TEXT NOT NULL DEFAULT 'mipf' REFERENCES "Organisation"(id) ON DELETE RESTRICT;
CREATE INDEX "PrivacyRequest_organisationId_state_idx" ON "PrivacyRequest"("organisationId",state);
ALTER TABLE "PrivacyRequest" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON "PrivacyRequest" TO legacy_tenant USING ("organisationId"=legacy_organisation_context()) WITH CHECK ("organisationId"=legacy_organisation_context());
GRANT SELECT,INSERT,UPDATE ON "PrivacyRequest" TO legacy_tenant;
