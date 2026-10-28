import { Injectable, type OnModuleInit } from '@nestjs/common';
import argon2 from 'argon2';
import { randomBytes } from 'node:crypto';

/** OWASP baseline for argon2id. */
const OPTIONS = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

@Injectable()
export class PasswordService implements OnModuleInit {
  /**
   * Verified on the not-found path, so "no such user" costs the same as
   * "wrong password" and response time does not reveal which accounts exist.
   * Same parameters as real hashes, or the timing would differ anyway.
   */
  private dummyHash = '';

  async onModuleInit(): Promise<void> {
    this.dummyHash = await argon2.hash(randomBytes(32).toString('hex'), OPTIONS);
  }

  hash(password: string): Promise<string> {
    return argon2.hash(password, OPTIONS);
  }

  /** Always performs exactly one argon2 verification. */
  async verify(storedHash: string | null | undefined, password: string): Promise<boolean> {
    const hash = storedHash ?? this.dummyHash;
    let ok: boolean;
    try {
      ok = await argon2.verify(hash, password);
    } catch {
      ok = false;
    }
    return ok && storedHash != null;
  }
}
