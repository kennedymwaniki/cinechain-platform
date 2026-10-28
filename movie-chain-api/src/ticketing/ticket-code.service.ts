import { Inject, Injectable } from '@nestjs/common';
import { createHash, createHmac } from 'node:crypto';
import { APP_CONFIG, type AppConfig } from '../config/app-config';

/**
 * Ticket codes (FR-72): bearer credentials, so high-entropy, signed, and not
 * derivable from anything a customer can see. A code is HMAC(secret, ticket
 * id) — 128 bits, base64url — so it can be recomputed for the booking view
 * (FR-55) while the database stores only its SHA-256. A leaked database dump
 * yields no usable code; a booking reference yields nothing at all.
 */
@Injectable()
export class TicketCodeService {
  private readonly secret: Buffer;

  constructor(@Inject(APP_CONFIG) cfg: AppConfig) {
    this.secret = Buffer.from(cfg.tickets.codeSecret, 'utf8');
  }

  codeFor(tenantId: string, ticketId: string): string {
    return createHmac('sha256', this.secret).update(`ticket:${tenantId}:${ticketId}`).digest().subarray(0, 16).toString('base64url');
  }

  /** What is stored, and what a scan is looked up by. */
  static hash(code: string): Buffer {
    return createHash('sha256').update(code, 'utf8').digest();
  }

  static looksLikeCode(s: string): boolean {
    return /^[A-Za-z0-9_-]{22}$/.test(s);
  }
}
