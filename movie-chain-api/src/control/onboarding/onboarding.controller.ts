import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Body, Controller, Delete, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import { notFound } from '../../common/errors/api-error';
import { createZodDto } from '../../common/validation/zod-dto';
import { UUID_RE } from '../../tenancy/tenant-db.provider';
import type { OperatorRequest } from '../auth/operator-auth';
import { OnboardingService } from './onboarding.service';

class CreateTenantDto extends createZodDto(
  z
    .object({
      name: z.string().min(2).max(120),
      slug: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/, 'lowercase letters, digits and hyphens'),
      tier: z.enum(['basic', 'standard', 'premium', 'dedicated']).default('basic'),
      country: z.string().regex(/^[A-Z]{2}$/).default('KE'),
      contactEmail: z.email().max(254),
      contactName: z.string().min(1).max(120).optional(),
    })
    .strict(),
) {}

const uuidOr404 = (id: string) => {
  if (!UUID_RE.test(id)) throw notFound();
  return id;
};

@ApiTags('onboarding')
@ApiBearerAuth()
@Controller('admin')
export class OnboardingController {
  constructor(private readonly onboarding: OnboardingService) {}

  /** 202: provisioning continues in the background; poll the status URL. */
  @Post('tenants')
  @HttpCode(202)
  async create(@Body() body: CreateTenantDto, @Req() req: OperatorRequest) {
    const r = await this.onboarding.request(body, req.operator!.id);
    return { ...r, status_url: `/admin/tenants/${r.tenant_id}/status` };
  }

  @Get('tenants/:id/status')
  status(@Param('id') id: string) {
    return this.onboarding.status(uuidOr404(id));
  }

  @Post('onboarding/:runId/retry')
  @HttpCode(202)
  retry(@Param('runId') runId: string, @Req() req: OperatorRequest) {
    return this.onboarding.retry(uuidOr404(runId), req.operator!.id);
  }

  /** Undo a just-onboarded tenant that has no other data (smoke tests). Not offboarding. */
  @Delete('tenants/:id')
  undo(@Param('id') id: string) {
    return this.onboarding.undo(uuidOr404(id));
  }
}
