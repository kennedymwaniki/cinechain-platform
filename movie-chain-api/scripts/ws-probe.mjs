#!/usr/bin/env node
// A hostile seat-map client, for checking a running server by hand:
//
//   node scripts/ws-probe.mjs --tenant <tenant-id> --screening <screening-id> [--token <jwt>] [--seconds 10]
//
// It tries every way a client might watch a room it should not: naming the
// room `t:<tenant>:scr:<screening>` directly, and connecting with a token that
// carries a tenant. Place holds on that screening meanwhile; it must report
// ZERO seat events. (Subscribing by screening id is the legitimate path and
// is not attempted here.)
import { io } from 'socket.io-client';

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const base = arg('base', 'http://localhost:3000');
const tenant = arg('tenant');
const screening = arg('screening');
const token = arg('token');
const seconds = Number(arg('seconds', '10'));
if (!tenant || !screening) {
  console.error('usage: ws-probe.mjs --tenant <id> --screening <id> [--token <jwt>] [--seconds 10]');
  process.exit(2);
}

const room = `t:${tenant}:scr:${screening}`;
const s = io(`${base}/seatmap`, { transports: ['websocket'], auth: token ? { token } : {} });
let events = 0;
s.on('connect', () => {
  console.log(`connected; trying to join ${room} by name`);
  for (const ev of ['join', 'subscribe', 'joinRoom']) s.emit(ev, { room });
});
s.on('error', (e) => console.log('server refused:', JSON.stringify(e)));
s.on('disconnect', (r) => console.log('disconnected:', r));
s.onAny((event, data) => {
  if (String(event).startsWith('seats:') || String(event).startsWith('screening:')) {
    events++;
    console.log('LEAK', event, JSON.stringify(data));
  }
});
setTimeout(() => {
  console.log(`seat events received: ${events}`);
  s.disconnect();
  process.exit(events === 0 ? 0 : 1);
}, seconds * 1000);
