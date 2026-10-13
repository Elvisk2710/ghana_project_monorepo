import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { FeedbackSentiment } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';

// A bill is in force once it has received presidential assent.
const IN_FORCE_STAGES = ['ASSENTED'] as const;

@Injectable()
export class BillFeedbackService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Citizens may give post-enactment feedback only on a published, in-force bill. */
  async submit(billId: string, sentiment: FeedbackSentiment, comment?: string) {
    const bill = await this.prisma.bill.findUnique({ where: { id: billId } });
    if (!bill || !bill.isPublished) throw new NotFoundException('Bill not found');
    if (!(IN_FORCE_STAGES as readonly string[]).includes(bill.stage)) {
      throw new BadRequestException('Feedback can only be given once a bill is enacted and in force');
    }
    const feedback = await this.prisma.billFeedback.create({
      data: { billId, sentiment, comment: comment?.trim().slice(0, 1000) || null },
    });
    await this.audit.recordSafe({ action: 'bill.feedback.submitted', outcome: 'success', objectType: 'bill', objectId: billId });
    return { id: feedback.id, thankYou: 'Thank you. Your feedback on this policy has been recorded.' };
  }

  /** Aggregated, never individually attributed beyond sentiment + optional comment. */
  async summary(billId: string) {
    const bill = await this.prisma.bill.findUnique({ where: { id: billId } });
    if (!bill) throw new NotFoundException('Bill not found');
    const counts = await this.prisma.billFeedback.groupBy({ by: ['sentiment'], where: { billId }, _count: { _all: true } });
    const total = counts.reduce((sum, c) => sum + c._count._all, 0);
    const byLabel = Object.fromEntries((['POSITIVE', 'NEUTRAL', 'NEGATIVE'] as const).map((s) => [s, counts.find((c) => c.sentiment === s)?._count._all ?? 0]));
    const recentComments = await this.prisma.billFeedback.findMany({
      where: { billId, comment: { not: null } },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: { sentiment: true, comment: true, createdAt: true },
    });
    return { billId, total, byLabel, recentComments };
  }
}
