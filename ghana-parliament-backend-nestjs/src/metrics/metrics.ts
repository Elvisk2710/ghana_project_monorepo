import { CallHandler, Controller, ExecutionContext, Get, Headers, Injectable, NestInterceptor, Logger, Res, UnauthorizedException } from '@nestjs/common';
import { timingSafeEqual } from 'crypto';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { ClsService } from 'nestjs-cls';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../auth/decorators';
import type { RequestStore } from '../common/request-context';

const BUCKETS = [0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

/** Minimal Prometheus-format registry (request counts and latency histogram by route/status). */
@Injectable()
export class MetricsService {
  private counts = new Map<string, number>();
  private hist = new Map<string, { buckets: number[]; sum: number; count: number }>();
  private gauges = new Map<string, { labels: string; value: number }>();

  /** Sets a gauge. Gauges describe current state (open alerts, dead jobs); the monitor refreshes them. */
  setGauge(name: string, value: number, labels: Record<string, string> = {}): void {
    const l = Object.entries(labels).map(([k, v]) => `${k}="${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(',');
    this.gauges.set(`${name}{${l}}`, { labels: l, value });
  }

  /** Drops every series of a gauge so labels that no longer apply (a resolved alert) disappear. */
  clearGauge(name: string): void {
    for (const k of [...this.gauges.keys()]) if (k.startsWith(`${name}{`)) this.gauges.delete(k);
  }

  observe(method: string, route: string, status: number, seconds: number): void {
    const ck = `${method}|${route}|${status}`;
    this.counts.set(ck, (this.counts.get(ck) ?? 0) + 1);
    const hk = `${method}|${route}`;
    const h = this.hist.get(hk) ?? { buckets: BUCKETS.map(() => 0), sum: 0, count: 0 };
    BUCKETS.forEach((b, i) => seconds <= b && h.buckets[i]++);
    h.sum += seconds;
    h.count++;
    this.hist.set(hk, h);
  }

  render(): string {
    const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const out = ['# TYPE http_requests_total counter'];
    for (const [k, v] of this.counts) {
      const [m, r, s] = k.split('|');
      out.push(`http_requests_total{method="${m}",route="${esc(r)}",status="${s}"} ${v}`);
    }
    out.push('# TYPE http_request_duration_seconds histogram');
    for (const [k, h] of this.hist) {
      const [m, r] = k.split('|');
      const l = `method="${m}",route="${esc(r)}"`;
      BUCKETS.forEach((b, i) => out.push(`http_request_duration_seconds_bucket{${l},le="${b}"} ${h.buckets[i]}`));
      out.push(`http_request_duration_seconds_bucket{${l},le="+Inf"} ${h.count}`, `http_request_duration_seconds_sum{${l}} ${h.sum}`, `http_request_duration_seconds_count{${l}} ${h.count}`);
    }
    const names = [...new Set([...this.gauges.keys()].map((k) => k.slice(0, k.indexOf('{'))))];
    for (const n of names) {
      out.push(`# TYPE ${n} gauge`);
      for (const [k, g] of this.gauges) if (k.startsWith(`${n}{`)) out.push(`${n}${g.labels ? `{${g.labels}}` : ''} ${g.value}`);
    }
    return out.join('\n') + '\n';
  }
}

/** Emits one structured JSON log line per request with request/correlation IDs, and records metrics. */
@Injectable()
export class ObservabilityInterceptor implements NestInterceptor {
  private readonly logger = new Logger('http');
  constructor(
    private readonly metrics: MetricsService,
    private readonly cls: ClsService<RequestStore>,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const req = context.switchToHttp().getRequest();
    const res = context.switchToHttp().getResponse();
    const start = process.hrtime.bigint();
    const done = (status: number) => {
      const seconds = Number(process.hrtime.bigint() - start) / 1e9;
      const route = req.route?.path ?? 'unmatched';
      this.metrics.observe(req.method, route, status, seconds);
      this.logger.log(
        JSON.stringify({
          msg: 'request',
          method: req.method,
          route,
          status,
          durationMs: Math.round(seconds * 1000),
          requestId: this.cls.get('requestId'),
          correlationId: this.cls.get('correlationId'),
          userId: this.cls.get('principal')?.userId,
        }),
      );
    };
    return next.handle().pipe(
      tap({
        next: () => done(res.statusCode),
        error: (e) => done(typeof e?.getStatus === 'function' ? e.getStatus() : 500),
      }),
    );
  }
}

@Public()
@SkipThrottle()
@Controller('metrics')
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  /** Protected by a static scrape token (METRICS_TOKEN); disabled when the token is unset. */
  @Get()
  scrape(@Headers('authorization') auth: string | undefined, @Res({ passthrough: true }) res: any): string {
    const token = process.env.METRICS_TOKEN;
    const given = auth?.replace(/^Bearer /i, '') ?? '';
    const ok = !!token && given.length === token.length && timingSafeEqual(Buffer.from(given), Buffer.from(token));
    if (!ok) throw new UnauthorizedException();
    res.type('text/plain; version=0.0.4');
    return this.metrics.render();
  }
}
