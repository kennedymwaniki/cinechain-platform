import { describe, expect, it } from 'vitest';
import { SignedStateStore } from './oauth-state.store';

function fakeReqRes(cookie?: string) {
  const jar: Record<string, string> = {};
  const res = { cookie: (k: string, v: string) => (jar[k] = v), clearCookie: () => undefined };
  const req = { headers: { cookie }, res } as never;
  return { req, jar };
}
const store = new SignedStateStore(Buffer.from('test-secret-test-secret'), false);
const issue = () =>
  new Promise<{ state: string; nonce: string }>((resolve) => {
    const { req, jar } = fakeReqRes();
    store.store(req, (_e, state) => resolve({ state: state!, nonce: jar.cc_oauth_state! }));
  });
const check = (state: string, cookie?: string) =>
  new Promise<boolean>((resolve) => store.verify(fakeReqRes(cookie).req, state, (_e, ok) => resolve(ok)));

describe('SignedStateStore', () => {
  it('accepts its own state with the matching cookie', async () => {
    const { state, nonce } = await issue();
    expect(await check(state, `cc_oauth_state=${nonce}`)).toBe(true);
  });
  it('rejects the state without the cookie (login CSRF)', async () => {
    const { state } = await issue();
    expect(await check(state)).toBe(false);
  });
  it('rejects a tampered signature or expiry', async () => {
    const { state, nonce } = await issue();
    const [n, exp, sig] = state.split('.');
    expect(await check(`${n}.${Number(exp) + 1}.${sig}`, `cc_oauth_state=${nonce}`)).toBe(false);
    expect(await check(`${n}.${exp}.${sig!.slice(0, -2)}xx`, `cc_oauth_state=${nonce}`)).toBe(false);
  });
});
