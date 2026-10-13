import { createServer, IncomingMessage } from 'http';
import { AddressInfo } from 'net';
import { LogSender, UnconfiguredSender } from '../src/cases/notifications';
import { createSender, SmtpSender, WebhookSender } from '../src/cases/senders';
import { CASE_LIMITS, environmentCaseSettings, validateCaseSettings } from '../src/settings/settings.service';

const msg = { channel: 'EMAIL' as const, to: 'a@b.gh', subject: 'Hello', body: 'Body' };

describe('createSender', () => {
  it('fails visibly when nothing is configured', () => {
    expect(createSender({})).toBeInstanceOf(UnconfiguredSender);
  });
  it('allows the log provider in development only', () => {
    expect(createSender({ NOTIFICATION_PROVIDER: 'log' })).toBeInstanceOf(LogSender);
    expect(() => createSender({ NOTIFICATION_PROVIDER: 'log', NODE_ENV: 'production' })).toThrow(/development only/);
  });
  it('rejects unknown providers and incomplete configuration at boot', () => {
    expect(() => createSender({ NOTIFICATION_PROVIDER: 'carrier-pigeon' })).toThrow(/Unknown NOTIFICATION_PROVIDER/);
    expect(() => createSender({ NOTIFICATION_PROVIDER: 'webhook' })).toThrow(/NOTIFICATION_WEBHOOK_URL/);
    expect(() => createSender({ NOTIFICATION_PROVIDER: 'smtp' })).toThrow(/SMTP_HOST/);
    expect(() => createSender({ NOTIFICATION_PROVIDER: 'smtp', SMTP_HOST: 'mail.test' })).toThrow(/SMTP_FROM/);
    expect(() => createSender({ NOTIFICATION_PROVIDER: 'webhook', NOTIFICATION_WEBHOOK_URL: 'http://gw.test/send', NODE_ENV: 'production' })).toThrow(/https/);
  });
  it('builds the configured providers', () => {
    expect(createSender({ NOTIFICATION_PROVIDER: 'webhook', NOTIFICATION_WEBHOOK_URL: 'https://gw.test/send' })).toBeInstanceOf(WebhookSender);
    expect(createSender({ NOTIFICATION_PROVIDER: 'smtp', SMTP_HOST: 'mail.test', SMTP_FROM: 'noreply@parliament.gh' })).toBeInstanceOf(SmtpSender);
  });
});

describe('WebhookSender', () => {
  let received: { auth?: string; body: any }[] = [];
  let status = 200;
  let reply: unknown = { id: 'gw-42' };
  const server = createServer((req: IncomingMessage, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      received.push({ auth: req.headers.authorization, body: JSON.parse(raw) });
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply));
    });
  });
  let url = '';
  beforeAll((done) => { server.listen(0, '127.0.0.1', () => { url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/send`; done(); }); });
  afterAll((done) => { server.close(() => done()); });
  beforeEach(() => { received = []; status = 200; reply = { id: 'gw-42' }; });

  it('posts the message with the bearer token and keeps the gateway reference', async () => {
    const r = await new WebhookSender(url, 'secret').send({ ...msg, channel: 'SMS', to: '0244000000' });
    expect(r.providerRef).toBe('gw-42');
    expect(received[0].auth).toBe('Bearer secret');
    expect(received[0].body).toEqual({ channel: 'SMS', to: '0244000000', subject: 'Hello', body: 'Body' });
  });
  it('makes up a reference when the gateway returns none', async () => {
    reply = {};
    expect((await new WebhookSender(url).send(msg)).providerRef).toMatch(/^webhook-[0-9a-f]{16}$/);
  });
  it('fails (so the job retries) when the gateway refuses', async () => {
    status = 503;
    await expect(new WebhookSender(url).send(msg)).rejects.toThrow(/503/);
  });
  it('fails when the gateway cannot be reached', async () => {
    await expect(new WebhookSender('http://127.0.0.1:1/send', undefined, 500).send(msg)).rejects.toThrow();
  });
});

describe('SmtpSender', () => {
  it('sends email through the transport', async () => {
    const sent: any[] = [];
    const s = new SmtpSender({ sendMail: async (m) => { sent.push(m); return { messageId: '<m1@parliament.gh>' }; } }, 'Parliament <noreply@parliament.gh>');
    expect(await s.send(msg)).toEqual({ providerRef: '<m1@parliament.gh>' });
    expect(sent[0]).toEqual({ from: 'Parliament <noreply@parliament.gh>', to: 'a@b.gh', subject: 'Hello', text: 'Body' });
  });
  it('propagates transport failures', async () => {
    const s = new SmtpSender({ sendMail: async () => { throw new Error('connection refused'); } }, 'x@y.gh');
    await expect(s.send(msg)).rejects.toThrow(/connection refused/);
  });
  it('refuses SMS unless a gateway is configured, and otherwise hands it over', async () => {
    const transport = { sendMail: async () => ({}) };
    await expect(new SmtpSender(transport, 'x@y.gh').send({ ...msg, channel: 'SMS' })).rejects.toThrow(/NOTIFICATION_WEBHOOK_URL/);
    const viaGateway = new SmtpSender(transport, 'x@y.gh', { send: async () => ({ providerRef: 'sms-1' }) } as any);
    expect(await viaGateway.send({ ...msg, channel: 'SMS' })).toEqual({ providerRef: 'sms-1' });
  });
});

describe('case settings validation', () => {
  const ok = { retentionDays: 730, slaHours: 120, slaUrgentHours: 24 };
  it('accepts in-range whole numbers', () => {
    expect(validateCaseSettings(ok)).toEqual(ok);
  });
  it.each([
    ['a missing field', { retentionDays: 1, slaHours: 2 }],
    ['a non-number', { ...ok, slaHours: '120' }],
    ['a fraction', { ...ok, slaHours: 1.5 }],
    ['zero', { ...ok, retentionDays: 0 }],
    ['too large', { ...ok, retentionDays: CASE_LIMITS.retentionDays.max + 1 }],
    ['an unknown field', { ...ok, other: 1 }],
    ['urgent longer than normal', { ...ok, slaHours: 10, slaUrgentHours: 11 }],
    ['an array', []],
    ['null', null],
  ])('rejects %s', (_n, v) => {
    expect(() => validateCaseSettings(v)).toThrow();
  });
  it('reads the environment and says where each value came from', () => {
    const r = environmentCaseSettings({ CASE_SLA_HOURS: '72' } as any);
    expect(r.values).toEqual({ retentionDays: 730, slaHours: 72, slaUrgentHours: 24 });
    expect(r.sources).toEqual({ retentionDays: 'default', slaHours: 'environment', slaUrgentHours: 'default' });
    expect(() => environmentCaseSettings({ CASE_SLA_HOURS: 'abc' } as any)).toThrow(/CASE_SLA_HOURS/);
  });
});
