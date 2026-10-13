import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Job } from '@prisma/client';
import { JobsService } from '../jobs/jobs.service';
import { PrismaService } from '../prisma/prisma.service';
import { PUBLIC_STATUS_LABEL } from './rules';

export interface OutboundMessage {
  channel: 'EMAIL' | 'SMS';
  to: string;
  subject: string;
  body: string;
}

/** Delivery provider. Which channels/vendors Parliament uses is a Phase 0 decision. */
export abstract class NotificationSender {
  /** Resolves with a provider reference on success; throws on failure (the job retries). */
  abstract send(msg: OutboundMessage): Promise<{ providerRef: string }>;
}

/** Default when no provider is configured: every delivery fails visibly instead of pretending. */
@Injectable()
export class UnconfiguredSender extends NotificationSender {
  async send(): Promise<{ providerRef: string }> {
    throw new Error('No notification provider is configured (set NOTIFICATION_PROVIDER)');
  }
}

/** Development provider: writes the message to the log and records it as sent. */
@Injectable()
export class LogSender extends NotificationSender {
  private readonly logger = new Logger('NotificationLog');
  async send(msg: OutboundMessage): Promise<{ providerRef: string }> {
    this.logger.log(`[${msg.channel}] to=${msg.to.replace(/.(?=.{3})/g, '*')} subject="${msg.subject}"`);
    return { providerRef: `log-${Date.now()}` };
  }
}

export type NotificationKind = 'acknowledgement' | 'status_update' | 'response' | 'follow_up_request';

const JOB = 'notification.send';

/** Message text carries no case content: only the reference, the new status and a pointer to the tracking page. */
export function renderNotification(kind: NotificationKind, reference: string, status: keyof typeof PUBLIC_STATUS_LABEL, appUrl: string) {
  const link = `${appUrl.replace(/\/$/, '')}/issues`;
  const lines: Record<NotificationKind, [string, string]> = {
    acknowledgement: [`We received your issue ${reference}`, `Your issue ${reference} has been received and sent to the constituency office. Track it at ${link} using your reference and tracking code.`],
    status_update: [`Update on ${reference}`, `The status of your issue ${reference} is now: ${PUBLIC_STATUS_LABEL[status]}. See details at ${link}.`],
    response: [`New response on ${reference}`, `There is a new response to your issue ${reference}. Read it at ${link}.`],
    follow_up_request: [`We need more information on ${reference}`, `Your constituency office needs more information about issue ${reference}. Reply at ${link}.`],
  };
  const [subject, body] = lines[kind];
  return { subject, body };
}

@Injectable()
export class NotificationService implements OnModuleInit {
  private readonly logger = new Logger(NotificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
    private readonly sender: NotificationSender,
  ) {}

  onModuleInit(): void {
    this.jobs.register(JOB, (payload, job) => this.deliver(payload.notificationId, job));
  }

  /** Records the intent to notify and queues delivery. A citizen with no chosen channel gets no message. */
  async enqueue(caseId: string, kind: NotificationKind, opts: { messageId?: string; correlationId?: string } = {}): Promise<string | null> {
    const contact = await this.prisma.caseContact.findUnique({ where: { caseId } });
    if (!contact || contact.channel === 'NONE') return null;
    const n = await this.prisma.notification.create({ data: { caseId, kind, channel: contact.channel, messageId: opts.messageId } });
    await this.jobs.enqueue(JOB, { notificationId: n.id }, { dedupeKey: `notify:${n.id}`, correlationId: opts.correlationId });
    return n.id;
  }

  /** Job handler. Throws to retry; marks the notification FAILED when attempts are exhausted. */
  async deliver(notificationId: string, job: Pick<Job, 'attempts' | 'maxAttempts'>): Promise<void> {
    const n = await this.prisma.notification.findUnique({ where: { id: notificationId }, include: { case: { include: { contact: true } } } });
    if (!n || n.state === 'SENT' || n.state === 'DELIVERED') return;
    const contact = n.case.contact;
    const to = n.channel === 'EMAIL' ? contact?.email : contact?.phone;
    try {
      if (!to) throw new Error('Contact details are no longer available');
      const msg = renderNotification(n.kind as NotificationKind, n.case.publicId, n.case.status, process.env.PUBLIC_APP_URL ?? 'http://localhost:5173');
      const { providerRef } = await this.sender.send({ channel: n.channel as 'EMAIL' | 'SMS', to, ...msg });
      await this.prisma.notification.update({ where: { id: n.id }, data: { state: 'SENT', attempts: job.attempts, lastError: null, sentAt: new Date(), payload: { providerRef } } });
      if (n.messageId) await this.prisma.caseMessage.updateMany({ where: { id: n.messageId }, data: { deliveryState: 'SENT' } });
    } catch (e) {
      const message = (e as Error).message.slice(0, 500);
      const final = job.attempts >= job.maxAttempts || !to;
      await this.prisma.notification.update({ where: { id: n.id }, data: { attempts: job.attempts, lastError: message, state: final ? 'FAILED' : 'PENDING' } });
      if (final && n.messageId) await this.prisma.caseMessage.updateMany({ where: { id: n.messageId }, data: { deliveryState: 'FAILED' } });
      this.logger.warn(`Notification ${n.id} attempt ${job.attempts} failed: ${message}`);
      if (!final) throw e;
    }
  }
}
