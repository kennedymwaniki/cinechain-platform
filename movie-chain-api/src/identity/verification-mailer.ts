import { Injectable, Logger } from '@nestjs/common';

/**
 * Delivers verification links. Step 21 replaces the dev implementation with
 * the notification pipeline. Both messages are deliberately indistinguishable
 * to the API caller: registration never reveals whether an e-mail exists.
 */
export abstract class VerificationMailer {
  abstract sendVerification(email: string, link: string): Promise<void>;
  abstract sendAlreadyRegistered(email: string): Promise<void>;
}

const redact = (email: string) => email.replace(/^(.).*(@.*)$/, '$1***$2');

@Injectable()
export class LogVerificationMailer extends VerificationMailer {
  private readonly log = new Logger('VerificationMailer');
  /** Last link per address — read by tests and local development only. */
  readonly outbox = new Map<string, string>();

  async sendVerification(email: string, link: string): Promise<void> {
    this.outbox.set(email.toLowerCase(), link);
    this.log.log(`verification link for ${redact(email)}: ${link}`);
  }

  async sendAlreadyRegistered(email: string): Promise<void> {
    this.log.log(`"already registered" notice for ${redact(email)}`);
  }
}
