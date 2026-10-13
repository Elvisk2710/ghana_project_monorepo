import { BadRequestException, Controller, Get, NotFoundException, Param, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { BillStage, Prisma } from '@prisma/client';
import { Public } from '../auth/decorators';
import { rate } from '../common/rate';
import { PrismaService } from '../prisma/prisma.service';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const pubDocs = (): Prisma.ParliamentaryDocumentFindManyArgs => ({
  where: { lifecycle: 'PUBLISHED', isPublished: true },
  select: { publicId: true, title: true, type: true, documentDate: true },
  orderBy: [{ documentDate: 'desc' }, { publicId: 'asc' }],
});

/**
 * Public parliamentary business: published records only. Every relationship (bill <-> committee <->
 * sitting <-> document) is filtered so a cross-link can never reveal an unpublished record.
 */
@Public()
@Controller('public')
export class PublicOperationsController {
  constructor(private readonly prisma: PrismaService) {}

  private id(id: string) {
    if (!uuid.test(id)) throw new NotFoundException('Not found');
    return id;
  }

  @Get('bills') @Throttle(rate(60))
  async bills(@Query() q: Record<string, string>) {
    if (q.stage && !(Object.values(BillStage) as string[]).includes(q.stage)) throw new BadRequestException('Invalid stage');
    const where: Prisma.BillWhereInput = { isPublished: true, stage: q.stage as BillStage | undefined, ...(q.q ? { title: { contains: q.q.slice(0, 100), mode: 'insensitive' } } : {}) };
    const items = await this.prisma.bill.findMany({
      where, orderBy: [{ introducedOn: { sort: 'desc', nulls: 'last' } }, { id: 'asc' }], take: 100,
      select: { id: true, title: true, sponsor: true, stage: true, introducedOn: true, committee: { select: { id: true, name: true, isPublished: true } } },
    });
    return { items: items.map(({ committee, ...b }) => ({ ...b, committee: committee?.isPublished ? { id: committee.id, name: committee.name } : null })) };
  }

  @Get('bills/:id') @Throttle(rate(60))
  async bill(@Param('id') id: string) {
    const b = await this.prisma.bill.findFirst({
      where: { id: this.id(id), isPublished: true },
      select: {
        id: true, title: true, sponsor: true, stage: true, introducedOn: true, summary: true,
        committee: { select: { id: true, name: true, isPublished: true } },
        sittings: { where: { sitting: { isPublished: true } }, select: { sitting: { select: { id: true, date: true, type: true } } } },
        documents: pubDocs(),
      },
    });
    if (!b) throw new NotFoundException('Bill not found');
    return { ...b, committee: b.committee?.isPublished ? { id: b.committee.id, name: b.committee.name } : null, sittings: b.sittings.map((s) => s.sitting).sort((a, c) => +c.date - +a.date) };
  }

  @Get('sittings') @Throttle(rate(60))
  async sittings(@Query('from') from?: string, @Query('to') to?: string) {
    const f = from ? new Date(from) : undefined;
    const t = to ? new Date(to) : undefined;
    if ((f && Number.isNaN(+f)) || (t && Number.isNaN(+t))) throw new BadRequestException('from/to must be valid dates');
    const items = await this.prisma.sitting.findMany({ where: { isPublished: true, date: f || t ? { gte: f, lte: t } : undefined }, select: { id: true, date: true, type: true, status: true }, orderBy: [{ date: 'desc' }, { id: 'asc' }], take: 100 });
    return { items };
  }

  @Get('sittings/:id') @Throttle(rate(60))
  async sitting(@Param('id') id: string) {
    const s = await this.prisma.sitting.findFirst({
      where: { id: this.id(id), isPublished: true },
      select: { id: true, date: true, type: true, status: true, agenda: true, bills: { where: { bill: { isPublished: true } }, select: { bill: { select: { id: true, title: true, stage: true } } } }, documents: pubDocs() },
    });
    if (!s) throw new NotFoundException('Sitting not found');
    // Agenda items may point at a bill; keep the link only if that bill is public.
    const publicBills = new Set(s.bills.map((b) => b.bill.id));
    const agenda = ((s.agenda as { title: string; billId?: string }[] | null) ?? []).map((i) => ({ title: i.title, billId: i.billId && publicBills.has(i.billId) ? i.billId : undefined }));
    return { ...s, agenda, bills: s.bills.map((b) => b.bill) };
  }

  @Get('committees') @Throttle(rate(60))
  committees() {
    return this.prisma.committee.findMany({ where: { isPublished: true }, select: { id: true, name: true, remit: true }, orderBy: { name: 'asc' } }).then((items) => ({ items }));
  }

  @Get('committees/:id') @Throttle(rate(60))
  async committee(@Param('id') id: string) {
    const c = await this.prisma.committee.findFirst({
      where: { id: this.id(id), isPublished: true },
      select: {
        id: true, name: true, remit: true,
        chair: { select: { id: true, officialName: true, isPublished: true } },
        members: { where: { mp: { isPublished: true } }, select: { role: true, mp: { select: { id: true, officialName: true, party: true } } } },
        bills: { where: { isPublished: true }, select: { id: true, title: true, stage: true } },
      },
    });
    if (!c) throw new NotFoundException('Committee not found');
    return { ...c, chair: c.chair?.isPublished ? { id: c.chair.id, name: c.chair.officialName } : null, members: c.members.map((m) => ({ role: m.role, id: m.mp.id, name: m.mp.officialName, party: m.mp.party })) };
  }
}
