-- CreateEnum
CREATE TYPE "AiArtifactKind" AS ENUM ('MODEL', 'PROMPT', 'RETRIEVER', 'DATASET');

-- CreateEnum
CREATE TYPE "AiVersionStatus" AS ENUM ('AVAILABLE', 'RETIRED');

-- CreateEnum
CREATE TYPE "EvalRunStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "DeploymentStatus" AS ENUM ('PENDING_APPROVAL', 'ACTIVE', 'SUPERSEDED', 'ROLLED_BACK', 'REJECTED');

-- CreateEnum
CREATE TYPE "AlertStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'RESOLVED');

-- CreateEnum
CREATE TYPE "IncidentSeverity" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "IncidentStatus" AS ENUM ('OPEN', 'MITIGATED', 'RESOLVED');

-- AlterTable
ALTER TABLE "QuestionSession" ADD COLUMN     "deploymentId" UUID,
ADD COLUMN     "failureReason" TEXT,
ADD COLUMN     "incidentId" UUID,
ADD COLUMN     "sources" JSONB,
ADD COLUMN     "topScore" DOUBLE PRECISION,
ADD COLUMN     "withdrawnAt" TIMESTAMP(3),
ADD COLUMN     "withdrawnReason" TEXT;

-- CreateTable
CREATE TABLE "AiVersion" (
    "id" UUID NOT NULL,
    "kind" "AiArtifactKind" NOT NULL,
    "name" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "description" TEXT,
    "ownerId" UUID NOT NULL,
    "config" JSONB NOT NULL,
    "checksum" TEXT NOT NULL,
    "status" "AiVersionStatus" NOT NULL DEFAULT 'AVAILABLE',
    "retiredAt" TIMESTAMP(3),
    "retiredReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EvalCase" (
    "id" UUID NOT NULL,
    "datasetId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'en',
    "constituency" TEXT,
    "tags" TEXT[],
    "expectedStatus" TEXT NOT NULL DEFAULT 'grounded',
    "expectedDocumentIds" TEXT[],
    "mustContain" TEXT[],
    "mustNotContain" TEXT[],

    CONSTRAINT "EvalCase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EvalRun" (
    "id" UUID NOT NULL,
    "datasetId" UUID NOT NULL,
    "modelId" UUID NOT NULL,
    "promptId" UUID NOT NULL,
    "retrieverId" UUID NOT NULL,
    "status" "EvalRunStatus" NOT NULL DEFAULT 'QUEUED',
    "total" INTEGER NOT NULL,
    "completed" INTEGER NOT NULL DEFAULT 0,
    "startedById" UUID NOT NULL,
    "thresholds" JSONB NOT NULL,
    "summary" JSONB,
    "slices" JSONB,
    "gate" JSONB,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "EvalRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EvalResult" (
    "id" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "caseId" UUID NOT NULL,
    "language" TEXT NOT NULL,
    "constituency" TEXT,
    "tags" TEXT[],
    "expectedStatus" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "correct" BOOLEAN NOT NULL,
    "statusMatch" BOOLEAN NOT NULL,
    "retrievalHit" BOOLEAN,
    "citationOk" BOOLEAN,
    "contentOk" BOOLEAN NOT NULL,
    "harmful" BOOLEAN NOT NULL,
    "answer" TEXT,
    "citedDocumentIds" TEXT[],
    "retrievedDocumentIds" TEXT[],
    "latencyMs" INTEGER NOT NULL,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EvalResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiDeployment" (
    "id" UUID NOT NULL,
    "modelId" UUID NOT NULL,
    "promptId" UUID NOT NULL,
    "retrieverId" UUID NOT NULL,
    "evalRunId" UUID NOT NULL,
    "status" "DeploymentStatus" NOT NULL DEFAULT 'PENDING_APPROVAL',
    "requesterId" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "approvalId" UUID,
    "rollbackTargetId" UUID,
    "thresholds" JSONB,
    "notes" TEXT,
    "activatedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "endedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiDeployment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MonitorAlert" (
    "id" UUID NOT NULL,
    "rule" TEXT NOT NULL,
    "scopeKey" TEXT NOT NULL DEFAULT '',
    "severity" "IncidentSeverity" NOT NULL,
    "deploymentId" UUID,
    "metric" TEXT NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    "threshold" DOUBLE PRECISION NOT NULL,
    "sampleSize" INTEGER NOT NULL,
    "detail" JSONB,
    "status" "AlertStatus" NOT NULL DEFAULT 'OPEN',
    "firedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledgedById" UUID,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "MonitorAlert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiIncident" (
    "id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "severity" "IncidentSeverity" NOT NULL,
    "status" "IncidentStatus" NOT NULL DEFAULT 'OPEN',
    "ownerId" UUID NOT NULL,
    "reporterId" UUID NOT NULL,
    "scope" JSONB NOT NULL,
    "alertId" UUID,
    "resolution" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "mitigatedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "AiIncident_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SystemFlag" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedById" UUID,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SystemFlag_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "AiVersion_kind_status_idx" ON "AiVersion"("kind", "status");

-- CreateIndex
CREATE UNIQUE INDEX "AiVersion_kind_name_version_key" ON "AiVersion"("kind", "name", "version");

-- CreateIndex
CREATE UNIQUE INDEX "EvalCase_datasetId_key_key" ON "EvalCase"("datasetId", "key");

-- CreateIndex
CREATE INDEX "EvalRun_status_idx" ON "EvalRun"("status");

-- CreateIndex
CREATE UNIQUE INDEX "EvalResult_runId_caseId_key" ON "EvalResult"("runId", "caseId");

-- CreateIndex
CREATE UNIQUE INDEX "AiDeployment_approvalId_key" ON "AiDeployment"("approvalId");

-- CreateIndex
CREATE INDEX "AiDeployment_status_idx" ON "AiDeployment"("status");

-- CreateIndex
CREATE INDEX "MonitorAlert_status_severity_idx" ON "MonitorAlert"("status", "severity");

-- CreateIndex
CREATE INDEX "AiIncident_status_severity_idx" ON "AiIncident"("status", "severity");

-- CreateIndex
CREATE INDEX "QuestionSession_deploymentId_createdAt_idx" ON "QuestionSession"("deploymentId", "createdAt");

-- AddForeignKey
ALTER TABLE "EvalCase" ADD CONSTRAINT "EvalCase_datasetId_fkey" FOREIGN KEY ("datasetId") REFERENCES "AiVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvalRun" ADD CONSTRAINT "EvalRun_datasetId_fkey" FOREIGN KEY ("datasetId") REFERENCES "AiVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvalRun" ADD CONSTRAINT "EvalRun_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES "AiVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvalRun" ADD CONSTRAINT "EvalRun_promptId_fkey" FOREIGN KEY ("promptId") REFERENCES "AiVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvalRun" ADD CONSTRAINT "EvalRun_retrieverId_fkey" FOREIGN KEY ("retrieverId") REFERENCES "AiVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvalResult" ADD CONSTRAINT "EvalResult_runId_fkey" FOREIGN KEY ("runId") REFERENCES "EvalRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvalResult" ADD CONSTRAINT "EvalResult_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "EvalCase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiDeployment" ADD CONSTRAINT "AiDeployment_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES "AiVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiDeployment" ADD CONSTRAINT "AiDeployment_promptId_fkey" FOREIGN KEY ("promptId") REFERENCES "AiVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiDeployment" ADD CONSTRAINT "AiDeployment_retrieverId_fkey" FOREIGN KEY ("retrieverId") REFERENCES "AiVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiDeployment" ADD CONSTRAINT "AiDeployment_evalRunId_fkey" FOREIGN KEY ("evalRunId") REFERENCES "EvalRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------------------------
-- Integrity rules enforced by the database itself (Phase 5, T-073/T-074).
-- ---------------------------------------------------------------------------------------------

-- A registered model/prompt/retriever/dataset version never changes. A different config is a new
-- version. Only retirement (status, retiredAt, retiredReason) may be updated, and rows are never deleted.
CREATE OR REPLACE FUNCTION ai_version_immutable() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'AiVersion rows cannot be deleted; retire the version instead' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."kind" IS DISTINCT FROM OLD."kind" OR NEW."name" IS DISTINCT FROM OLD."name"
     OR NEW."version" IS DISTINCT FROM OLD."version" OR NEW."config"::text IS DISTINCT FROM OLD."config"::text
     OR NEW."checksum" IS DISTINCT FROM OLD."checksum" OR NEW."ownerId" IS DISTINCT FROM OLD."ownerId"
     OR NEW."description" IS DISTINCT FROM OLD."description" THEN
    RAISE EXCEPTION 'AiVersion is immutable once registered; register a new version' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ai_version_immutable_trg BEFORE UPDATE OR DELETE ON "AiVersion"
  FOR EACH ROW EXECUTE FUNCTION ai_version_immutable();

-- Evaluation cases and results are evidence: written once, never edited or removed.
CREATE OR REPLACE FUNCTION ai_evidence_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only evidence: % is not permitted', TG_TABLE_NAME, TG_OP USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER eval_case_immutable BEFORE UPDATE OR DELETE ON "EvalCase"
  FOR EACH ROW EXECUTE FUNCTION ai_evidence_immutable();
CREATE TRIGGER eval_result_immutable BEFORE UPDATE OR DELETE ON "EvalResult"
  FOR EACH ROW EXECUTE FUNCTION ai_evidence_immutable();

-- A finished evaluation run (and the gate verdict on it) cannot be rewritten.
CREATE OR REPLACE FUNCTION eval_run_frozen() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'EvalRun rows cannot be deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."status" IN ('COMPLETED', 'FAILED') THEN
    RAISE EXCEPTION 'EvalRun is frozen once finished' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER eval_run_frozen_trg BEFORE UPDATE OR DELETE ON "EvalRun"
  FOR EACH ROW EXECUTE FUNCTION eval_run_frozen();

-- Deployments are history: they can change state but never be removed.
CREATE OR REPLACE FUNCTION ai_deployment_no_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'AiDeployment rows cannot be deleted' USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ai_deployment_no_delete_trg BEFORE DELETE ON "AiDeployment"
  FOR EACH ROW EXECUTE FUNCTION ai_deployment_no_delete();

-- At most one live deployment at a time.
CREATE UNIQUE INDEX "AiDeployment_single_active" ON "AiDeployment" ((true)) WHERE "status" = 'ACTIVE';

-- One live alert per rule and scope, so repeated monitoring runs update it instead of duplicating it.
CREATE UNIQUE INDEX "MonitorAlert_one_live" ON "MonitorAlert" ("rule", "scopeKey", COALESCE("deploymentId", '00000000-0000-0000-0000-000000000000'::uuid)) WHERE "status" <> 'RESOLVED';
