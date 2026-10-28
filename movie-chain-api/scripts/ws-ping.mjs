#!/usr/bin/env node
// Step 1 check: a Socket.IO client gets `pong` from the /realtime namespace.
// The gateway returns a WsResponse, which Nest emits as an event (not an ack).
import { io } from 'socket.io-client';

const url = process.argv[2] ?? 'http://localhost:3000/realtime';
const socket = io(url, { transports: ['websocket'], timeout: 3000, reconnection: false });
const fail = (why) => {
  console.error(`ws-ping failed: ${why}`);
  process.exit(1);
};
const timer = setTimeout(() => fail('timeout'), 5000);

socket.on('connect_error', (e) => fail(e.message));
socket.on('pong', () => {
  clearTimeout(timer);
  console.log('pong');
  socket.close();
  process.exit(0);
});
socket.on('connect', () => socket.emit('ping', {}));
