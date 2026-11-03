import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchSpanProcessor, type SpanProcessor, TracerProvider } from '@opentelemetry/sdk-trace';

let provider: TracerProvider | null = null;

/**
 * OpenTelemetry. One root span per HTTP request (RequestSignalsMiddleware)
 * carries `tenant.id`, set the moment a tenant context is established — for a
 * staff call that is the token, for a guest the screening they named.
 * Exported over OTLP/HTTP when OTEL_EXPORTER_OTLP_TRACES_ENDPOINT is set.
 */
export function initTracing(v: { service: string; otlpUrl: string | null; extraProcessors?: SpanProcessor[] }): TracerProvider {
  if (provider) return provider;
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  provider = new TracerProvider({
    resource: resourceFromAttributes({ 'service.name': v.service }),
    spanProcessors: [...(v.otlpUrl ? [new BatchSpanProcessor({ exporter: new OTLPTraceExporter({ url: v.otlpUrl }) })] : []), ...(v.extraProcessors ?? [])],
  });
  trace.setGlobalTracerProvider(provider);
  return provider;
}

export const tracer = () => trace.getTracer('cinechain');

export async function shutdownTracing(): Promise<void> {
  await provider?.shutdown();
  provider = null;
}
