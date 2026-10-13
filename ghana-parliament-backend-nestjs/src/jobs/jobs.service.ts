import { Injectable, Logger, NotFoundException, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { Job, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export type JobHandler = (payload: any, job: Job) => Promise<void>;

/** Exponential backoff: 5s, 10s, 20s, ... capped at 15 minutes. */
export function backoffMs(attempt: number): number {
  return Math.min(5_000 * 2 ** Math.max(attempt - 1, 0), 15 * 60_000);
}

const STALE_LOCK_MS = 10 * 60_000;

/**
 * Database-backed queue with retries and a dead-letter state (T-030).
 * Jobs are claimed with FOR UPDATE SKIP LOCKED, so multiple workers are safe, and
 * enqueue is idempotent per dedupeKey, so a retried request never doubles work.
 */
@Injectable()
export class JobsService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(JobsService.name);
  private readonly handlers = new Map<string, JobHandler>();
  private timer?: NodeJS.Timeout;
  private draining = false;

  constructor(private readonly prisma: PrismaService) {}

  register(type: string, handler: JobHandler): void {
    this.handlers.set(type, handler);
  }

  async enqueue(type: string, payload: Prisma.InputJsonValue, opts: { dedupeKey?: string; correlationId?: string; runAt?: Date } = {}): Promise<Job> {
    if (opts.dedupeKey) {
      const existing = await this.prisma.job.findUnique({ where: { dedupeKey: opts.dedupeKey } });
      if (existing) {
        if (existing.status !== 'DEAD' && existing.status !== 'FAILED') return existing;
        // A dead job under the same key is revived rather than duplicated.
        return this.prisma.job.update({ where: { id: existing.id }, data: { status: 'PENDING', attempts: 0, lastError: null, runAt: opts.runAt ?? new Date(), lockedAt: null } });
      }
    }
    try {
      return await this.prisma.job.create({ data: { type, payload, dedupeKey: opts.dedupeKey, correlationId: opts.correlationId, runAt: opts.runAt } });
    } catch (e: any) {
      if (e?.code === 'P2002' && opts.dedupeKey) return (await this.prisma.job.findUnique({ where: { dedupeKey: opts.dedupeKey } }))!;
      throw e;
    }
  }

  /** Marks a finished job's key reusable so the same logical work can be requested again later. */
  async releaseKey(id: string): Promise<void> {
    await this.prisma.job.update({ where: { id }, data: { dedupeKey: null } });
  }

  private async claim(): Promise<Job | null> {
    const rows = await this.prisma.$queryRaw<Job[]>`
      UPDATE "Job" SET "status" = 'RUNNING', "lockedAt" = now(), "attempts" = "attempts" + 1, "updatedAt" = now()
      WHERE "id" = (
        SELECT "id" FROM "Job"
        WHERE ("status" = 'PENDING' AND "runAt" <= now())
           OR ("status" = 'RUNNING' AND "lockedAt" < now() - ${STALE_LOCK_MS} * interval '1 millisecond')
        ORDER BY "runAt" ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      RETURNING *`;
    return rows[0] ?? null;
  }

  /** Processes at most one due job. Returns false when the queue is empty. */
  async runOnce(): Promise<boolean> {
    const job = await this.claim();
    if (!job) return false;
    const handler = this.handlers.get(job.type);
    try {
      if (!handler) throw new Error(`No handler registered for job type ${job.type}`);
      await handler(job.payload, job);
      await this.prisma.job.update({ where: { id: job.id }, data: { status: 'SUCCEEDED', lockedAt: null, lastError: null, dedupeKey: null } });
    } catch (e) {
      const message = (e as Error).message?.slice(0, 2000) ?? 'unknown error';
      const dead = job.attempts >= job.maxAttempts;
      this.logger.warn(`Job ${job.id} (${job.type}) attempt ${job.attempts}/${job.maxAttempts} failed: ${message}`);
      await this.prisma.job.update({
        where: { id: job.id },
        data: { status: dead ? 'DEAD' : 'PENDING', lastError: message, lockedAt: null, runAt: new Date(Date.now() + backoffMs(job.attempts)) },
      });
    }
    return true;
  }

  /** Runs jobs until none are due (used by tests and the poller). */
  async drain(limit = 100): Promise<number> {
    let n = 0;
    while (n < limit && (await this.runOnce())) n++;
    return n;
  }

  async retry(id: string): Promise<Job> {
    const job = await this.prisma.job.findUnique({ where: { id } }).catch(() => null);
    if (!job) throw new NotFoundException('Job not found');
    return this.prisma.job.update({ where: { id }, data: { status: 'PENDING', attempts: 0, runAt: new Date(), lockedAt: null } });
  }

  onApplicationBootstrap(): void {
    if (process.env.JOBS_ENABLED === 'false') return;
    this.timer = setInterval(async () => {
      if (this.draining) return;
      this.draining = true;
      try {
        await this.drain(20);
      } catch (e) {
        this.logger.error(`Queue poll failed: ${(e as Error).message}`);
      } finally {
        this.draining = false;
      }
    }, Number(process.env.JOBS_POLL_MS ?? 2000));
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
