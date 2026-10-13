-- AlterTable
ALTER TABLE "User" ADD COLUMN     "lastLoginAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Committee" ADD COLUMN     "isPublished" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Bill" ADD COLUMN     "summary" TEXT;

-- AlterTable
ALTER TABLE "Approval" ADD COLUMN     "action" TEXT NOT NULL DEFAULT 'publish',
ADD COLUMN     "objectLabel" TEXT,
ADD COLUMN     "reason" TEXT,
ADD COLUMN     "requesterId" UUID;

-- CreateTable
CREATE TABLE "CommitteeMember" (
    "committeeId" UUID NOT NULL,
    "mpId" UUID NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'Member',

    CONSTRAINT "CommitteeMember_pkey" PRIMARY KEY ("committeeId","mpId")
);

-- CreateTable
CREATE TABLE "BillSitting" (
    "billId" UUID NOT NULL,
    "sittingId" UUID NOT NULL,

    CONSTRAINT "BillSitting_pkey" PRIMARY KEY ("billId","sittingId")
);

-- AddForeignKey
ALTER TABLE "CommitteeMember" ADD CONSTRAINT "CommitteeMember_committeeId_fkey" FOREIGN KEY ("committeeId") REFERENCES "Committee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommitteeMember" ADD CONSTRAINT "CommitteeMember_mpId_fkey" FOREIGN KEY ("mpId") REFERENCES "Mp"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillSitting" ADD CONSTRAINT "BillSitting_billId_fkey" FOREIGN KEY ("billId") REFERENCES "Bill"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillSitting" ADD CONSTRAINT "BillSitting_sittingId_fkey" FOREIGN KEY ("sittingId") REFERENCES "Sitting"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Committee" ADD CONSTRAINT "Committee_chairMpId_fkey" FOREIGN KEY ("chairMpId") REFERENCES "Mp"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

