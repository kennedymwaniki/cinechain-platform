import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  Body,
  type CanActivate,
  Controller,
  type ExecutionContext,
  HttpCode,
  Inject,
  Injectable,
  Post,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { eq } from 'drizzle-orm';
import type { Request } from 'express';
import { z } from 'zod';
import { JwtService } from '../../auth/jwt.service';
import { PasswordService } from '../../auth/password.service';
import { TokenVerifier } from '../../auth/token-verifier';
import { unauthorized } from '../../common/errors/api-error';
import { createZodDto } from '../../common/validation/zod-dto';
import { APP_CONFIG, type AppConfig } from '../../config/app-config';
import { operator } from '../../db/schema/control';
import { ControlDb } from '../../tenancy/control-db.provider';

export const CONTROL_PUBLIC = 'cinechain:control-public';
export const ControlPublic = () => SetMetadata(CONTROL_PUBLIC, true);
export type OperatorRequest = Request & { operator?: { id: string } };

/**
 * Global guard of the control-plane process. Only `control-v1` tokens verify:
 * a staff or consumer token is signed with a different key and fails.
 */
@Injectable()
export class OperatorGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly verifier: TokenVerifier,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>(CONTROL_PUBLIC, [context.getHandler(), context.getClass()])) return true;
    const req = context.switchToHttp().getRequest<OperatorRequest>();
    const [scheme, raw] = (req.headers.authorization ?? '').split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || !raw) throw unauthorized();
    const claims = await this.verifier.verify('control-v1', raw);
    if (!claims || claims.typ !== 'operator') throw unauthorized('invalid_token', 'An operator token is required');
    req.operator = { id: claims.sub };
    return true;
  }
}

class OperatorLoginDto extends createZodDto(
  z.object({ email: z.email().max(254), password: z.string().min(1).max(1024) }).strict(),
) {}

@ApiTags('operator auth')
@ApiBearerAuth()
@Controller('admin/auth')
export class OperatorAuthController {
  constructor(
    private readonly control: ControlDb,
    private readonly passwords: PasswordService,
    private readonly jwt: JwtService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  @ControlPublic()
  @Post('login')
  @HttpCode(200)
  async login(@Body() b: OperatorLoginDto) {
    const row = await this.control.platformTx(async (tx) => {
      const [r] = await tx.select().from(operator).where(eq(operator.email, b.email));
      return r;
    });
    const ok = await this.passwords.verify(row?.passwordHash, b.password);
    if (!ok || !row || row.status !== 'active') throw unauthorized('invalid_credentials', 'E-mail or password is incorrect');
    await this.control.platformTx((tx) => tx.update(operator).set({ lastLoginAt: new Date() }).where(eq(operator.id, row.id)));
    const ttl = this.cfg.auth.accessTtl.control;
    const { token } = await this.jwt.sign('control-v1', { typ: 'operator', sub: row.id }, ttl);
    return { access_token: token, token_type: 'Bearer', expires_in: ttl };
  }
}
