import { CallHandler, ExecutionContext, Injectable, NestInterceptor, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, from, throwError } from 'rxjs';
import { catchError, mergeMap } from 'rxjs/operators';
import { AuditService } from './audit.service';

export interface AuditMeta {
  action: string;
  objectType?: string;
  /** Route param holding the object ID (default "id"). */
  idParam?: string;
}

const AUDIT_META = 'auditMeta';

/** Declares that a handler is a mutation that must produce an audit event. */
export const Audit = (meta: AuditMeta) => SetMetadata(AUDIT_META, meta);

/**
 * Emits an audit event after each @Audit handler. Success is recorded only once the
 * event is persisted: if the audit write fails the request fails (every mutation must
 * have an audit event). Handler errors are recorded as failures, then rethrown.
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly audit: AuditService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const meta = this.reflector.get<AuditMeta | undefined>(AUDIT_META, context.getHandler());
    if (!meta) return next.handle();

    const req = context.switchToHttp().getRequest();
    const base = {
      action: meta.action,
      objectType: meta.objectType,
      objectId: req.params?.[meta.idParam ?? 'id'],
      payload: { method: req.method, path: req.route?.path },
    };

    return next.handle().pipe(
      mergeMap((result) => from(this.audit.record({ ...base, outcome: 'success' }).then(() => result))),
      catchError((err) =>
        from(this.audit.recordSafe({ ...base, outcome: 'failure', payload: { ...base.payload, error: err?.message } })).pipe(
          mergeMap(() => throwError(() => err)),
        ),
      ),
    );
  }
}
