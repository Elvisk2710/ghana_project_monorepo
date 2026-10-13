import { Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import { createTransport } from 'nodemailer';
import { LogSender, NotificationSender, OutboundMessage, UnconfiguredSender } from './notifications';

/** The slice of a nodemailer transport this module uses, so tests can supply a fake. */
export interface MailTransport {
  sendMail(m: { from: string; to: string; subject: string; text: string }): Promise<{ messageId?: string }>;
}

const need = (env: NodeJS.ProcessEnv, key: string) => {
  const v = env[key];
  if (!v) throw new Error(`${key} must be set for this notification provider`);
  return v;
};

/**
 * Posts every message as JSON to a delivery gateway (an SMS aggregator, an email API or an internal
 * relay): `{ channel, to, subject, body }`. A 2xx answer means accepted; anything else fails so the job retries.
 * The gateway may return `{ "id": "..." }`, which is kept as the provider reference.
 */
@Injectable()
export class WebhookSender extends NotificationSender {
  constructor(
    private readonly url: string,
    private readonly token?: string,
    private readonly timeoutMs = 10_000,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    super();
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): WebhookSender {
    const url = need(env, 'NOTIFICATION_WEBHOOK_URL');
    const u = new URL(url);
    if (env.NODE_ENV === 'production' && u.protocol !== 'https:') throw new Error('NOTIFICATION_WEBHOOK_URL must use https in production');
    return new WebhookSender(url, env.NOTIFICATION_WEBHOOK_TOKEN, Number(env.NOTIFICATION_TIMEOUT_MS ?? 10_000));
  }

  async send(msg: OutboundMessage): Promise<{ providerRef: string }> {
    const res = await this.fetchImpl(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) },
      body: JSON.stringify({ channel: msg.channel, to: msg.to, subject: msg.subject, body: msg.body }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`Delivery gateway answered ${res.status}`);
    const json = (await res.json().catch(() => null)) as { id?: unknown } | null;
    const ref = typeof json?.id === 'string' && json.id ? json.id : `webhook-${createHash('sha256').update(`${msg.to}|${msg.subject}|${Date.now()}`).digest('hex').slice(0, 16)}`;
    return { providerRef: ref };
  }
}

/** Sends email through an SMTP server. SMS is handed to the gateway sender when one is configured. */
@Injectable()
export class SmtpSender extends NotificationSender {
  constructor(
    private readonly transport: MailTransport,
    private readonly from: string,
    private readonly sms?: NotificationSender,
  ) {
    super();
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): SmtpSender {
    const port = Number(env.SMTP_PORT ?? 587);
    const transport = createTransport({
      host: need(env, 'SMTP_HOST'),
      port,
      secure: env.SMTP_SECURE ? env.SMTP_SECURE === 'true' : port === 465,
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: need(env, 'SMTP_PASSWORD') } : undefined,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
    return new SmtpSender(transport, need(env, 'SMTP_FROM'), env.NOTIFICATION_WEBHOOK_URL ? WebhookSender.fromEnv(env) : undefined);
  }

  async send(msg: OutboundMessage): Promise<{ providerRef: string }> {
    if (msg.channel === 'SMS') {
      if (!this.sms) throw new Error('SMS needs NOTIFICATION_WEBHOOK_URL: the SMTP provider only sends email');
      return this.sms.send(msg);
    }
    const info = await this.transport.sendMail({ from: this.from, to: msg.to, subject: msg.subject, text: msg.body });
    return { providerRef: info.messageId ?? `smtp-${Date.now()}` };
  }
}

/** Chooses the delivery provider from NOTIFICATION_PROVIDER: log | webhook | smtp. Unset fails every delivery visibly. */
export function createSender(env: NodeJS.ProcessEnv = process.env): NotificationSender {
  switch (env.NOTIFICATION_PROVIDER) {
    case undefined:
    case '':
      return new UnconfiguredSender();
    case 'log':
      if (env.NODE_ENV === 'production') throw new Error('NOTIFICATION_PROVIDER=log is for development only and must not be used in production');
      return new LogSender();
    case 'webhook':
      return WebhookSender.fromEnv(env);
    case 'smtp':
      return SmtpSender.fromEnv(env);
    default:
      throw new Error(`Unknown NOTIFICATION_PROVIDER "${env.NOTIFICATION_PROVIDER}" (use log, webhook or smtp)`);
  }
}
