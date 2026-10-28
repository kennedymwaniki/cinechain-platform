import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Body, Controller, Get, HttpCode, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { parseWith } from '../common/validation/zod-validation.pipe';
import { ConsumerRoute, Public } from '../auth/decorators';
import type { ConsumerRequest } from '../tenancy/consumer.guard';
import { ConsumerService, type GoogleProfile } from './consumer.service';
import {
  ConsumerLoginDto,
  RefreshDto,
  RegisterDto,
  ResendVerificationDto,
  VerifyEmailDto,
} from './dto';
import { GoogleAuthGuard } from './google-enabled.guard';

/** Consumer (customer) identity. Platform-level: none of this knows about tenants. */
@ApiTags('consumer auth')
@ApiBearerAuth()
@Controller()
export class ConsumerAuthController {
  constructor(private readonly consumers: ConsumerService) {}

  @Public()
  @Post('auth/register')
  @HttpCode(202)
  async register(@Body() b: RegisterDto) {
    await this.consumers.register(b.email, b.password, b.display_name ?? null);
    // Identical whether or not the address already has an account.
    return { status: 'verification_sent' };
  }

  @Public()
  @Post('auth/login')
  @HttpCode(200)
  login(@Body() b: ConsumerLoginDto) {
    return this.consumers.login(b.email, b.password);
  }

  @Public()
  @Post('auth/refresh')
  @HttpCode(200)
  refresh(@Body() b: RefreshDto) {
    return this.consumers.rotate(b.refresh_token);
  }

  @Public()
  @Post('auth/logout')
  @HttpCode(204)
  async logout(@Body() b: RefreshDto): Promise<void> {
    await this.consumers.logout(b.refresh_token);
  }

  @Public()
  @Post('auth/verify-email')
  @HttpCode(200)
  verify(@Body() b: VerifyEmailDto) {
    return this.consumers.verifyEmail(b.token);
  }

  /** The link in the e-mail. */
  @Public()
  @Get('auth/verify-email')
  verifyLink(@Query('token') token: unknown) {
    return this.consumers.verifyEmail(parseWith(VerifyEmailDto.schema, { token }).token);
  }

  @Public()
  @Post('auth/resend-verification')
  @HttpCode(202)
  async resend(@Body() b: ResendVerificationDto) {
    await this.consumers.resendVerification(b.email);
    return { status: 'verification_sent' };
  }

  @Public()
  @UseGuards(GoogleAuthGuard)
  @Get('auth/google')
  google(): void {
    // passport redirects to Google
  }

  @Public()
  @UseGuards(GoogleAuthGuard)
  @Get('auth/google/callback')
  googleCallback(@Req() req: Request & { user: GoogleProfile }) {
    return this.consumers.googleSignIn(req.user);
  }

  @ConsumerRoute({ requireAccount: true })
  @Get('me')
  me(@Req() req: ConsumerRequest) {
    return this.consumers.profile(req.consumer!.id);
  }
}
