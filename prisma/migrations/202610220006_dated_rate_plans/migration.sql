-- AlterTable
ALTER TABLE "Reservation" ADD COLUMN     "priceSnapshot" JSONB;

-- CreateTable
CREATE TABLE "RatePlan" (
    "id" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "roomId" TEXT,
    "bedId" TEXT,
    "title" TEXT NOT NULL,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,
    "minNights" INTEGER NOT NULL DEFAULT 1,
    "monthlyMinor" BIGINT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RatePlan_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "RatePlan" ADD CONSTRAINT rate_policy CHECK ("monthlyMinor">=0 AND "endAt">"startAt" AND "minNights" BETWEEN 1 AND 732);
ALTER TABLE "RatePlan" ADD CONSTRAINT distinct_rate_ranges EXCLUDE USING gist ("propertyId" WITH =, COALESCE("bedId",'') WITH =, COALESCE("roomId",'') WITH =, priority WITH =, "minNights" WITH =, tsrange("startAt","endAt",'[)') WITH &&);
CREATE TRIGGER immutable_rate BEFORE UPDATE OR DELETE ON "RatePlan" FOR EACH ROW EXECUTE FUNCTION reject_mutation();
