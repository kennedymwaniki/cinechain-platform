import { Inject, Injectable, Logger } from '@nestjs/common';
import { createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { APP_CONFIG, type AppConfig } from '../config/app-config';

/**
 * One Ed25519 keypair per audience. A token signed for one audience cannot
 * verify under another's key, so a missing guard cannot become a breach;
 * the `typ` claim is a redundant belt that lets guards return the right code.
 */
export const AUDIENCES = ['staff-v1', 'consumer-v1', 'control-v1', 'hold-v1'] as const;
export type Audience = (typeof AUDIENCES)[number];

export interface KeyPair {
  kid: Audience;
  privateKey: KeyObject;
  publicKey: KeyObject;
}

@Injectable()
export class KeyStore {
  private readonly log = new Logger(KeyStore.name);
  private readonly keys = new Map<Audience, KeyPair>();

  // Loaded in the constructor, not onModuleInit: factories that need a key
  // (the Google state secret) run before any init hook.
  constructor(@Inject(APP_CONFIG) cfg: AppConfig) {
    const dir = resolve(cfg.auth.keysDir);
    for (const kid of AUDIENCES) {
      const file = resolve(dir, `${kid}.pem`);
      if (!existsSync(file)) throw new Error(`Signing key missing: ${file}. Run \`pnpm keys:gen\`.`);
      const privateKey = createPrivateKey(readFileSync(file));
      if (privateKey.asymmetricKeyType !== 'ed25519')
        throw new Error(`Signing key ${kid} is ${privateKey.asymmetricKeyType}, expected ed25519`);
      this.keys.set(kid, { kid, privateKey, publicKey: createPublicKey(privateKey) });
    }
    this.log.log(`loaded ${this.keys.size} Ed25519 signing keys (${AUDIENCES.join(', ')})`);
  }

  get(kid: Audience): KeyPair {
    const k = this.keys.get(kid);
    if (!k) throw new Error(`no key for audience ${kid}`);
    return k;
  }
}
