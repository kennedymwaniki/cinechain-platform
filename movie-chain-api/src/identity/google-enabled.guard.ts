import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { notFound } from '../common/errors/api-error';

/** 404 when Google is not configured — the route simply does not exist. */
@Injectable()
export class GoogleAuthGuard extends AuthGuard('google') implements CanActivate {
  constructor(@Inject(APP_CONFIG) private readonly cfg: AppConfig) {
    super({ session: false });
  }

  override canActivate(context: ExecutionContext) {
    if (!this.cfg.auth.google) throw notFound();
    return super.canActivate(context);
  }
}
