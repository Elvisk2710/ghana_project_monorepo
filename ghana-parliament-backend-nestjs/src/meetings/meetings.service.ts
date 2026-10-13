import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { MeetingStatus } from '@prisma/client';
import type { Principal } from '../auth/principal';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { assertConstituencyAccess } from '../rbac/rbac';

export interface RequestMeetingInput {
  mpId: string;
  requestedName: string;
  topic: string;
  requestedSlot: string; // ISO datetime
  durationMinutes?: number;
  citizenContactRef?: string;
  caseId?: string;
}

const DAY_MS = 24 * 3600_000;
const MIN_LEAD_MS = 2 * 3600_000; // meetings need at least 2 hours' notice

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

@Injectable()
export class MeetingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ---------- MP availability windows ----------

  async listAvailability(principal: Principal, mpId: string) {
    const mp = await this.requireMp(mpId);
    assertConstituencyAccess(principal, mp.constituencyId);
    return this.prisma.mpAvailability.findMany({ where: { mpId }, orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }] });
  }

  /** Public, read-only: the windows a citizen may request a meeting inside, for a published MP only. */
  async publicAvailability(mpId: string) {
    const mp = await this.prisma.mp.findUnique({ where: { id: mpId } });
    if (!mp || !mp.isPublished) throw new NotFoundException('MP not found');
    return this.prisma.mpAvailability.findMany({ where: { mpId, active: true }, orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }], select: { dayOfWeek: true, startTime: true, endTime: true } });
  }

  async setAvailability(principal: Principal, mpId: string, windows: { dayOfWeek: number; startTime: string; endTime: string }[]) {
    const mp = await this.requireMp(mpId);
    assertConstituencyAccess(principal, mp.constituencyId);
    for (const w of windows) {
      if (w.dayOfWeek < 0 || w.dayOfWeek > 6) throw new BadRequestException('dayOfWeek must be 0-6');
      if (!/^\d{2}:\d{2}$/.test(w.startTime) || !/^\d{2}:\d{2}$/.test(w.endTime)) throw new BadRequestException('Times must be HH:mm');
      if (toMinutes(w.startTime) >= toMinutes(w.endTime)) throw new BadRequestException('startTime must be before endTime');
    }
    return this.prisma.$transaction(async (tx) => {
      await tx.mpAvailability.deleteMany({ where: { mpId } });
      if (!windows.length) return [];
      await tx.mpAvailability.createMany({ data: windows.map((w) => ({ mpId, ...w })) });
      return tx.mpAvailability.findMany({ where: { mpId }, orderBy: [{ dayOfWeek: 'asc' }] });
    });
  }

  /** Checks a requested slot falls inside one of the MP's open availability windows. */
  private async withinAvailability(mpId: string, slot: Date, durationMinutes: number): Promise<boolean> {
    const windows = await this.prisma.mpAvailability.findMany({ where: { mpId, dayOfWeek: slot.getUTCDay(), active: true } });
    const startMin = slot.getUTCHours() * 60 + slot.getUTCMinutes();
    const endMin = startMin + durationMinutes;
    return windows.some((w) => startMin >= toMinutes(w.startTime) && endMin <= toMinutes(w.endTime));
  }

  // ---------- Citizen-facing requests ----------

  async request(input: RequestMeetingInput) {
    const mp = await this.requireMp(input.mpId);
    if (!mp.isPublished) throw new NotFoundException('MP not found');
    const slot = new Date(input.requestedSlot);
    if (Number.isNaN(slot.getTime())) throw new BadRequestException('requestedSlot must be a valid date/time');
    if (slot.getTime() < Date.now() + MIN_LEAD_MS) throw new BadRequestException('Meetings need at least 2 hours notice');
    if (slot.getTime() > Date.now() + 90 * DAY_MS) throw new BadRequestException('Meetings can only be requested up to 90 days ahead');
    const duration = input.durationMinutes ?? 30;
    if (duration < 10 || duration > 120) throw new BadRequestException('durationMinutes must be between 10 and 120');
    if (!input.requestedName?.trim()) throw new BadRequestException('requestedName is required');
    if (!input.topic?.trim()) throw new BadRequestException('topic is required');

    const inWindow = await this.withinAvailability(mp.id, slot, duration);
    if (!inWindow) throw new BadRequestException('That time is outside the MP’s open availability. Please choose a published slot.');

    const meeting = await this.prisma.meeting.create({
      data: {
        mpId: mp.id,
        requestedName: input.requestedName.trim(),
        topic: input.topic.trim().slice(0, 300),
        requestedSlot: slot,
        durationMinutes: duration,
        citizenContactRef: input.citizenContactRef,
        caseId: input.caseId,
      },
    });
    await this.audit.recordSafe({ action: 'meeting.requested', outcome: 'success', objectType: 'meeting', objectId: meeting.id });
    return { id: meeting.id, status: meeting.status, requestedSlot: meeting.requestedSlot, durationMinutes: meeting.durationMinutes };
  }

  // ---------- Staff / MP side ----------

  async list(principal: Principal, mpId: string, status?: MeetingStatus) {
    const mp = await this.requireMp(mpId);
    assertConstituencyAccess(principal, mp.constituencyId);
    return this.prisma.meeting.findMany({ where: { mpId, ...(status ? { status } : {}) }, orderBy: { requestedSlot: 'asc' } });
  }

  async decide(principal: Principal, id: string, decision: 'CONFIRMED' | 'DECLINED', note?: string) {
    const meeting = await this.prisma.meeting.findUnique({ where: { id }, include: { mp: true } });
    if (!meeting) throw new NotFoundException('Meeting not found');
    assertConstituencyAccess(principal, meeting.mp.constituencyId);
    if (meeting.status !== 'REQUESTED') throw new BadRequestException('Only a requested meeting can be decided');
    const updated = await this.prisma.meeting.update({
      where: { id },
      data: {
        status: decision,
        confirmedSlot: decision === 'CONFIRMED' ? meeting.requestedSlot : null,
        staffNote: note,
        decidedById: principal.userId,
        decidedAt: new Date(),
      },
    });
    await this.audit.recordSafe({ action: `meeting.${decision.toLowerCase()}`, outcome: 'success', objectType: 'meeting', objectId: id });
    return updated;
  }

  async cancel(principal: Principal, id: string) {
    const meeting = await this.prisma.meeting.findUnique({ where: { id }, include: { mp: true } });
    if (!meeting) throw new NotFoundException('Meeting not found');
    assertConstituencyAccess(principal, meeting.mp.constituencyId);
    if (meeting.status === 'CANCELLED') return meeting;
    const updated = await this.prisma.meeting.update({ where: { id }, data: { status: 'CANCELLED', decidedById: principal.userId, decidedAt: new Date() } });
    await this.audit.recordSafe({ action: 'meeting.cancelled', outcome: 'success', objectType: 'meeting', objectId: id });
    return updated;
  }

  private async requireMp(mpId: string) {
    const mp = await this.prisma.mp.findUnique({ where: { id: mpId } });
    if (!mp) throw new NotFoundException('MP not found');
    return mp;
  }
}
