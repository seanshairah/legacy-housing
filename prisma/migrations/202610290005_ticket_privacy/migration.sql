ALTER TABLE "TicketMessage" ADD COLUMN internal BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Ticket" ADD COLUMN "resolutionConfirmedAt" TIMESTAMP(3), ADD COLUMN "resolutionConfirmedBy" TEXT REFERENCES "User"(id) ON DELETE RESTRICT, ADD COLUMN "reopenedCount" INTEGER NOT NULL DEFAULT 0 CHECK ("reopenedCount">=0);
-- The ordinary tenant policy remains necessary. This restrictive policy adds a
-- staff-only condition for internal messages even within the same organisation.
CREATE POLICY internal_note_restriction ON "TicketMessage" AS RESTRICTIVE TO legacy_tenant
USING (NOT internal OR EXISTS (
  SELECT 1 FROM "Ticket" t JOIN "Membership" m ON m."propertyId"=t."propertyId"
  WHERE t.id="ticketId" AND m."userId"=legacy_user_context()
  AND m.role IN ('ADMIN','PROPERTY_MANAGER','CARETAKER','MAINTENANCE_OFFICER','ADMISSIONS')
))
WITH CHECK (NOT internal OR EXISTS (
  SELECT 1 FROM "Ticket" t JOIN "Membership" m ON m."propertyId"=t."propertyId"
  WHERE t.id="ticketId" AND m."userId"=legacy_user_context()
  AND m.role IN ('ADMIN','PROPERTY_MANAGER','CARETAKER','MAINTENANCE_OFFICER','ADMISSIONS')
));
