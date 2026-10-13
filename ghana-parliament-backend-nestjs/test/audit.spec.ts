import { of, throwError, lastValueFrom } from 'rxjs';
import { Reflector } from '@nestjs/core';
import { AuditInterceptor, Audit } from '../src/audit/audit.interceptor';
import { AuditService, redact } from '../src/audit/audit.service';

describe('redact', () => {
  it('removes secrets recursively', () => {
    expect(redact({ a: 1, password: 'x', nested: { apiKey: 'k', ok: true }, list: [{ Authorization: 'Bearer z' }] })).toEqual({
      a: 1,
      password: '[redacted]',
      nested: { apiKey: '[redacted]', ok: true },
      list: [{ Authorization: '[redacted]' }],
    });
  });
});

describe('AuditService', () => {
  const make = (principal?: any) => {
    const create = jest.fn().mockResolvedValue({});
    const cls = { get: (k: string) => ({ requestId: 'req-1', correlationId: 'corr-1', ip: '1.2.3.4', principal })[k] };
    return { create, svc: new AuditService({ auditEvent: { create } } as any, cls as any) };
  };

  it('stamps actor, request and correlation IDs', async () => {
    const { svc, create } = make({ userId: 'u1', roles: ['STAFF'] });
    await svc.record({ action: 'document.publish', objectType: 'document', objectId: 'd1', payload: { token: 't' } });
    expect(create.mock.calls[0][0].data).toMatchObject({
      actorId: 'u1', actorType: 'user', actorRoles: ['STAFF'], action: 'document.publish',
      requestId: 'req-1', correlationId: 'corr-1', outcome: 'success', payload: { token: '[redacted]' },
    });
  });

  it('records anonymous actors', async () => {
    const { svc, create } = make();
    await svc.record({ action: 'answer.ask' });
    expect(create.mock.calls[0][0].data).toMatchObject({ actorId: null, actorType: 'anonymous', actorRoles: [] });
  });

  it('record throws on failure but recordSafe swallows it', async () => {
    const { svc, create } = make();
    create.mockRejectedValue(new Error('db down'));
    await expect(svc.record({ action: 'x' })).rejects.toThrow('db down');
    await expect(svc.recordSafe({ action: 'x' })).resolves.toBeUndefined();
  });
});

describe('AuditInterceptor', () => {
  class C { @Audit({ action: 'case.update', objectType: 'case' }) h() {} plain() {} }
  const ctx = (handler: Function) => ({
    getHandler: () => handler,
    switchToHttp: () => ({ getRequest: () => ({ params: { id: 'c1' }, method: 'PATCH', route: { path: '/c/:id' } }) }),
  }) as any;

  it('does nothing for handlers without @Audit', async () => {
    const audit = { record: jest.fn(), recordSafe: jest.fn() };
    const i = new AuditInterceptor(new Reflector(), audit as any);
    expect(await lastValueFrom(i.intercept(ctx(C.prototype.plain), { handle: () => of('ok') }))).toBe('ok');
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('records success after the handler', async () => {
    const audit = { record: jest.fn().mockResolvedValue(undefined), recordSafe: jest.fn() };
    const i = new AuditInterceptor(new Reflector(), audit as any);
    expect(await lastValueFrom(i.intercept(ctx(C.prototype.h), { handle: () => of('ok') }))).toBe('ok');
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'case.update', objectId: 'c1', outcome: 'success' }));
  });

  it('fails the request when the success audit write fails (fail closed)', async () => {
    const audit = { record: jest.fn().mockRejectedValue(new Error('audit down')), recordSafe: jest.fn().mockResolvedValue(undefined) };
    const i = new AuditInterceptor(new Reflector(), audit as any);
    await expect(lastValueFrom(i.intercept(ctx(C.prototype.h), { handle: () => of('ok') }))).rejects.toThrow('audit down');
  });

  it('records handler errors as failures and rethrows', async () => {
    const audit = { record: jest.fn(), recordSafe: jest.fn().mockResolvedValue(undefined) };
    const i = new AuditInterceptor(new Reflector(), audit as any);
    await expect(lastValueFrom(i.intercept(ctx(C.prototype.h), { handle: () => throwError(() => new Error('boom')) }))).rejects.toThrow('boom');
    expect(audit.recordSafe).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failure' }));
  });
});
