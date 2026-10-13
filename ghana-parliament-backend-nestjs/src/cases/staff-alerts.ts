import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Role } from '@prisma/client';
import { JobsService } from '../jobs/jobs.service';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationSender } from './notifications';

const JOB = 'staff.alert';

export type Audience = { kind: 'constituency'; constituencyId: string } | { kind: 'admins' } | { kind: 'users'; userIds: string[] };

type AlertPayload = {
  /** A user ID, or "mailbox:<address>" for an operations mailbox from OPS_ALERT_EMAILS. */
  recipient: string;
  subject: string;
  body: string;
};

const adminUrl = () => (process.env.ADMIN_APP_URL ?? 'http://localhost:5174').replace(/\/$/, '');

/** Operations mailboxes (not people) that also receive platform alerts, e.g. an on-call list. */
const opsMailboxes = () => (process.env.OPS_ALERT_EMAILS ?? '').split(',').map((s) => s.trim()).filter((s) => /^[^\s@]+@[^\s@]+$/.test(s));

/**
 * Tells staff that something needs them: a new or escalated case, an AI alert, an incident.
 * Messages carry a reference and a link to the admin console, never a citizen's words or details.
 * One job per recipient, so a retry never repeats a message that already went out.
 * Failures never break the action that triggered the alert; they are logged and visible as failed jobs.
 */
@Injectable()
export class StaffAlertService implements OnModuleInit {
  private readonly logger = new Logger(StaffAlertService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
    private readonly sender: NotificationSender,
  ) {}

  onModuleInit(): void {
    this.jobs.register(JOB, (payload) => this.deliver(payload as AlertPayload));
  }

  /** Queues one message per recipient. Returns how many were queued. Never throws. */
  async notify(audience: Audience, subject: string, path: string, line: string, dedupeKey: string): Promise<number> {
    if (process.env.STAFF_ALERTS === 'false') return 0;
    try {
      const recipients = await this.recipients(audience);
      const body = `${line}\n\nOpen the admin console: ${adminUrl()}${path}`;
      for (const r of recipients) {
        await this.jobs.enqueue(JOB, { recipient: r, subject, body } as AlertPayload, { dedupeKey: `${JOB}:${dedupeKey}:${r}` });
      }
      return recipients.length;
    } catch (e) {
      this.logger.error(`Could not queue staff alert "${subject}": ${(e as Error).message}`);
      return 0;
    }
  }

  async recipients(audience: Audience): Promise<string[]> {
    const active = { active: true };
    let ids: string[] = [];
    let includeMailboxes = false;
    if (audience.kind === 'constituency') {
      const staff = await this.prisma.user.findMany({
        where: { ...active, roles: { hasSome: [Role.STAFF, Role.MP] }, constituencies: { some: { constituencyId: audience.constituencyId } } },
        select: { id: true },
      });
      ids = staff.map((u) => u.id);
      // A constituency nobody is assigned to must not swallow an alert: administrators hear about it instead.
      if (!ids.length) return this.recipients({ kind: 'admins' });
    } else if (audience.kind === 'admins') {
      ids = (await this.prisma.user.findMany({ where: { ...active, roles: { has: Role.ADMIN } }, select: { id: true } })).map((u) => u.id);
      includeMailboxes = true;
    } else {
      ids = (await this.prisma.user.findMany({ where: { ...active, id: { in: audience.userIds } }, select: { id: true } })).map((u) => u.id);
    }
    return [...new Set([...ids, ...(includeMailboxes ? opsMailboxes().map((m) => `mailbox:${m}`) : [])])];
  }

  /** Job handler: throws to retry. */
  async deliver(p: AlertPayload): Promise<void> {
    let to: string | undefined;
    if (p.recipient.startsWith('mailbox:')) to = p.recipient.slice('mailbox:'.length);
    else to = (await this.prisma.user.findFirst({ where: { id: p.recipient, active: true }, select: { email: true } }))?.email;
    if (!to) return; // the person was deactivated since the alert was queued
    await this.sender.send({ channel: 'EMAIL', to, subject: p.subject, body: p.body });
  }
}
