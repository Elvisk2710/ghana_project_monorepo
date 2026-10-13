import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ClsService } from 'nestjs-cls';
import { PrismaService } from '../prisma/prisma.service';
import type { RequestStore } from '../common/request-context';

export interface AuditInput {
  action: string;
  objectType?: string;
  objectId?: string;
  payload?: Record<string, unknown>;
  outcome?: 'success' | 'failure' | 'denied';
}

const SENSITIVE_KEY = /pass(word)?|secret|token|authorization|cookie|api[-_]?key/i;

/** Removes secrets from audit payloads (recursively) before they are persisted. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[truncated]';
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        SENSITIVE_KEY.test(k) ? '[redacted]' : redact(v, depth + 1),
      ]),
    );
  }
  return value;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cls: ClsService<RequestStore>,
  ) {}

  /**
   * Appends an audit event stamped with actor, request ID and correlation ID from the
   * current request. Throws on persistence failure so that callers performing a
   * mutation can fail closed rather than act without a record.
   */
  async record(input: AuditInput): Promise<void> {
    const principal = this.cls.get('principal');
    await this.prisma.auditEvent.create({
      data: {
        actorId: principal?.userId ?? null,
        actorType: principal ? 'user' : 'anonymous',
        actorRoles: principal?.roles ?? [],
        action: input.action,
        objectType: input.objectType,
        objectId: input.objectId,
        payload: input.payload ? (redact(input.payload) as Prisma.InputJsonValue) : undefined,
        outcome: input.outcome ?? 'success',
        requestId: this.cls.get('requestId') ?? 'unknown',
        correlationId: this.cls.get('correlationId') ?? 'unknown',
        ip: this.cls.get('ip'),
      },
    });
  }

  /** Best-effort variant for denial/failure paths where the original error must still surface. */
  async recordSafe(input: AuditInput): Promise<void> {
    try {
      await this.record(input);
    } catch (err) {
      this.logger.error(`Failed to write audit event ${input.action}: ${(err as Error).message}`);
    }
  }
}
