import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/app-config';

/**
 * Delivers staff activation links: the first chain_admin's (onboarding, control
 * plane) and every later invitation (FR-5, application plane). Step 21 swaps in
 * real delivery.
 */
@Injectable()
export class StaffInviteMailer {
  private readonly log = new Logger(StaffInviteMailer.name);
  /** Last link per address — tests and local development only. */
  readonly outbox = new Map<string, string>();

  constructor(@Inject(APP_CONFIG) private readonly cfg: AppConfig) {}

  async sendActivation(email: string, tenantSlug: string, token: string): Promise<void> {
    // tenantSlug picks the chain's sign-in host; the token alone is useless without it.
    const link = `https://${tenantSlug}.${this.cfg.tenantBaseDomain}/activate?token=${token}`;
    this.outbox.set(email.toLowerCase(), token);
    // The link is a bearer secret: logged only in local development, where it is how you activate.
    if (this.cfg.env === 'development') this.log.log(`activation link (dev only): ${link}`);
    else this.log.log('activation link issued');
  }
}
