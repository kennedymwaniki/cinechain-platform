import { Global, Injectable, Module } from '@nestjs/common';

type Labels = Record<string, string>;

const keyOf = (name: string, labels: Labels) =>
  `${name}{${Object.keys(labels)
    .sort()
    .map((k) => `${k}="${labels[k]}"`)
    .join(',')}}`;

/**
 * In-process counters and gauges, labelled (usually by tenant). Deliberately
 * not exposed over HTTP yet: per-tenant series are themselves tenant data.
 * Step 23 exports them to the signals pipeline; until then tests read them here.
 */
@Injectable()
export class Metrics {
  private readonly values = new Map<string, number>();

  inc(name: string, labels: Labels = {}, by = 1): void {
    const k = keyOf(name, labels);
    this.values.set(k, (this.values.get(k) ?? 0) + by);
  }

  set(name: string, labels: Labels, value: number): void {
    this.values.set(keyOf(name, labels), value);
  }

  get(name: string, labels: Labels = {}): number {
    return this.values.get(keyOf(name, labels)) ?? 0;
  }

  /** Sum of a series across every label set. */
  total(name: string): number {
    let n = 0;
    for (const [k, v] of this.values) if (k.startsWith(`${name}{`)) n += v;
    return n;
  }

  snapshot(): Record<string, number> {
    return Object.fromEntries(this.values);
  }
}

@Global()
@Module({ providers: [Metrics], exports: [Metrics] })
export class MetricsModule {}
