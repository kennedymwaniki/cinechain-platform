import { Inject, Injectable, type NestMiddleware, Optional } from '@nestjs/common';
import { UsageRecorder } from '../metering/usage.recorder';
import { context, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { onTenantBound } from '../tenancy/tenant-context';
import { Metrics } from './metrics.module';
import { currentRequest, requestAls } from './request-context';
import { tracer } from './tracing';

const REQUEST_ID = /^[A-Za-z0-9._-]{8,64}$/;

let hooked = false;

/**
 * Runs before guards, interceptors and handlers, for every request: assigns a
 * request id, opens the ROOT span, and on finish records the per-tenant
 * latency histogram (the input to the noisy-neighbour alert). The tenant is
 * filled in by the tenancy layer's binding hook, not by anyone here.
 */
@Injectable()
export class RequestSignalsMiddleware implements NestMiddleware {
  constructor(
    private readonly metrics: Metrics,
    @Optional() @Inject(UsageRecorder) private readonly usage: UsageRecorder | null = null,
  ) {
    if (!hooked) {
      hooked = true;
      onTenantBound((tenantId) => {
        const req = currentRequest();
        if (req && !req.tenantId) req.tenantId = tenantId;
        trace.getActiveSpan()?.setAttribute('tenant.id', tenantId);
      });
    }
  }

  use(req: Request, res: Response, next: NextFunction): void {
    const header = req.header('x-request-id');
    const requestId = header && REQUEST_ID.test(header) ? header : randomUUID();
    res.setHeader('x-request-id', requestId);
    const signals = { requestId, tenantId: null as string | null };
    const span = tracer().startSpan(`HTTP ${req.method}`, { kind: SpanKind.SERVER, attributes: { 'http.request.method': req.method } }, context.active());
    const started = process.hrtime.bigint();

    res.on('finish', () => {
      const route = (req.route as { path?: string } | undefined)?.path ?? 'unmatched';
      span.setAttribute('http.route', route);
      span.setAttribute('http.response.status_code', res.statusCode);
      if (signals.tenantId) span.setAttribute('tenant.id', signals.tenantId);
      if (res.statusCode >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
      span.end();
      if (route === '/api/v1/metrics' || route === '/metrics') return;
      if (signals.tenantId) this.usage?.add(signals.tenantId, 'requests', 1); // metering: requests attributed to a tenant
      this.metrics.observe(
        'http.request_duration_seconds',
        { tenant: signals.tenantId ?? 'none', method: req.method, status: `${Math.floor(res.statusCode / 100)}xx` },
        Number(process.hrtime.bigint() - started) / 1e9,
      );
      // Per ROUTE TEMPLATE (never the raw path: ids would explode cardinality), across tenants.
      this.metrics.observe(
        'http.route_duration_seconds',
        { route: route === 'unmatched' ? 'unmatched' : `${req.baseUrl}${route}`, method: req.method, status: String(res.statusCode) },
        Number(process.hrtime.bigint() - started) / 1e9,
      );
    });

    requestAls.run(signals, () => context.with(trace.setSpan(context.active(), span), next));
  }
}
