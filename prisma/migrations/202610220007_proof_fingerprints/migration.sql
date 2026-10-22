-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "proofHash" TEXT;

CREATE INDEX proof_fingerprint_lookup ON "Payment" ("propertyId","proofHash");
