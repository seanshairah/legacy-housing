-- DropIndex
DROP INDEX "document_version_identity";

-- DropIndex
DROP INDEX "proof_fingerprint_lookup";

-- AlterTable
ALTER TABLE "Document" ADD COLUMN     "nextScanAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "scanAttempts" INTEGER NOT NULL DEFAULT 0;
