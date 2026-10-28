import { z } from 'zod';
import { createZodDto } from '../common/validation/zod-dto';

const email = z.email().max(254);

export class RegisterDto extends createZodDto(
  z.object({ email, password: z.string().min(10).max(1024), display_name: z.string().min(1).max(120).optional() }).strict(),
) {}
export class ConsumerLoginDto extends createZodDto(z.object({ email, password: z.string().min(1).max(1024) }).strict()) {}
export class RefreshDto extends createZodDto(z.object({ refresh_token: z.string().min(20).max(200) }).strict()) {}
export class VerifyEmailDto extends createZodDto(z.object({ token: z.string().min(20).max(200) }).strict()) {}
export class ResendVerificationDto extends createZodDto(z.object({ email }).strict()) {}
