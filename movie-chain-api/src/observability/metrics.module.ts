import { SkipRateLimit } from '../tiering/decorators';
import { Controller, Get, Global, Header, Inject, Injectable, Module, Req } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request } from 'express';
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';
import { timingSafeEqual } from 'node:crypto';
import { Public } from '../auth/decorators';
import { notFound } from '../common/errors/api-error';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { TenantLabels } from './tenant-labels';

type Labels = Record<string, string>;

/** `sweeper.reclaimed_total` → `cinechain_sweeper_reclaimed_total`. */
const promName = (name: string) => `cinechain_${name.replace(/[^a-zA-Z0-9]+/g, '_')}`;

/**
 * Prometheus metrics, one registry per instance. Every series that carries a
 * `tenant` label goes through the cardinality guard (TenantLabels): the ~50
 * busiest tenants by id, the rest as `other`. Call sites pass the real tenant
 * id; the guard decides what Prometheus sees.
 */
@Injectable()
export class Metrics {
  readonly registry = new Registry();
  readonly tenants = new TenantLabels();
  private readonly counters = new Map<string, Counter<string>>();
  private readonly gauges = new Map<string, Gauge<string>>();
  private readonly histograms = new Map<string, Histogram<string>>();
  /** What was written, keyed by name + (mapped) labels: read back by get()/total() without prom-client internals. */
  private readonly mirror = new Map<string, number>();

  constructor() {
    // Event-loop lag, heap, GC, handles: `cinechain_node_*`.
    collectDefaultMetrics({ register: this.registry, prefix: 'cinechain_node_' });
  }

  /**
   * A gauge whose value is READ at scrape time (pool sizes, queue depths), so
   * it can never be stale. A read that fails leaves the series out of that
   * scrape rather than failing the scrape.
   */
  sampled(name: string, help: string, labelNames: string[], read: () => Promise<Array<[Labels, number]>> | Array<[Labels, number]>): void {
    if (this.registry.getSingleMetric(promName(name))) return;
    new Gauge({
      name: promName(name),
      help,
      labelNames,
      registers: [this.registry],
      async collect() {
        this.reset();
        try {
          for (const [l, v] of await read()) this.set(l, v);
        } catch {
          /* unavailable this scrape */
        }
      },
    });
  }

  private key(name: string, l: Labels): string {
    return `${name}{${Object.keys(l).sort().map((k) => `${k}=${l[k]}`).join(',')}}`;
  }

  private labels(l: Labels): Labels {
    return 'tenant' in l ? { ...l, tenant: this.tenants.label(l.tenant) } : l;
  }

  private counter(name: string, labelNames: string[]) {
    let c = this.counters.get(name);
    if (!c) {
      // prom-client does not add the conventional suffix: name counters `*_total` ourselves.
      const full = promName(name).endsWith('_total') ? promName(name) : `${promName(name)}_total`;
      c = new Counter({ name: full, help: name, labelNames, registers: [this.registry] });
      this.counters.set(name, c);
    }
    return c;
  }

  private gauge(name: string, labelNames: string[]) {
    let g = this.gauges.get(name);
    if (!g) {
      g = new Gauge({ name: promName(name), help: name, labelNames, registers: [this.registry] });
      this.gauges.set(name, g);
    }
    return g;
  }

  inc(name: string, labels: Labels = {}, by = 1): void {
    const l = this.labels(labels);
    this.counter(name, Object.keys(labels)).inc(l, by);
    const k = this.key(name, l);
    this.mirror.set(k, (this.mirror.get(k) ?? 0) + by);
  }

  set(name: string, labels: Labels, value: number): void {
    const l = this.labels(labels);
    this.gauge(name, Object.keys(labels)).set(l, value);
    this.mirror.set(this.key(name, l), value);
  }

  /** Seconds. */
  observe(name: string, labels: Labels, seconds: number, buckets = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5]): void {
    let h = this.histograms.get(name);
    if (!h) {
      h = new Histogram({ name: promName(name), help: name, labelNames: Object.keys(labels), buckets, registers: [this.registry] });
      this.histograms.set(name, h);
    }
    h.observe(this.labels(labels), seconds);
  }

  /** Read back a counter or gauge (tests, health). The tenant label is mapped exactly as when it was written. */
  get(name: string, labels: Labels = {}): number {
    return this.mirror.get(this.key(name, 'tenant' in labels ? { ...labels, tenant: this.tenants.peek(labels.tenant) } : labels)) ?? 0;
  }

  total(name: string): number {
    let n = 0;
    for (const [k, v] of this.mirror) if (k.startsWith(`${name}{`)) n += v;
    return n;
  }

  render(): Promise<string> {
    return this.registry.metrics();
  }
}

/**
 * GET /api/v1/metrics — the Prometheus scrape. Per-tenant series are
 * themselves tenant data, so it answers only a loopback caller or a caller
 * presenting METRICS_TOKEN; anyone else gets the same 404 as a missing route.
 */
@ApiExcludeController()
@Controller('metrics')
export class MetricsController {
  constructor(
    private readonly metrics: Metrics,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  @SkipRateLimit()
  @Public()
  @Get()
  @Header('content-type', 'text/plain; version=0.0.4; charset=utf-8')
  async scrape(@Req() req: Request): Promise<string> {
    if (!this.allowed(req)) throw notFound();
    return this.metrics.render();
  }

  private allowed(req: Request): boolean {
    const token = this.cfg.metricsToken;
    const given = (req.headers.authorization ?? '').replace(/^Bearer /i, '');
    if (token && given.length === token.length && timingSafeEqual(Buffer.from(given), Buffer.from(token))) return true;
    const ip = req.socket.remoteAddress ?? '';
    return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  }
}

@Global()
@Module({ controllers: [MetricsController], providers: [Metrics], exports: [Metrics] })
export class MetricsModule {}
