-- CreateEnum
CREATE TYPE "SummaryStatus" AS ENUM ('PENDING', 'AVAILABLE', 'UNAVAILABLE');

-- CreateEnum
CREATE TYPE "MeetingStatus" AS ENUM ('REQUESTED', 'CONFIRMED', 'DECLINED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "FeedbackSentiment" AS ENUM ('POSITIVE', 'NEUTRAL', 'NEGATIVE');

-- CreateTable
CREATE TABLE "SittingSummary" (
    "id" UUID NOT NULL,
    "sittingId" UUID NOT NULL,
    "status" "SummaryStatus" NOT NULL DEFAULT 'PENDING',
    "topics" JSONB,
    "decisions" JSONB,
    "mpContributions" JSONB,
    "model" TEXT,
    "unavailableReason" TEXT,
    "requestedById" UUID,
    "generatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SittingSummary_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MpAvailability" (
    "id" UUID NOT NULL,
    "mpId" UUID NOT NULL,
    "dayOfWeek" INTEGER NOT NULL,
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MpAvailability_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Meeting" (
    "id" UUID NOT NULL,
    "mpId" UUID NOT NULL,
    "caseId" UUID,
    "citizenContactRef" TEXT,
    "requestedName" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "requestedSlot" TIMESTAMP(3) NOT NULL,
    "durationMinutes" INTEGER NOT NULL DEFAULT 30,
    "status" "MeetingStatus" NOT NULL DEFAULT 'REQUESTED',
    "confirmedSlot" TIMESTAMP(3),
    "staffNote" TEXT,
    "decidedById" UUID,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Meeting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillFeedback" (
    "id" UUID NOT NULL,
    "billId" UUID NOT NULL,
    "sentiment" "FeedbackSentiment" NOT NULL,
    "comment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BillFeedback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SittingSummary_sittingId_key" ON "SittingSummary"("sittingId");

-- CreateIndex
CREATE INDEX "MpAvailability_mpId_idx" ON "MpAvailability"("mpId");

-- CreateIndex
CREATE INDEX "Meeting_mpId_status_idx" ON "Meeting"("mpId", "status");

-- CreateIndex
CREATE INDEX "BillFeedback_billId_sentiment_idx" ON "BillFeedback"("billId", "sentiment");

-- AddForeignKey
ALTER TABLE "SittingSummary" ADD CONSTRAINT "SittingSummary_sittingId_fkey" FOREIGN KEY ("sittingId") REFERENCES "Sitting"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MpAvailability" ADD CONSTRAINT "MpAvailability_mpId_fkey" FOREIGN KEY ("mpId") REFERENCES "Mp"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Meeting" ADD CONSTRAINT "Meeting_mpId_fkey" FOREIGN KEY ("mpId") REFERENCES "Mp"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Meeting" ADD CONSTRAINT "Meeting_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "CitizenCase"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillFeedback" ADD CONSTRAINT "BillFeedback_billId_fkey" FOREIGN KEY ("billId") REFERENCES "Bill"("id") ON DELETE CASCADE ON UPDATE CASCADE;
