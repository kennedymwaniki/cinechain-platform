import { Global, Module } from '@nestjs/common';
import { JwtService } from './jwt.service';
import { KeyStore } from './key-store';
import { PasswordService } from './password.service';
import { TokenVerifier } from './token-verifier';

/**
 * Keys, token signing/verification and password hashing. Shared by both
 * processes: the application plane (AuthModule) and the control plane.
 */
@Global()
@Module({
  providers: [KeyStore, JwtService, { provide: TokenVerifier, useExisting: JwtService }, PasswordService],
  exports: [KeyStore, JwtService, TokenVerifier, PasswordService],
})
export class TokensModule {}
