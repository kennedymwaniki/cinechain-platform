import { Inject, Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import type { Request } from 'express';
import { Strategy } from 'passport-local';
import { z } from 'zod';
import { APP_CONFIG, type AppConfig } from '../../config/app-config';
import { unauthorized } from '../../common/errors/api-error';
import { parseWith } from '../../common/validation/zod-validation.pipe';
import { type StaffPrincipal, StaffAuthService } from '../staff-auth.service';

const body = z
  .object({
    email: z.email().max(254),
    password: z.string().min(1).max(1024),
    tenant_slug: z.string().regex(/^[a-z0-9-]{1,40}$/).optional(),
  })
  .strict();

/**
 * Staff e-mail + password. The tenant is named by the subdomain
 * (<slug>.<TENANT_BASE_DOMAIN>) or, without one, by `tenant_slug`.
 */
@Injectable()
export class StaffLocalStrategy extends PassportStrategy(Strategy, 'staff-local') {
  constructor(
    private readonly auth: StaffAuthService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {
    super({ usernameField: 'email', passwordField: 'password', passReqToCallback: true, session: false });
  }

  async validate(req: Request): Promise<StaffPrincipal> {
    // Passport runs in a guard, before pipes: validate here with the same schema style.
    const b = parseWith(body, req.body);
    const fromHost = this.slugFromHost(req.hostname);
    const slug = fromHost ?? b.tenant_slug;
    if (!slug || (fromHost && b.tenant_slug && b.tenant_slug !== fromHost))
      throw unauthorized('invalid_credentials', 'E-mail or password is incorrect');
    return this.auth.verifyCredentials(slug, b.email, b.password);
  }

  private slugFromHost(host: string | undefined): string | null {
    const base = this.cfg.tenantBaseDomain;
    if (!host || !host.endsWith(`.${base}`)) return null;
    const slug = host.slice(0, -(base.length + 1));
    return /^[a-z0-9-]{1,40}$/.test(slug) ? slug : null;
  }
}
