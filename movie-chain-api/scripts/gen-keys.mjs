#!/usr/bin/env node
// Generates one Ed25519 signing key per token audience into ./keys (gitignored).
// Existing keys are kept unless --force is given: rotating a key logs everyone out.
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const AUDIENCES = ['staff-v1', 'consumer-v1', 'control-v1', 'hold-v1'];
const dir = resolve(process.env.JWT_KEYS_DIR ?? './keys');
const force = process.argv.includes('--force');

mkdirSync(dir, { recursive: true, mode: 0o700 });
for (const kid of AUDIENCES) {
  const file = resolve(dir, `${kid}.pem`);
  if (existsSync(file) && !force) {
    console.log(`  kept     ${kid}`);
    continue;
  }
  const { privateKey } = generateKeyPairSync('ed25519');
  writeFileSync(file, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  console.log(`  created  ${kid}`);
}
