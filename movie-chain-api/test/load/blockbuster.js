// Step 25 — the blockbuster on-sale. THE SKEW IS THE POINT: 760 rps on one
// chain's screening, 40 rps across five others. Ramp 0→800 over 30 s, hold.
//
//   MODE=baseline  quiet chains only (the reference p95)
//   MODE=full      quiet chains + the blockbuster (thresholds compare to the baseline)
//
// Run through `pnpm load:blockbuster` (tools/run-blockbuster.ts), which seeds,
// runs both modes, checks the database for double sales and archives the result.
import http from 'k6/http';
import { Counter } from 'k6/metrics';

const fx = JSON.parse(open('/fixtures/fixtures.json'));
const BASE = __ENV.BASE_URL || 'http://localhost:3000/api/v1';
const MODE = __ENV.MODE || 'full';
const RAMP = __ENV.RAMP || '30s';
const HOLD = __ENV.HOLD || '5m';
const NOISY_RPS = Number(__ENV.NOISY_RPS || 760);
const QUIET_RPS = Number(__ENV.QUIET_RPS || 40);
const BASELINE_P95 = Number(__ENV.QUIET_P95_BASELINE || 0);

// 409 (seat taken) and 429 (rate limited) are answers, not failures.
http.setResponseCallback(http.expectedStatuses({ min: 200, max: 299 }, 409, 422, 429));

const quiet429 = new Counter('quiet_rate_limited');
const noisy429 = new Counter('noisy_rate_limited');
const serverErrors = new Counter('server_errors');
const holdsWon = new Counter('holds_won');

const seconds = (d) => (d.endsWith('m') ? Number(d.slice(0, -1)) * 60 : Number(d.slice(0, -1)));
const total = `${seconds(RAMP) + seconds(HOLD)}s`;

const scenarios = {
  quiet: {
    executor: 'constant-arrival-rate',
    rate: QUIET_RPS,
    timeUnit: '1s',
    duration: total,
    preAllocatedVUs: 40,
    maxVUs: 200,
    exec: 'quiet',
  },
};
if (MODE === 'full')
  scenarios.noisy = {
    executor: 'ramping-arrival-rate',
    startRate: 0,
    timeUnit: '1s',
    stages: [
      { target: NOISY_RPS, duration: RAMP },
      { target: NOISY_RPS, duration: HOLD },
    ],
    preAllocatedVUs: 200,
    maxVUs: 2000,
    exec: 'noisy',
  };

const thresholds = {
  // Always present, so the baseline run reports the quiet chains' p95 too.
  'http_req_duration{side:quiet}': ['p(95)<10000'],
  // Hold p99 under 400 ms for EVERY tenant (the noisy chain's refusals included).
  'http_req_duration{kind:hold}': ['p(99)<400'],
  server_errors: ['count==0'],
  quiet_rate_limited: ['count==0'], // the quiet chains are never throttled for someone else's on-sale
};
if (MODE === 'full' && BASELINE_P95 > 0) thresholds['http_req_duration{side:quiet}'] = [`p(95)<${(BASELINE_P95 * 1.2).toFixed(2)}`]; // under 20 % worse
if (MODE === 'full') thresholds.noisy_rate_limited = ['count>0']; // the noisy chain gets 429s, not everyone else errors

export const options = { discardResponseBodies: false, scenarios, thresholds, summaryTrendStats: ['avg', 'p(50)', 'p(95)', 'p(99)', 'max'] };

function act(side, chain) {
  const tags = { side };
  // 80 % look at the seat map, 20 % try to hold a seat (released at once if won, so the room stays contested).
  if (Math.random() < 0.8) {
    const r = http.get(`${BASE}/screenings/${chain.screeningId}/seatmap`, { tags: { ...tags, kind: 'seatmap' }, responseType: 'none' });
    return record(side, r);
  }
  const seat = chain.seatIds[Math.floor(Math.random() * chain.seatIds.length)];
  const r = http.post(`${BASE}/screenings/${chain.screeningId}/holds`, JSON.stringify({ seat_ids: [seat] }), {
    headers: { 'content-type': 'application/json' },
    tags: { ...tags, kind: 'hold' },
  });
  record(side, r);
  if (r.status === 201) {
    holdsWon.add(1);
    const b = r.json();
    http.del(`${BASE}/holds/${b.hold_id}`, null, { headers: { 'hold-token': b.hold_token }, tags: { ...tags, kind: 'release' }, responseType: 'none' });
  }
}

function record(side, r) {
  if (r.status >= 500 || r.status === 0) serverErrors.add(1, { side });
  if (r.status === 429) (side === 'quiet' ? quiet429 : noisy429).add(1);
}

export function quiet() {
  act('quiet', fx.quiet[Math.floor(Math.random() * fx.quiet.length)]);
}

export function noisy() {
  act('noisy', fx.noisy);
}

export function handleSummary(data) {
  return { [`/results/summary-${MODE}.json`]: JSON.stringify(data, null, 1) };
}
