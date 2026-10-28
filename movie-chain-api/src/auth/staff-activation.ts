import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Body, Controller, HttpCode, Injectable, Post } from '@nestjs/common';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { badRequest } from '../common/errors/api-error';
import { createZodDto } from '../common/validation/zod-dto';
import { staffActivation, staffUser } from '../db/schema/staff-user';
import { db, runWithTenant } from '../tenancy/tenant-context';
import { TenantDb } from '../tenancy/tenant-db.provider';
import { TenantRegistry } from '../tenancy/tenant-registry.service';
import { toSystemContext } from '../tenancy/system-context';
import { Public } from './decorators';
import { PasswordService } from './password.service';

class ActivateDto extends createZodDto(
  z
    .object({
      tenant_slug: z.string().regex(/^[a-z0-9-]{1,40}$/),
      token: z.string().min(20).max(200),
      password: z.string().min(12).max(1024),
    })
    .strict(),
) {}

/** Consumes the single-use activation link created by onboarding (or, from step 9, an invitation). */
@Injectable()
export class StaffActivationService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly registry: TenantRegistry,
    private readonly passwords: PasswordService,
  ) {}

  async activate(slug: string, token: string, password: string): Promise<void> {
    const invalid = () => badRequest('activation_token_invalid', 'This activation link is invalid or has expired');
    const t = await this.registry.bySlug(slug);
    if (!t) throw invalid();
    const hash = await this.passwords.hash(password);
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const ok = await runWithTenant(toSystemContext({ tenantId: t.id }, { kind: 'system', reason: 'staff-activation' }), () =>
      this.tenantDb.withTenantScope(async () => {
        const [used] = await db()
          .update(staffActivation)
          .set({ usedAt: new Date() })
          .where(and(eq(staffActivation.tokenHash, tokenHash), isNull(staffActivation.usedAt), gt(staffActivation.expiresAt, new Date())))
          .returning({ staffUserId: staffActivation.staffUserId });
        if (!used) return false;
        await db()
          .update(staffUser)
          .set({ passwordHash: hash, status: 'active' })
          .where(and(eq(staffUser.id, used.staffUserId), eq(staffUser.status, 'invited')));
        return true;
      }),
    );
    if (!ok) throw invalid();
  }
}

@ApiTags('staff auth')
@ApiBearerAuth()
@Controller('auth/staff')
export class StaffActivationController {
  constructor(private readonly activation: StaffActivationService) {}

  @Public()
  @Post('activate')
  @HttpCode(204)
  async activate(@Body() b: ActivateDto): Promise<void> {
    await this.activation.activate(b.tenant_slug, b.token, b.password);
  }
}
