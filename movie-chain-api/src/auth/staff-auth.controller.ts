import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Body, Controller, Get, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { RefreshDto } from '../identity/dto';
import { Public } from './decorators';
import type { AuthedRequest } from './guards/access.guard';
import { type StaffPrincipal, StaffAuthService } from './staff-auth.service';

@ApiTags('staff auth')
@ApiBearerAuth()
@Controller('auth/staff')
export class StaffAuthController {
  constructor(private readonly auth: StaffAuthService) {}

  @Public()
  @UseGuards(AuthGuard('staff-local'))
  @Post('login')
  @HttpCode(200)
  login(@Req() req: AuthedRequest & { user: StaffPrincipal }) {
    return this.auth.startSession(req.user);
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  refresh(@Body() b: RefreshDto) {
    return this.auth.rotate(b.refresh_token);
  }

  @Public()
  @Post('logout')
  @HttpCode(204)
  async logout(@Body() b: RefreshDto): Promise<void> {
    await this.auth.logout(b.refresh_token);
  }

  /** The verified claims of the caller. Proves which tenant the token is for. */
  @Get('me')
  me(@Req() req: AuthedRequest) {
    const s = req.staff!;
    return { id: s.sub, role: s.role, tenant: { id: s.tenant_id, slug: s.tenant_slug } };
  }
}
