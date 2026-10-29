-- Existing deployments belong to MIPF. New organisations are provisioned explicitly.
CREATE TABLE "Organisation" (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  "legalEntity" TEXT NOT NULL,
  branding JSONB NOT NULL DEFAULT '{}',
  "residencyRegion" TEXT,
  "retentionPolicy" JSONB NOT NULL DEFAULT '{}',
  "paymentCredentialsEncrypted" TEXT,
  "paymentMode" TEXT NOT NULL DEFAULT 'disabled' CHECK ("paymentMode" IN ('disabled','live')),
  active BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "Organisation" (id,slug,name,"legalEntity") VALUES ('mipf','mipf','MIPF — Legacy Heights','Mining Industry Pension Fund');
ALTER TABLE "Property" ADD COLUMN "organisationId" TEXT NOT NULL DEFAULT 'mipf' REFERENCES "Organisation"(id) ON DELETE RESTRICT;
CREATE INDEX "Property_organisationId_idx" ON "Property"("organisationId");
CREATE TABLE "OrganisationMembership" (
  id TEXT PRIMARY KEY,
  "organisationId" TEXT NOT NULL REFERENCES "Organisation"(id) ON DELETE RESTRICT,
  "userId" TEXT NOT NULL REFERENCES "User"(id) ON DELETE RESTRICT,
  role TEXT NOT NULL CHECK (role IN ('ADMIN','MEMBER')),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("organisationId","userId",role)
);
CREATE INDEX "OrganisationMembership_userId_idx" ON "OrganisationMembership"("userId");
CREATE TABLE "PlatformGrant" (
  "userId" TEXT PRIMARY KEY REFERENCES "User"(id) ON DELETE RESTRICT,
  role TEXT NOT NULL DEFAULT 'OPERATOR' CHECK (role='OPERATOR'),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- An existing property cannot be moved into another organisation through an update.
CREATE FUNCTION legacy_protect_property_organisation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."organisationId" IS DISTINCT FROM OLD."organisationId" THEN
    RAISE EXCEPTION 'PROPERTY_ORGANISATION_IMMUTABLE';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER property_organisation_immutable BEFORE UPDATE ON "Property"
FOR EACH ROW EXECUTE FUNCTION legacy_protect_property_organisation();

-- The scoped role deliberately cannot log in, bypass RLS, create schemas or act as an operator.
-- Migration/deployment credentials are distinct from this restricted execution role.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='legacy_tenant') THEN
    CREATE ROLE legacy_tenant NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='legacy_tenant' AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolcanlogin)) THEN
    RAISE EXCEPTION 'UNSAFE_LEGACY_TENANT_ROLE';
  END IF;
  EXECUTE format('GRANT legacy_tenant TO %I',current_user);
END;
$$;
GRANT USAGE ON SCHEMA public TO legacy_tenant;

CREATE FUNCTION legacy_organisation_context() RETURNS TEXT LANGUAGE sql STABLE
SET search_path = pg_catalog AS $$ SELECT nullif(current_setting('app.organisation_id',true),'') $$;
CREATE FUNCTION legacy_user_context() RETURNS TEXT LANGUAGE sql STABLE
SET search_path = pg_catalog AS $$ SELECT nullif(current_setting('app.user_id',true),'') $$;

-- SECURITY DEFINER lookup avoids policy recursion while exposing only a Boolean.
-- The fixed search_path and schema-qualified tables prevent search-path substitution.
CREATE FUNCTION legacy_property_visible(property_id TEXT) RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog,public AS $$
  SELECT EXISTS (SELECT 1 FROM public."Property" p JOIN public."Organisation" o ON o.id=p."organisationId"
    WHERE p.id=property_id AND o.active AND o.id=public.legacy_organisation_context())
$$;
CREATE FUNCTION legacy_user_in_organisation(user_id TEXT) RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog,public AS $$
  SELECT EXISTS (SELECT 1 FROM public."User" u WHERE u.id=user_id AND u.active AND (
    EXISTS (SELECT 1 FROM public."OrganisationMembership" m WHERE m."userId"=u.id AND m."organisationId"=public.legacy_organisation_context()) OR
    EXISTS (SELECT 1 FROM public."Membership" m JOIN public."Property" p ON p.id=m."propertyId" WHERE m."userId"=u.id AND p."organisationId"=public.legacy_organisation_context()) OR
    EXISTS (SELECT 1 FROM public."Application" a JOIN public."Property" p ON p.id=a."propertyId" WHERE a."userId"=u.id AND p."organisationId"=public.legacy_organisation_context()) OR
    EXISTS (SELECT 1 FROM public."Reservation" r JOIN public."Property" p ON p.id=r."propertyId" WHERE r."userId"=u.id AND p."organisationId"=public.legacy_organisation_context())
  ))
$$;
REVOKE ALL ON FUNCTION legacy_organisation_context(),legacy_user_context(),legacy_property_visible(TEXT),legacy_user_in_organisation(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION legacy_organisation_context(),legacy_user_context(),legacy_property_visible(TEXT),legacy_user_in_organisation(TEXT) TO legacy_tenant;

ALTER TABLE "Organisation" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON "Organisation" TO legacy_tenant USING (id=legacy_organisation_context() AND active);
GRANT SELECT (id,slug,name,"legalEntity",branding,"residencyRegion","retentionPolicy","paymentMode",active,"createdAt") ON "Organisation" TO legacy_tenant;
ALTER TABLE "OrganisationMembership" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON "OrganisationMembership" TO legacy_tenant USING ("organisationId"=legacy_organisation_context());
GRANT SELECT ON "OrganisationMembership" TO legacy_tenant;
ALTER TABLE "Property" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON "Property" TO legacy_tenant USING ("organisationId"=legacy_organisation_context()) WITH CHECK ("organisationId"=legacy_organisation_context());
GRANT SELECT,INSERT,UPDATE,DELETE ON "Property" TO legacy_tenant;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['Membership','Building','Reservation','Waitlist','Application','Document','Charge','Payment','LeaseTemplate','Lease','Ticket','Announcement','Integration','TenancyRequest','ApiKey','RatePlan'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY tenant_scope ON %I TO legacy_tenant USING (legacy_property_visible("propertyId")) WITH CHECK (legacy_property_visible("propertyId"))',t);
    EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO legacy_tenant',t);
  END LOOP;
END;
$$;

ALTER TABLE "Floor" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON "Floor" TO legacy_tenant USING (EXISTS (SELECT 1 FROM "Building" b WHERE b.id="buildingId")) WITH CHECK (EXISTS (SELECT 1 FROM "Building" b WHERE b.id="buildingId"));
ALTER TABLE "Room" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON "Room" TO legacy_tenant USING (EXISTS (SELECT 1 FROM "Floor" f WHERE f.id="floorId")) WITH CHECK (EXISTS (SELECT 1 FROM "Floor" f WHERE f.id="floorId"));
ALTER TABLE "Bed" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON "Bed" TO legacy_tenant USING (EXISTS (SELECT 1 FROM "Room" r WHERE r.id="roomId")) WITH CHECK (EXISTS (SELECT 1 FROM "Room" r WHERE r.id="roomId"));
GRANT SELECT,INSERT,UPDATE,DELETE ON "Floor","Room","Bed" TO legacy_tenant;

DO $$
DECLARE t TEXT; parent TEXT; link TEXT;
BEGIN
  FOR t,parent,link IN VALUES ('ApplicationHistory','Application','applicationId'),('Credit','Charge','chargeId'),('Allocation','Payment','paymentId'),('Refund','Payment','paymentId'),('Receipt','Payment','paymentId'),('AllocationReversal','Allocation','allocationId'),('LeaseEvent','Lease','leaseId'),('LeaseSigningChallenge','Lease','leaseId'),('TicketMessage','Ticket','ticketId') LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY tenant_scope ON %I TO legacy_tenant USING (EXISTS (SELECT 1 FROM %I p WHERE p.id=%I)) WITH CHECK (EXISTS (SELECT 1 FROM %I p WHERE p.id=%I))',t,parent,link,parent,link);
    EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO legacy_tenant',t);
  END LOOP;
END;
$$;

ALTER TABLE "User" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON "User" TO legacy_tenant USING (id=legacy_user_context() OR legacy_user_in_organisation(id));
GRANT SELECT (id,email,name,phone,"residentType",institution,"emergencyName","emergencyPhone","emailVerifiedAt","phoneVerifiedAt","mfaConfirmed",active,"createdAt") ON "User" TO legacy_tenant;
ALTER TABLE "Consent" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON "Consent" TO legacy_tenant USING ("userId"=legacy_user_context()) WITH CHECK ("userId"=legacy_user_context());
GRANT SELECT,INSERT ON "Consent" TO legacy_tenant;
ALTER TABLE "Notification" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON "Notification" TO legacy_tenant USING ("userId"=legacy_user_context()) WITH CHECK ("userId"=legacy_user_context() OR legacy_user_in_organisation("userId"));
GRANT SELECT,INSERT,UPDATE ON "Notification" TO legacy_tenant;
ALTER TABLE "AuditEvent" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON "AuditEvent" TO legacy_tenant USING (legacy_property_visible("propertyId") OR ("propertyId" IS NULL AND detail->>'organisationId'=legacy_organisation_context())) WITH CHECK (legacy_property_visible("propertyId") OR ("propertyId" IS NULL AND detail->>'organisationId'=legacy_organisation_context()));
GRANT SELECT,INSERT ON "AuditEvent" TO legacy_tenant;
ALTER TABLE "OutboxEvent" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON "OutboxEvent" TO legacy_tenant USING (legacy_property_visible("propertyId") OR ("propertyId" IS NULL AND payload->'detail'->>'organisationId'=legacy_organisation_context())) WITH CHECK (legacy_property_visible("propertyId") OR ("propertyId" IS NULL AND payload->'detail'->>'organisationId'=legacy_organisation_context()));
GRANT SELECT,INSERT,UPDATE ON "OutboxEvent" TO legacy_tenant;
ALTER TABLE "SecurityAlert" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON "SecurityAlert" TO legacy_tenant USING (legacy_property_visible("propertyId")) WITH CHECK (legacy_property_visible("propertyId"));
GRANT SELECT,INSERT,UPDATE ON "SecurityAlert" TO legacy_tenant;

-- Global identity, authentication, enquiries, privacy requests and provider inbox remain
-- control-plane operations. No access to them is granted to legacy_tenant.

-- RLS checks the row's ownership; these triggers prevent a valid local row from
-- laundering a foreign tenant's related identifier through a non-tenant-aware FK.
CREATE FUNCTION legacy_check_property_links() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE valid BOOLEAN;
BEGIN
  CASE TG_TABLE_NAME
    WHEN 'Reservation' THEN
      SELECT EXISTS(SELECT 1 FROM "Bed" b JOIN "Room" r ON r.id=b."roomId" JOIN "Floor" f ON f.id=r."floorId" JOIN "Building" g ON g.id=f."buildingId" WHERE b.id=NEW."bedId" AND g."propertyId"=NEW."propertyId") INTO valid;
      IF NOT valid THEN RAISE EXCEPTION 'CROSS_PROPERTY_BED'; END IF;
      IF NEW."applicationId" IS NOT NULL AND NOT EXISTS(SELECT 1 FROM "Application" a WHERE a.id=NEW."applicationId" AND a."propertyId"=NEW."propertyId" AND a."userId"=NEW."userId") THEN RAISE EXCEPTION 'CROSS_PROPERTY_APPLICATION'; END IF;
    WHEN 'Document' THEN
      IF NEW."applicationId" IS NOT NULL AND NOT EXISTS(SELECT 1 FROM "Application" a WHERE a.id=NEW."applicationId" AND a."propertyId"=NEW."propertyId" AND a."userId"=NEW."userId") THEN RAISE EXCEPTION 'CROSS_PROPERTY_APPLICATION'; END IF;
    WHEN 'Lease' THEN
      IF NOT EXISTS(SELECT 1 FROM "Reservation" r WHERE r.id=NEW."reservationId" AND r."propertyId"=NEW."propertyId" AND r."userId"=NEW."userId" AND r."applicationId"=NEW."applicationId") OR NOT EXISTS(SELECT 1 FROM "LeaseTemplate" t WHERE t.id=NEW."templateId" AND t."propertyId"=NEW."propertyId") THEN RAISE EXCEPTION 'CROSS_PROPERTY_LEASE'; END IF;
    WHEN 'Allocation' THEN
      IF NOT EXISTS(SELECT 1 FROM "Payment" p JOIN "Charge" c ON c.id=NEW."chargeId" WHERE p.id=NEW."paymentId" AND p."propertyId"=c."propertyId" AND p."userId"=c."userId" AND p.currency=c.currency) THEN RAISE EXCEPTION 'CROSS_PROPERTY_ALLOCATION'; END IF;
    WHEN 'AllocationReversal' THEN
      IF NOT EXISTS(SELECT 1 FROM "Allocation" a JOIN "Refund" r ON r.id=NEW."refundId" WHERE a.id=NEW."allocationId" AND a."paymentId"=r."paymentId") THEN RAISE EXCEPTION 'CROSS_PAYMENT_REVERSAL'; END IF;
    WHEN 'TicketMessage' THEN
      IF NEW."documentId" IS NOT NULL AND NOT EXISTS(SELECT 1 FROM "Document" d JOIN "Ticket" t ON t.id=NEW."ticketId" WHERE d.id=NEW."documentId" AND d."propertyId"=t."propertyId") THEN RAISE EXCEPTION 'CROSS_PROPERTY_ATTACHMENT'; END IF;
    WHEN 'TenancyRequest' THEN
      IF NOT EXISTS(SELECT 1 FROM "Lease" l WHERE l.id=NEW."leaseId" AND l."propertyId"=NEW."propertyId" AND l."userId"=NEW."userId") OR NOT EXISTS(SELECT 1 FROM "Bed" b JOIN "Room" r ON r.id=b."roomId" JOIN "Floor" f ON f.id=r."floorId" JOIN "Building" g ON g.id=f."buildingId" WHERE b.id=NEW."targetBedId" AND g."propertyId"=NEW."propertyId") THEN RAISE EXCEPTION 'CROSS_PROPERTY_TENANCY'; END IF;
    WHEN 'RatePlan' THEN
      IF NEW."roomId" IS NOT NULL AND NOT EXISTS(SELECT 1 FROM "Room" r JOIN "Floor" f ON f.id=r."floorId" JOIN "Building" g ON g.id=f."buildingId" WHERE r.id=NEW."roomId" AND g."propertyId"=NEW."propertyId") THEN RAISE EXCEPTION 'CROSS_PROPERTY_RATE'; END IF;
      IF NEW."bedId" IS NOT NULL AND NOT EXISTS(SELECT 1 FROM "Bed" b JOIN "Room" r ON r.id=b."roomId" JOIN "Floor" f ON f.id=r."floorId" JOIN "Building" g ON g.id=f."buildingId" WHERE b.id=NEW."bedId" AND g."propertyId"=NEW."propertyId" AND (NEW."roomId" IS NULL OR r.id=NEW."roomId")) THEN RAISE EXCEPTION 'CROSS_PROPERTY_RATE'; END IF;
  END CASE;
  RETURN NEW;
END;
$$;
DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY['Reservation','Document','Lease','Allocation','AllocationReversal','TicketMessage','TenancyRequest','RatePlan'] LOOP
    EXECUTE format('CREATE TRIGGER enforce_property_links BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION legacy_check_property_links()',t);
  END LOOP;
END;
$$;
