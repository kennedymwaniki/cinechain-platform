import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/app-config';

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

  constructor(@Inject(APP_CONFIG) private readonly cfg: AppConfig) {
    super();
  }

  async sendVerification(email: string, link: string): Promise<void> {
    this.outbox.set(email.toLowerCase(), link);
    // The link is a bearer secret: logged only in local development.
    this.log.log(this.cfg.env === 'development' ? `verification link for ${redact(email)} (dev only): ${link}` : `verification link sent to ${redact(email)}`);
  }

  async sendAlreadyRegistered(email: string): Promise<void> {
    this.log.log(`"already registered" notice for ${redact(email)}`);
  }
}
