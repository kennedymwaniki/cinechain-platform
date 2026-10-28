import { Module } from '@nestjs/common';
import { StaffInviteMailer } from './staff-invite.mailer';
import { StaffController } from './staff.controller';
import { StaffRepository } from './staff.repository';
import { StaffService } from './staff.service';

@Module({
  controllers: [StaffController],
  providers: [StaffRepository, StaffService, StaffInviteMailer],
  exports: [StaffInviteMailer],
})
export class StaffModule {}
