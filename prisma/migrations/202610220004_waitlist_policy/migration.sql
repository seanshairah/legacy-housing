ALTER TABLE "Waitlist" ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Waitlist" ADD CONSTRAINT waitlist_priority CHECK (priority BETWEEN 0 AND 10);
CREATE FUNCTION protect_document_evidence() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.hash<>OLD.hash OR NEW."storageKey"<>OLD."storageKey" OR NEW."userId"<>OLD."userId" OR NEW."propertyId"<>OLD."propertyId" THEN RAISE EXCEPTION 'Document version evidence is immutable'; END IF; RETURN NEW; END; $$;
CREATE TRIGGER protect_document_evidence BEFORE UPDATE ON "Document" FOR EACH ROW EXECUTE FUNCTION protect_document_evidence();
