-- CreateTable
CREATE TABLE "ErasureLedger" (
    "id" UUID NOT NULL,
    "caseId" UUID NOT NULL,
    "reference" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "erasedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ErasureLedger_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ErasureLedger_caseId_key" ON "ErasureLedger"("caseId");

-- CreateIndex
CREATE INDEX "ErasureLedger_erasedAt_idx" ON "ErasureLedger"("erasedAt");

-- The ledger is append-only: an erasure, once recorded, cannot be un-recorded by the application.
CREATE OR REPLACE FUNCTION erasure_ledger_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ErasureLedger is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER erasure_ledger_no_update_delete
  BEFORE UPDATE OR DELETE ON "ErasureLedger"
  FOR EACH ROW EXECUTE FUNCTION erasure_ledger_immutable();

CREATE TRIGGER erasure_ledger_no_truncate
  BEFORE TRUNCATE ON "ErasureLedger"
  FOR EACH STATEMENT EXECUTE FUNCTION erasure_ledger_immutable();
