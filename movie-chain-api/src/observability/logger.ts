import type { LoggerService } from '@nestjs/common';
import pino, { type DestinationStream, type Logger } from 'pino';
import { maybeCurrentTenant } from '../tenancy/tenant-context';
import { currentRequest } from './request-context';

/**
 * What must never reach a log line, wherever it appears in a message:
 * e-mail addresses, phone numbers, card tokens, bearer tokens. (Customer and
 * seat-holder names are never logged by any call site; structured fields
 * that could carry them are redacted by path below.)
 */
const SCRUB: [RegExp, string][] = [
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]'],
  [/\+?\d[\d ()-]{8,14}\d/g, '[phone]'],
  [/\btok_[A-Za-z0-9_]+/g, '[card_token]'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [token]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[jwt]'],
];

export function scrub(s: string): string {
  return SCRUB.reduce((acc, [re, to]) => acc.replace(re, to), s);
}

const REDACT_PATHS = ['email', 'phone', 'guest_email', 'guest_name', 'guest_phone', 'card_token', 'contact', 'name']
  .flatMap((k) => [k, `*.${k}`])
  .concat(['req.headers.authorization', 'req.headers.cookie', '*.hold_token', '*.booking_token']);

type Level = 'fatal' | 'error' | 'warn' | 'log' | 'debug' | 'verbose';
const PINO_LEVEL: Record<Level, string> = { fatal: 'fatal', error: 'error', warn: 'warn', log: 'info', debug: 'debug', verbose: 'trace' };

/**
 * Pino behind Nest's LoggerService. `tenant_id` and `request_id` come from the
 * mixin — read from the tenancy context the interceptor (or a worker's
 * runWithTenant) established — so NO call site adds them, and none can forget.
 */
export class PinoLogger implements LoggerService {
  readonly pino: Logger;

  constructor(opts: { level?: Level; destination?: DestinationStream; service?: string; file?: string | null } = {}) {
    // LOG_FILE: the same JSON lines, also appended to a file that Alloy ships to Loki.
    const destination =
      opts.destination ??
      (opts.file
        ? pino.multistream([
            { level: 'trace', stream: process.stdout },
            { level: 'trace', stream: pino.destination({ dest: opts.file, mkdir: true, sync: false }) },
          ])
        : undefined);
    this.pino = pino(
      {
        level: PINO_LEVEL[opts.level ?? 'log'],
        base: { service: opts.service ?? 'cinechain-api' },
        messageKey: 'msg',
        timestamp: pino.stdTimeFunctions.isoTime,
        formatters: { level: (label) => ({ level: label }) },
        mixin() {
          const tenantId = maybeCurrentTenant()?.tenantId ?? currentRequest()?.tenantId ?? undefined;
          const requestId = currentRequest()?.requestId;
          return { ...(tenantId ? { tenant_id: tenantId } : {}), ...(requestId ? { request_id: requestId } : {}) };
        },
        redact: { paths: REDACT_PATHS, censor: '[redacted]' },
        hooks: {
          logMethod(args, method) {
            method.apply(this, args.map((a) => (typeof a === 'string' ? scrub(a) : a)) as Parameters<typeof method>);
          },
        },
      },
      destination,
    );
  }

  private write(level: 'info' | 'warn' | 'error' | 'debug' | 'trace' | 'fatal', message: unknown, params: unknown[]) {
    // Nest passes the context as the last string parameter; an Error stack may precede it.
    const context = typeof params[params.length - 1] === 'string' ? (params.pop() as string) : undefined;
    const stack = typeof params[0] === 'string' && params[0].includes('\n    at ') ? (params.shift() as string) : undefined;
    if (message instanceof Error) this.pino[level]({ context, err: message }, scrub(message.message));
    else if (typeof message === 'object' && message !== null) this.pino[level]({ context, ...message });
    else this.pino[level]({ context, ...(stack ? { stack: scrub(stack) } : {}) }, String(message));
  }

  log(message: unknown, ...params: unknown[]) {
    this.write('info', message, params);
  }
  error(message: unknown, ...params: unknown[]) {
    this.write('error', message, params);
  }
  warn(message: unknown, ...params: unknown[]) {
    this.write('warn', message, params);
  }
  debug(message: unknown, ...params: unknown[]) {
    this.write('debug', message, params);
  }
  verbose(message: unknown, ...params: unknown[]) {
    this.write('trace', message, params);
  }
  fatal(message: unknown, ...params: unknown[]) {
    this.write('fatal', message, params);
  }
}
