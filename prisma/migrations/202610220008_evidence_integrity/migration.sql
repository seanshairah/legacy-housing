UPDATE "Payment" AS p SET "proofHash"=d.hash FROM "Document" AS d WHERE p."proofDocumentId"=d.id AND p."proofHash" IS NULL;
CREATE UNIQUE INDEX document_version_identity ON "Document" ("applicationId",kind,version);
