import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { freshDatabaseUrl } from './db';

const IDP_PORT = 54331;
const ALF_PORT = 54332;
process.env.DATABASE_URL = freshDatabaseUrl('oidc');
process.env.OIDC_ISSUER = `http://127.0.0.1:${IDP_PORT}/realm`;
process.env.OIDC_AUDIENCE = 'parliament-api';
process.env.JOBS_ENABLED = 'false';
process.env.THROTTLE_LIMIT = '100000';
process.env.ALFRESCO_BASE_URL = `http://127.0.0.1:${ALF_PORT}`;
process.env.ALFRESCO_USER = 'svc-parliament';
process.env.ALFRESCO_PASSWORD = 'server-side-secret';
process.env.ALFRESCO_FOLDER_ID = 'folder-1';

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { exportJWK, generateKeyPair, KeyLike, SignJWT } from 'jose';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { JobsService } from '../../src/jobs/jobs.service';

const ISS = process.env.OIDC_ISSUER!;
const AUD = process.env.OIDC_AUDIENCE!;

// ---------- Stand-in Alfresco speaking the real REST API shapes ----------
const nodes = new Map<string, { name: string; mimeType: string; data: Buffer }>();
let ticketsIssued = 0;
let expireTickets = false;
const alfrescoLog: string[] = [];

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

async function alfresco(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url!, 'http://x');
  const send = (status: number, body: unknown, type = 'application/json') => {
    res.writeHead(status, { 'Content-Type': type });
    res.end(Buffer.isBuffer(body) ? body : typeof body === 'string' ? body : JSON.stringify(body));
  };
  const body = await readBody(req);
  alfrescoLog.push(`${req.method} ${url.pathname}`);

  if (url.pathname.endsWith('/authentication/versions/1/tickets') && req.method === 'POST') {
    const creds = JSON.parse(body.toString());
    if (creds.userId !== 'svc-parliament' || creds.password !== 'server-side-secret') return send(403, {});
    ticketsIssued++;
    return send(201, { entry: { id: `TICKET_${ticketsIssued}`, userId: creds.userId } });
  }
  const auth = req.headers.authorization?.replace('Basic ', '');
  const ticket = auth ? Buffer.from(auth, 'base64').toString() : '';
  if (!ticket.startsWith('TICKET_') || (expireTickets && ticket === 'TICKET_1')) return send(401, {});

  const m = url.pathname.match(/\/nodes\/([^/]+)(\/children|\/content)?$/);
  if (!m) return send(404, {});
  const [, id, sub] = m;
  const entry = (nid: string) => {
    const n = nodes.get(nid)!;
    return { id: nid, name: n.name, modifiedAt: '2026-10-09T00:00:00Z', content: { mimeType: n.mimeType, sizeInBytes: n.data.length } };
  };
  if (req.method === 'GET' && sub === '/children') return send(200, { list: { entries: [...nodes.keys()].map((k) => ({ entry: entry(k) })) } });
  if (req.method === 'GET' && sub === '/content') return nodes.has(id) ? send(200, nodes.get(id)!.data, nodes.get(id)!.mimeType) : send(404, {});
  if (req.method === 'GET') return nodes.has(id) ? send(200, { entry: entry(id) }) : send(404, {});
  if (req.method === 'POST' && sub === '/children') {
    const boundary = req.headers['content-type']!.match(/boundary=(.+)$/)![1];
    const part = body.toString('latin1').split(`--${boundary}`).find((p) => p.includes('name="filedata"'))!;
    const filename = part.match(/filename="([^"]+)"/)![1];
    const mimeType = part.match(/Content-Type: ([^\r\n]+)/i)?.[1] ?? 'application/octet-stream';
    const start = part.indexOf('\r\n\r\n') + 4;
    const data = Buffer.from(part.slice(start, part.length - 2), 'latin1');
    const nid = `node-${nodes.size + 1}`;
    nodes.set(nid, { name: filename, mimeType, data });
    return send(201, { entry: entry(nid) });
  }
  return send(404, {});
}

// ---------- Stand-in identity provider (JWKS) ----------
let idp: Server;
let alf: Server;
let signKey: KeyLike;
let otherKey: KeyLike;

const mint = (over: { sub?: string; iss?: string; aud?: string; exp?: string | number; key?: KeyLike } = {}) =>
  new SignJWT({ email: 'x@parliament.gh' })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setSubject(over.sub ?? 'oidc-staff')
    .setIssuer(over.iss ?? ISS)
    .setAudience(over.aud ?? AUD)
    .setIssuedAt()
    .setExpirationTime(over.exp ?? '5m')
    .sign(over.key ?? signKey);

describe('Real OIDC verification and Alfresco adapter over HTTP', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let jobs: JobsService;

  beforeAll(async () => {
    const pair = await generateKeyPair('RS256');
    signKey = pair.privateKey;
    otherKey = (await generateKeyPair('RS256')).privateKey;
    const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
    idp = createServer((req, res) => {
      if (req.url === '/realm/.well-known/jwks.json') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ keys: [jwk] }));
      }
      res.writeHead(404).end();
    }).listen(IDP_PORT);
    alf = createServer((req, res) => void alfresco(req, res)).listen(ALF_PORT);

    prisma = new PrismaClient();
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile(); // real verifier, real Alfresco client
    app = mod.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    jobs = app.get(JobsService);
    await prisma.user.createMany({
      data: [
        { externalId: 'oidc-staff', email: 'staff2@parliament.gh', displayName: 'Staff', roles: ['STAFF'] },
        { externalId: 'oidc-inactive', email: 'gone@parliament.gh', displayName: 'Gone', roles: ['STAFF'], active: false },
      ],
    });
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
    idp.close();
    alf.close();
  });

  const get = (token?: string) => {
    const r = request(app.getHttpServer()).get('/api/v1/internal/me');
    return token ? r.set('Authorization', `Bearer ${token}`) : r;
  };

  describe('OIDC token verification (T-021)', () => {
    it('accepts a valid signed token and resolves roles from the database', async () => {
      const res = await get(await mint()).expect(200);
      expect(res.body).toMatchObject({ externalId: 'oidc-staff', roles: ['STAFF'] });
    });
    it('rejects an expired token', async () => {
      await get(await mint({ exp: Math.floor(Date.now() / 1000) - 120 })).expect(401);
    });
    it('rejects the wrong audience', async () => {
      await get(await mint({ aud: 'some-other-api' })).expect(401);
    });
    it('rejects the wrong issuer', async () => {
      await get(await mint({ iss: 'http://evil.example/realm' })).expect(401);
    });
    it('rejects a token signed with a different key', async () => {
      await get(await mint({ key: otherKey })).expect(401);
    });
    it('rejects an unsigned (alg=none) token and garbage', async () => {
      const none = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: 'oidc-staff', iss: ISS, aud: AUD, exp: 9999999999 })).toString('base64url')}.`;
      await get(none).expect(401);
      await get('not-a-jwt').expect(401);
    });
    it('does not let a valid token grant access to an inactive or unprovisioned user', async () => {
      await get(await mint({ sub: 'oidc-inactive' })).expect(403);
      await get(await mint({ sub: 'oidc-nobody' })).expect(403);
    });
  });

  describe('Alfresco adapter (T-025)', () => {
    const text = 'The Honourable Minister presented the petroleum pricing statement to the House. '.repeat(20);

    it('uploads through the server-side adapter using server credentials, never the browser', async () => {
      const token = await mint();
      const res = await request(app.getHttpServer())
        .post('/api/v1/internal/documents').set('Authorization', `Bearer ${token}`)
        .field('title', 'Statement on Fuel Levy').field('type', 'OTHER').field('documentDate', '2025-01-10').field('sensitivity', 'public')
        .attach('file', Buffer.from(text), { filename: 'statement.txt', contentType: 'text/plain' }).expect(201);
      expect(res.body.sourceUri).toMatch(/^alfresco:\/\/node-\d+$/);
      const stored = nodes.get(res.body.sourceUri.replace('alfresco://', ''))!;
      expect(stored.name).toBe('statement.txt');
      expect(stored.data.toString()).toBe(text);
    });

    it('processing downloads the content back from Alfresco and verifies the checksum', async () => {
      await jobs.drain();
      const doc = await prisma.parliamentaryDocument.findFirstOrThrow({ where: { title: 'Statement on Fuel Levy' } });
      expect(doc.lifecycle).toBe('REVIEW');
      expect(doc.extractedText).toContain('petroleum pricing statement');
    });

    it('lists repository files and syncs an existing node into the pipeline', async () => {
      nodes.set('existing-1', { name: 'order_paper.txt', mimeType: 'text/plain', data: Buffer.from('Order of business for the day. '.repeat(30)) });
      const token = await mint();
      const list = await request(app.getHttpServer()).get('/api/v1/internal/repository/nodes').set('Authorization', `Bearer ${token}`).expect(200);
      expect(list.body.map((n: any) => n.id)).toContain('existing-1');
      const sync = await request(app.getHttpServer()).post('/api/v1/internal/repository/sync').set('Authorization', `Bearer ${token}`).send({ nodeId: 'existing-1', type: 'ORDER_PAPER' }).expect(201);
      expect(sync.body.sourceUri).toBe('alfresco://existing-1');
      expect(sync.body.publicId).toMatch(/^ORD-/);
      // Syncing the same node again is rejected as a duplicate.
      await request(app.getHttpServer()).post('/api/v1/internal/repository/sync').set('Authorization', `Bearer ${token}`).send({ nodeId: 'existing-1' }).expect(409);
    });

    it('re-authenticates transparently when the repository ticket expires', async () => {
      expireTickets = true; // TICKET_1 is now rejected with 401
      const before = ticketsIssued;
      const token = await mint();
      await request(app.getHttpServer()).get('/api/v1/internal/repository/nodes').set('Authorization', `Bearer ${token}`).expect(200);
      expect(ticketsIssued).toBeGreaterThan(before);
    });

    it('reports a missing node as a gateway error, not a crash', async () => {
      const token = await mint();
      await request(app.getHttpServer()).post('/api/v1/internal/repository/sync').set('Authorization', `Bearer ${token}`).send({ nodeId: 'does-not-exist' }).expect(502);
    });

    it('is unavailable (503) rather than falling back to defaults when not configured', async () => {
      const saved = process.env.ALFRESCO_PASSWORD;
      delete process.env.ALFRESCO_PASSWORD;
      try {
        await request(app.getHttpServer()).get('/api/v1/internal/repository/nodes').set('Authorization', `Bearer ${await mint()}`).expect(503);
      } finally {
        process.env.ALFRESCO_PASSWORD = saved;
      }
    });
  });
});
