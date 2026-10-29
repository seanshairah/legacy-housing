CREATE TABLE "AccountInvitation" (
  "id" TEXT PRIMARY KEY,
  "email" TEXT NOT NULL,
  "propertyId" TEXT NOT NULL REFERENCES "Property"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "role" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL UNIQUE,
  "invitedBy" TEXT NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "acceptedAt" TIMESTAMP(3),
  "acceptedBy" TEXT REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "invitation_acceptance_pair" CHECK (("acceptedAt" IS NULL) = ("acceptedBy" IS NULL)),
  CONSTRAINT "invitation_terminal_state" CHECK ("acceptedAt" IS NULL OR "revokedAt" IS NULL),
  CONSTRAINT "invitation_expiration" CHECK ("expiresAt" > "createdAt")
);
CREATE INDEX "AccountInvitation_propertyId_email_idx" ON "AccountInvitation"("propertyId", "email");
ALTER TABLE "AccountInvitation" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON "AccountInvitation" TO legacy_tenant
  USING (legacy_property_visible("propertyId")) WITH CHECK (legacy_property_visible("propertyId"));
GRANT SELECT, INSERT, UPDATE, DELETE ON "AccountInvitation" TO legacy_tenant;
