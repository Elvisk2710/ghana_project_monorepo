-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('PUBLIC', 'STAFF', 'MP', 'RESEARCHER', 'REVIEWER', 'ADMIN');

-- CreateEnum
CREATE TYPE "DocumentType" AS ENUM ('HANSARD', 'ORDER_PAPER', 'BILL_TEXT', 'COMMITTEE_REPORT', 'OTHER');

-- CreateEnum
CREATE TYPE "DocumentLifecycle" AS ENUM ('DRAFT', 'PROCESSING', 'REVIEW', 'APPROVED', 'PUBLISHED', 'SUPERSEDED', 'REJECTED');

-- CreateEnum
CREATE TYPE "SittingStatus" AS ENUM ('SCHEDULED', 'HELD', 'CANCELLED');

-- CreateEnum
CREATE TYPE "BillStage" AS ENUM ('FIRST_READING', 'COMMITTEE', 'SECOND_READING', 'CONSIDERATION', 'THIRD_READING', 'ASSENTED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "CaseStatus" AS ENUM ('RECEIVED', 'TRIAGED', 'IN_PROGRESS', 'AWAITING_INFORMATION', 'RESOLVED', 'CLOSED');

-- CreateEnum
CREATE TYPE "CasePriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "MessageAuthorType" AS ENUM ('CITIZEN', 'STAFF', 'SYSTEM');

-- CreateEnum
CREATE TYPE "MessageVisibility" AS ENUM ('PUBLIC', 'INTERNAL');

-- CreateEnum
CREATE TYPE "DeliveryState" AS ENUM ('PENDING', 'SENT', 'DELIVERED', 'FAILED');

-- CreateEnum
CREATE TYPE "AnswerStatus" AS ENUM ('GROUNDED', 'NO_EVIDENCE', 'NEEDS_CLARIFICATION', 'CONFLICTING_SOURCES', 'UNSUPPORTED_LANGUAGE', 'SAFETY_REFUSAL', 'SERVICE_UNAVAILABLE');

-- CreateEnum
CREATE TYPE "ApprovalDecision" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CHANGES_REQUESTED');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'DEAD');

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "externalId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "roles" "Role"[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserConstituency" (
    "userId" UUID NOT NULL,
    "constituencyId" UUID NOT NULL,

    CONSTRAINT "UserConstituency_pkey" PRIMARY KEY ("userId","constituencyId")
);

-- CreateTable
CREATE TABLE "Constituency" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "region" TEXT NOT NULL,
    "lookupRef" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Constituency_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Mp" (
    "id" UUID NOT NULL,
    "officialName" TEXT NOT NULL,
    "party" TEXT NOT NULL,
    "roleTitle" TEXT,
    "publicContact" JSONB,
    "activeFrom" TIMESTAMP(3) NOT NULL,
    "activeTo" TIMESTAMP(3),
    "userId" UUID,
    "constituencyId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Mp_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Sitting" (
    "id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "type" TEXT NOT NULL,
    "agenda" JSONB,
    "status" "SittingStatus" NOT NULL DEFAULT 'SCHEDULED',
    "isPublished" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Sitting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Committee" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "remit" TEXT,
    "chairMpId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Committee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Bill" (
    "id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "sponsor" TEXT,
    "stage" "BillStage" NOT NULL DEFAULT 'FIRST_READING',
    "committeeId" UUID,
    "isPublished" BOOLEAN NOT NULL DEFAULT false,
    "introducedOn" DATE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Bill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ParliamentaryDocument" (
    "id" UUID NOT NULL,
    "publicId" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "sourceUri" TEXT NOT NULL,
    "type" "DocumentType" NOT NULL,
    "title" TEXT NOT NULL,
    "documentDate" DATE,
    "language" TEXT NOT NULL DEFAULT 'en',
    "checksum" TEXT NOT NULL,
    "lifecycle" "DocumentLifecycle" NOT NULL DEFAULT 'DRAFT',
    "isPublished" BOOLEAN NOT NULL DEFAULT false,
    "publishedAt" TIMESTAMP(3),
    "sensitivity" TEXT,
    "metadata" JSONB,
    "extractedText" TEXT,
    "qualityReport" JSONB,
    "indexVersion" TEXT,
    "rejectionReason" TEXT,
    "sittingId" UUID,
    "billId" UUID,
    "ownerId" UUID,
    "reviewerId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ParliamentaryDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentChunk" (
    "id" UUID NOT NULL,
    "documentId" UUID NOT NULL,
    "documentVersion" INTEGER NOT NULL,
    "sequence" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "anchor" TEXT,
    "embeddingId" TEXT,
    "embedding" DOUBLE PRECISION[],
    "indexVersion" TEXT,
    "language" TEXT NOT NULL DEFAULT 'en',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentChunk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuestionSession" (
    "id" UUID NOT NULL,
    "sessionRef" TEXT,
    "question" TEXT NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'en',
    "filters" JSONB,
    "retrievalSet" JSONB,
    "answer" TEXT,
    "status" "AnswerStatus" NOT NULL,
    "citations" JSONB,
    "modelVersion" TEXT,
    "promptVersion" TEXT,
    "retrieverVersion" TEXT,
    "feedback" JSONB,
    "correlationId" TEXT,
    "latencyMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QuestionSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CitizenCase" (
    "id" UUID NOT NULL,
    "publicId" TEXT NOT NULL,
    "citizenContactRef" TEXT,
    "constituencyId" UUID NOT NULL,
    "category" TEXT NOT NULL,
    "aiSuggestedCategory" TEXT,
    "aiConfidence" DOUBLE PRECISION,
    "priority" "CasePriority" NOT NULL DEFAULT 'NORMAL',
    "status" "CaseStatus" NOT NULL DEFAULT 'RECEIVED',
    "assigneeId" UUID,
    "consentGivenAt" TIMESTAMP(3) NOT NULL,
    "consentPurpose" TEXT NOT NULL,
    "preferredLanguage" TEXT NOT NULL DEFAULT 'en',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "CitizenCase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CaseMessage" (
    "id" UUID NOT NULL,
    "caseId" UUID NOT NULL,
    "authorType" "MessageAuthorType" NOT NULL,
    "authorUserId" UUID,
    "visibility" "MessageVisibility" NOT NULL,
    "content" TEXT NOT NULL,
    "channel" TEXT,
    "deliveryState" "DeliveryState" NOT NULL DEFAULT 'PENDING',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CaseMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Approval" (
    "id" UUID NOT NULL,
    "objectType" TEXT NOT NULL,
    "objectId" TEXT NOT NULL,
    "objectVersion" TEXT NOT NULL,
    "decision" "ApprovalDecision" NOT NULL DEFAULT 'PENDING',
    "approverId" UUID,
    "evidence" JSONB,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Approval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" UUID NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorId" TEXT,
    "actorType" TEXT NOT NULL,
    "actorRoles" TEXT[],
    "action" TEXT NOT NULL,
    "objectType" TEXT,
    "objectId" TEXT,
    "payload" JSONB,
    "outcome" TEXT NOT NULL DEFAULT 'success',
    "requestId" TEXT NOT NULL,
    "correlationId" TEXT NOT NULL,
    "ip" TEXT,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Job" (
    "id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "dedupeKey" TEXT,
    "status" "JobStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "runAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "correlationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_externalId_key" ON "User"("externalId");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Constituency_code_key" ON "Constituency"("code");

-- CreateIndex
CREATE INDEX "Constituency_region_idx" ON "Constituency"("region");

-- CreateIndex
CREATE UNIQUE INDEX "Mp_userId_key" ON "Mp"("userId");

-- CreateIndex
CREATE INDEX "Mp_constituencyId_activeTo_idx" ON "Mp"("constituencyId", "activeTo");

-- CreateIndex
CREATE INDEX "Sitting_date_idx" ON "Sitting"("date");

-- CreateIndex
CREATE UNIQUE INDEX "Committee_name_key" ON "Committee"("name");

-- CreateIndex
CREATE UNIQUE INDEX "ParliamentaryDocument_publicId_key" ON "ParliamentaryDocument"("publicId");

-- CreateIndex
CREATE INDEX "ParliamentaryDocument_lifecycle_isPublished_idx" ON "ParliamentaryDocument"("lifecycle", "isPublished");

-- CreateIndex
CREATE INDEX "ParliamentaryDocument_documentDate_idx" ON "ParliamentaryDocument"("documentDate");

-- CreateIndex
CREATE UNIQUE INDEX "ParliamentaryDocument_checksum_version_key" ON "ParliamentaryDocument"("checksum", "version");

-- CreateIndex
CREATE INDEX "DocumentChunk_indexVersion_idx" ON "DocumentChunk"("indexVersion");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentChunk_documentId_documentVersion_sequence_key" ON "DocumentChunk"("documentId", "documentVersion", "sequence");

-- CreateIndex
CREATE INDEX "QuestionSession_createdAt_idx" ON "QuestionSession"("createdAt");

-- CreateIndex
CREATE INDEX "QuestionSession_status_idx" ON "QuestionSession"("status");

-- CreateIndex
CREATE UNIQUE INDEX "CitizenCase_publicId_key" ON "CitizenCase"("publicId");

-- CreateIndex
CREATE INDEX "CitizenCase_constituencyId_status_idx" ON "CitizenCase"("constituencyId", "status");

-- CreateIndex
CREATE INDEX "CitizenCase_assigneeId_status_idx" ON "CitizenCase"("assigneeId", "status");

-- CreateIndex
CREATE INDEX "CaseMessage_caseId_createdAt_idx" ON "CaseMessage"("caseId", "createdAt");

-- CreateIndex
CREATE INDEX "Approval_objectType_objectId_idx" ON "Approval"("objectType", "objectId");

-- CreateIndex
CREATE INDEX "Approval_decision_idx" ON "Approval"("decision");

-- CreateIndex
CREATE INDEX "AuditEvent_objectType_objectId_idx" ON "AuditEvent"("objectType", "objectId");

-- CreateIndex
CREATE INDEX "AuditEvent_actorId_occurredAt_idx" ON "AuditEvent"("actorId", "occurredAt");

-- CreateIndex
CREATE INDEX "AuditEvent_correlationId_idx" ON "AuditEvent"("correlationId");

-- CreateIndex
CREATE INDEX "AuditEvent_occurredAt_idx" ON "AuditEvent"("occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "Job_dedupeKey_key" ON "Job"("dedupeKey");

-- CreateIndex
CREATE INDEX "Job_status_runAt_idx" ON "Job"("status", "runAt");

-- AddForeignKey
ALTER TABLE "UserConstituency" ADD CONSTRAINT "UserConstituency_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserConstituency" ADD CONSTRAINT "UserConstituency_constituencyId_fkey" FOREIGN KEY ("constituencyId") REFERENCES "Constituency"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Mp" ADD CONSTRAINT "Mp_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Mp" ADD CONSTRAINT "Mp_constituencyId_fkey" FOREIGN KEY ("constituencyId") REFERENCES "Constituency"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Bill" ADD CONSTRAINT "Bill_committeeId_fkey" FOREIGN KEY ("committeeId") REFERENCES "Committee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ParliamentaryDocument" ADD CONSTRAINT "ParliamentaryDocument_sittingId_fkey" FOREIGN KEY ("sittingId") REFERENCES "Sitting"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ParliamentaryDocument" ADD CONSTRAINT "ParliamentaryDocument_billId_fkey" FOREIGN KEY ("billId") REFERENCES "Bill"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ParliamentaryDocument" ADD CONSTRAINT "ParliamentaryDocument_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ParliamentaryDocument" ADD CONSTRAINT "ParliamentaryDocument_reviewerId_fkey" FOREIGN KEY ("reviewerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentChunk" ADD CONSTRAINT "DocumentChunk_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "ParliamentaryDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CitizenCase" ADD CONSTRAINT "CitizenCase_constituencyId_fkey" FOREIGN KEY ("constituencyId") REFERENCES "Constituency"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CitizenCase" ADD CONSTRAINT "CitizenCase_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseMessage" ADD CONSTRAINT "CaseMessage_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "CitizenCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_approverId_fkey" FOREIGN KEY ("approverId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

