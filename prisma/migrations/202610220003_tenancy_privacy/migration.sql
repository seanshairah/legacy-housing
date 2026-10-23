-- CreateTable
CREATE TABLE "TenancyRequest" (
    "id" TEXT NOT NULL,
    "leaseId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "targetBedId" TEXT NOT NULL,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,
    "reason" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'PENDING',
    "reviewedBy" TEXT,
    "reviewReason" TEXT,
    "newApplicationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TenancyRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PrivacyRequest" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'OPEN',
    "resolution" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PrivacyRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationPreference" (
    "userId" TEXT NOT NULL,
    "email" BOOLEAN NOT NULL DEFAULT true,
    "sms" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "NotificationPreference_pkey" PRIMARY KEY ("userId")
);

