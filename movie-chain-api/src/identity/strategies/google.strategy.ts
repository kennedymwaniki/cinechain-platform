import { PassportStrategy } from '@nestjs/passport';
import { createHash } from 'node:crypto';
import { Strategy, type Profile } from 'passport-google-oauth20';
import type { AppConfig } from '../../config/app-config';
import type { KeyStore } from '../../auth/key-store';
import type { GoogleProfile } from '../consumer.service';
import { SignedStateStore } from './oauth-state.store';

/**
 * Registered ONLY when the Google env trio is set (see identity.module.ts).
 * `validate` returns the normalised profile; ConsumerService decides
 * everything else, including refusing an e-mail Google did not verify.
 */
export class GoogleStrategy extends PassportStrategy(Strategy, 'google') {
  constructor(cfg: AppConfig, keys: KeyStore) {
    const google = cfg.auth.google!;
    // State-signing secret derived from the consumer key: no extra secret to manage.
    const secret = createHash('sha256')
      .update(keys.get('consumer-v1').privateKey.export({ type: 'pkcs8', format: 'der' }))
      .update('oauth-state-v1')
      .digest();
    super({
      clientID: google.clientId,
      clientSecret: google.clientSecret,
      callbackURL: google.callbackUrl,
      scope: ['openid', 'email', 'profile'],
      store: new SignedStateStore(secret, cfg.env === 'production') as never,
      state: true,
    });
  }

  validate(_accessToken: string, _refreshToken: string, profile: Profile): GoogleProfile {
    const json = profile._json as { email?: string; email_verified?: boolean | string };
    const email = json.email ?? profile.emails?.[0]?.value;
    if (!email) throw new Error('Google returned no e-mail address');
    return {
      subject: profile.id,
      email,
      emailVerified: json.email_verified === true || json.email_verified === 'true',
      displayName: profile.displayName || null,
    };
  }
}
