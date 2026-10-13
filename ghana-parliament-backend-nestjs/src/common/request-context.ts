import { randomUUID } from 'crypto';
import { ClsModule, ClsService, ClsStore } from 'nestjs-cls';
import type { Principal } from '../auth/principal';

export interface RequestStore extends ClsStore {
  requestId: string;
  correlationId: string;
  ip?: string;
  principal?: Principal;
}

export type AppCls = ClsService<RequestStore>;

const CORRELATION_HEADER = 'x-correlation-id';
const REQUEST_HEADER = 'x-request-id';
// Accept caller-supplied IDs only if they look like safe tokens, to prevent log injection.
const SAFE_ID = /^[A-Za-z0-9._-]{8,100}$/;

/**
 * Per-request context. requestId is always server-generated; correlationId is
 * propagated from the caller (so a public query, retrieval, answer and feedback
 * can be tied together) or generated when absent.
 */
export const requestContextModule = ClsModule.forRoot({
  global: true,
  middleware: {
    mount: true,
    setup: (clsService: ClsService, req: any, res: any) => {
      const cls = clsService as AppCls;
      const incoming = req.headers?.[CORRELATION_HEADER];
      const correlationId =
        typeof incoming === 'string' && SAFE_ID.test(incoming) ? incoming : randomUUID();
      const requestId = randomUUID();
      cls.set('requestId', requestId);
      cls.set('correlationId', correlationId);
      cls.set('ip', req.ip);
      res.setHeader(REQUEST_HEADER, requestId);
      res.setHeader(CORRELATION_HEADER, correlationId);
    },
  },
});
