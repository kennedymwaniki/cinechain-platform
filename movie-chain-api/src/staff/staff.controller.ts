import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Roles } from '../auth/decorators';
import { createZodDto } from '../common/validation/zod-dto';
import { STAFF_ROLES } from '../db/schema/staff-user';
import { DeferTenantTransaction } from '../tenancy/decorators';
import { TenantDb } from '../tenancy/tenant-db.provider';
import { Uuid } from '../common/validation/uuid.pipe';
import { StaffService } from './staff.service';

const theatreIds = z.array(z.uuid()).max(50).default([]);
class InviteStaffDto extends createZodDto(
  z
    .object({
      email: z.email().max(254),
      display_name: z.string().trim().min(1).max(120).optional(),
      role: z.enum(STAFF_ROLES),
      theatre_ids: theatreIds,
    })
    .strict(),
) {}
class SetTheatresDto extends createZodDto(z.object({ theatre_ids: theatreIds }).strict()) {}

@ApiTags('staff')
@ApiBearerAuth()
@Controller('staff')
export class StaffController {
  constructor(
    private readonly staff: StaffService,
    private readonly tenantDb: TenantDb,
  ) {}

  @Roles('chain_admin')
  @Get()
  list() {
    return this.staff.list();
  }

  @Roles('chain_admin', 'theatre_manager')
  @Get(':id')
  get(@Param('id', Uuid) id: string) {
    return this.staff.get(id);
  }

  /** The invite e-mail goes out only AFTER the transaction commits. */
  @Roles('chain_admin')
  @DeferTenantTransaction()
  @Post('invitations')
  async invite(@Body() b: InviteStaffDto) {
    const { staff, deliver } = await this.tenantDb.withTenantScope(() =>
      this.staff.invite({ email: b.email, displayName: b.display_name ?? null, role: b.role, theatreIds: b.theatre_ids }),
    );
    await deliver();
    return staff;
  }

  @Roles('chain_admin')
  @Put(':id/theatres')
  setTheatres(@Param('id', Uuid) id: string, @Body() b: SetTheatresDto) {
    return this.staff.setTheatres(id, b.theatre_ids);
  }

  @Roles('chain_admin')
  @Post(':id/suspend')
  @HttpCode(200)
  suspend(@Param('id', Uuid) id: string) {
    return this.staff.suspend(id);
  }

  @Roles('chain_admin')
  @Post(':id/reactivate')
  @HttpCode(200)
  reactivate(@Param('id', Uuid) id: string) {
    return this.staff.reactivate(id);
  }

  @Roles('chain_admin')
  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id', Uuid) id: string): Promise<void> {
    await this.staff.remove(id);
  }
}
