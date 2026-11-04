#!/usr/bin/env node
// Generates the CineChain Grafana dashboards (deploy/grafana/dashboards/*.json).
//   node deploy/grafana/gen-dashboards.mjs
// Grafana provisions every file in that folder (folder "CineChain").
//
// Empty data, decided once for every panel:
//   * stat / gauge panels show 0 — their queries end in `or vector(0)` and noValue is "0";
//   * time series, tables, bar gauges and pie charts say "No data available".
// Counters are created on first use: a "count in range" counts a series born inside
// the range from 0, exactly (see delta()).
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'dashboards');
const PROM = { type: 'prometheus', uid: 'prometheus' };
const LOKI = { type: 'loki', uid: 'loki' };
const NO_DATA = 'No data available';
const T = 'tenant=~"$tenant"';

// ------------------------------------------------------------------ PromQL helpers
/**
 * Events in the dashboard range, EXACTLY: the counter now minus its value at the
 * start of the range (0 for a series born inside it). increase() would
 * extrapolate to the range edges and report 20.95 bookings, or revenue 5% high.
 * Only a series whose counter reset in the range (an API restart) falls back to
 * increase(), which handles resets.
 */
const delta = (sel) =>
  `((${sel} - (${sel} offset $__range or ${sel} * 0)) and resets(${sel}[$__range]) == 0 or increase(${sel}[$__range]) and resets(${sel}[$__range]) > 0)`;
const inRange = (sel) => `(sum(${delta(sel)}) or vector(0))`;
/** The same, per label set (for pies, bar gauges and tables). */
const inRangeBy = (by, sel) => `sum by (${by}) (${delta(sel)})`;
const rate = (sel, by, w = '5m') => (by ? `sum by (${by}) (rate(${sel}[${w}]))` : `sum(rate(${sel}[${w}]))`);
const perMin = (sel, by) => `60 * ${rate(sel, by)}`;
/** A quantile of a histogram; `hist` may carry matchers: `name{a="b"}` → `name_bucket{a="b"}`. */
const pq = (q, hist, by = '', w = '5m') => {
  const i = hist.indexOf('{');
  const bucket = i < 0 ? `${hist}_bucket` : `${hist.slice(0, i)}_bucket${hist.slice(i)}`;
  return `histogram_quantile(${q}, sum by (le${by ? `, ${by}` : ''}) (rate(${bucket}[${w}])))`;
};
/**
 * Shows a chain's slug instead of its id: joins on cinechain_tenant_info (control
 * plane). If that is missing (control plane down, or the "other"/"none" buckets),
 * the id itself is used as the name.
 */
const named = (expr) =>
  `(${expr}) * on (tenant) group_left (slug) max by (tenant, slug) (cinechain_tenant_info) or on (tenant) label_replace(${expr}, "slug", "$1", "tenant", "(.*)")`;
const chainLegend = (expr, legend) => (legend && legend.includes('{{tenant}}') ? [named(expr), legend.replaceAll('{{tenant}}', '{{slug}}')] : [expr, legend]);
/** A ratio that is 0 rather than NaN/empty when nothing happened. */
const ratio = (num, den) => `((${num}) / clamp_min(${den}, 1e-9)) or vector(0)`;

// ------------------------------------------------------------------ panel builders
let nextId = 1;
const target = (expr, extra = {}) => ({ refId: extra.refId ?? 'A', datasource: PROM, expr, ...extra });
const thresholds = (steps) => ({ mode: 'absolute', steps: steps.map(([color, value]) => ({ color, value })) });
const GOOD = thresholds([['green', null]]);
const BAD_ABOVE = (n = 1) => thresholds([['green', null], ['red', n]]);
const WARN = (warn, crit) => thresholds([['green', null], ['orange', warn], ['red', crit]]);

function stat(title, expr, o = {}) {
  return {
    type: 'stat',
    title,
    description: o.desc ?? '',
    datasource: PROM,
    w: o.w ?? 4,
    h: o.h ?? 4,
    targets: [target(`(${expr}) or vector(0)`, { instant: true })],
    fieldConfig: { defaults: { unit: o.unit ?? 'short', decimals: o.decimals, noValue: '0', thresholds: o.thresholds ?? GOOD, mappings: o.mappings ?? [], color: { mode: 'thresholds' } }, overrides: [] },
    options: { colorMode: o.colorMode ?? (o.thresholds ? 'background' : 'value'), graphMode: 'none', textMode: 'value', reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false } },
  };
}

function ts(title, targets, o = {}) {
  return {
    type: 'timeseries',
    title,
    description: o.desc ?? '',
    datasource: PROM,
    w: o.w ?? 12,
    h: o.h ?? 8,
    targets: targets.map(([e, l], i) => {
      const [expr, legendFormat] = chainLegend(e, l);
      return target(expr, { refId: String.fromCharCode(65 + i), legendFormat });
    }),
    fieldConfig: {
      defaults: {
        unit: o.unit ?? 'short',
        noValue: NO_DATA,
        min: o.min ?? 0,
        thresholds: o.thresholds ?? GOOD,
        custom: { drawStyle: o.bars ? 'bars' : 'line', fillOpacity: o.stack || o.bars ? 60 : 12, lineWidth: 2, showPoints: 'never', spanNulls: true, stacking: { mode: o.stack ? 'normal' : 'none', group: 'A' }, thresholdsStyle: { mode: o.thresholds ? 'line' : 'off' } },
        color: { mode: 'palette-classic' },
      },
      overrides: [],
    },
    options: { legend: { displayMode: o.legendTable ? 'table' : 'list', placement: 'bottom', calcs: o.legendTable ? ['mean', 'max', 'lastNotNull'] : [] }, tooltip: { mode: 'multi', sort: 'desc' } },
  };
}

function pie(title, e, l, o = {}) {
  const [expr, legend] = chainLegend(e, l);
  return {
    type: 'piechart',
    title,
    description: o.desc ?? '',
    datasource: PROM,
    w: o.w ?? 6,
    h: o.h ?? 8,
    targets: [target(expr, { instant: true, legendFormat: legend })],
    fieldConfig: { defaults: { unit: o.unit ?? 'short', noValue: NO_DATA, color: { mode: 'palette-classic' } }, overrides: [] },
    options: { pieType: 'donut', legend: { displayMode: 'table', placement: 'right', values: ['value', 'percent'] }, reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false }, tooltip: { mode: 'single' } },
  };
}

function bars(title, e, l, o = {}) {
  const [expr, legend] = chainLegend(e, l);
  return {
    type: 'bargauge',
    title,
    description: o.desc ?? '',
    datasource: PROM,
    w: o.w ?? 8,
    h: o.h ?? 8,
    targets: [target(expr, { instant: true, legendFormat: legend })],
    fieldConfig: { defaults: { unit: o.unit ?? 'short', noValue: NO_DATA, min: 0, thresholds: o.thresholds ?? thresholds([['blue', null]]), color: { mode: o.thresholds ? 'thresholds' : 'continuous-BlPu' } }, overrides: [] },
    options: { orientation: 'horizontal', displayMode: 'gradient', showUnfilled: true, valueMode: 'color', namePlacement: 'left', sizing: 'auto', reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false } },
  };
}

/** One row per label set: `columns` maps each instant query (refId) to a column title. */
function table(title, queries, o = {}) {
  const refs = queries.map((_, i) => String.fromCharCode(65 + i));
  const rename = Object.fromEntries(queries.map(([, col], i) => [`Value #${refs[i]}`, col]));
  return {
    type: 'table',
    title,
    description: o.desc ?? '',
    datasource: PROM,
    w: o.w ?? 24,
    h: o.h ?? 9,
    targets: queries.map(([expr], i) => target(o.byChain ? named(expr) : expr, { refId: refs[i], instant: true, format: 'table' })),
    transformations: [
      { id: 'merge', options: {} },
      { id: 'organize', options: { excludeByName: { Time: true, ...(o.byChain ? { tenant: true } : {}), ...(o.hide ?? {}) }, renameByName: { ...rename, ...(o.byChain ? { slug: 'Chain' } : {}), ...(o.rename ?? {}) } } },
      ...(o.sortBy ? [{ id: 'sortBy', options: { sort: [{ field: o.sortBy, desc: true }] } }] : []),
    ],
    fieldConfig: { defaults: { unit: o.unit ?? 'short', noValue: NO_DATA, custom: { align: 'auto', cellOptions: { type: 'auto' } } }, overrides: o.overrides ?? [] },
    options: { showHeader: true, cellHeight: 'sm', footer: { show: false, reducer: ['sum'], fields: '' } },
  };
}

function logs(title, expr, o = {}) {
  return {
    type: 'logs',
    title,
    description: o.desc ?? '',
    datasource: LOKI,
    w: o.w ?? 24,
    h: o.h ?? 12,
    targets: [{ refId: 'A', datasource: LOKI, expr, queryType: 'range' }],
    fieldConfig: { defaults: { noValue: NO_DATA }, overrides: [] },
    options: { showTime: true, wrapLogMessage: true, sortOrder: 'Descending', enableLogDetails: true, prettifyLogMessage: false, dedupStrategy: 'none' },
  };
}

function lokiTs(title, targets, o = {}) {
  const p = ts(title, [], o);
  p.datasource = LOKI;
  p.targets = targets.map(([expr, legendFormat], i) => ({ refId: String.fromCharCode(65 + i), datasource: LOKI, expr, legendFormat, queryType: 'range' }));
  return p;
}

const row = (title) => ({ type: 'row', title, w: 24, h: 1, collapsed: false, panels: [] });
const text = (content, o = {}) => ({ type: 'text', title: o.title ?? '', w: o.w ?? 24, h: o.h ?? 3, options: { mode: 'markdown', content } });

/** Flows panels left to right, wrapping at 24 columns; rows start a new line. */
function layout(panels) {
  let x = 0;
  let y = 0;
  let rowH = 0;
  return panels.map((p) => {
    const { w, h, ...rest } = p;
    if (p.type === 'row' || x + w > 24) {
      y += rowH;
      x = 0;
      rowH = 0;
    }
    const out = { id: nextId++, ...rest, gridPos: { x, y, w, h } };
    x += w;
    rowH = Math.max(rowH, h);
    if (p.type === 'row') {
      y += h;
      x = 0;
      rowH = 0;
    }
    return out;
  });
}

/** The chain picker: shows slugs, filters by id (the label the metrics carry). Falls back to ids without the control plane. */
const tenantVar = () => ({
  name: 'tenant',
  label: 'chain',
  type: 'query',
  datasource: PROM,
  definition: 'query_result(max by (slug, tenant) (cinechain_tenant_info{status!="deleted"}))',
  query: { query: 'query_result(max by (slug, tenant) (cinechain_tenant_info{status!="deleted"}))', refId: 'tenant' },
  regex: '/slug="(?<text>[^"]+)".*tenant="(?<value>[^"]+)"/',
  includeAll: true,
  multi: true,
  allValue: '.*',
  current: { text: 'All', value: '$__all' },
  refresh: 2,
  sort: 1,
});

const LINKS = [{ title: 'CineChain', type: 'dashboards', tags: ['cinechain'], asDropdown: true, includeVars: false, keepTime: true }];

function dashboard(uid, title, description, panels, o = {}) {
  nextId = 1;
  const d = {
    uid,
    title,
    description,
    tags: ['cinechain', ...(o.tags ?? [])],
    timezone: 'browser',
    schemaVersion: 41,
    version: 1,
    editable: true,
    graphTooltip: 1,
    refresh: o.refresh ?? '30s',
    time: { from: o.from ?? 'now-6h', to: 'now' },
    links: LINKS,
    templating: { list: o.vars ?? [tenantVar()] },
    annotations: { list: [] },
    panels: layout(panels),
  };
  writeFileSync(join(OUT, `${uid}.json`), `${JSON.stringify(d, null, 1)}\n`);
  return uid;
}

const MINOR_NOTE = 'Money is integer MINOR units in the stated currency (e.g. KES cents): the platform never stores floats.';

// ================================================================== 1. Bookings & revenue
dashboard(
  'cinechain-bookings',
  'CineChain — Bookings & revenue',
  'Checkout funnel, confirmed sales, revenue and tickets issued, per chain.',
  [
    stat('Bookings confirmed', inRange(`cinechain_booking_confirmed_total{${T}}`), { desc: 'Sales committed in the selected range (online + box office).' }),
    stat('Tickets issued', inRange(`cinechain_booking_tickets_issued_total{${T}}`)),
    stat('Revenue (minor units)', inRange(`cinechain_booking_revenue_minor_total{${T}}`), { desc: MINOR_NOTE, decimals: 0 }),
    stat('Checkout success rate', ratio(inRange(`cinechain_booking_checkout_total{${T},outcome="confirmed"}`), inRange(`cinechain_booking_checkout_total{${T},outcome!="replayed"}`)), {
      unit: 'percentunit',
      decimals: 1,
      desc: 'Confirmed ÷ checkout attempts (idempotent replays excluded).',
    }),
    stat('Checkout p95', `${pq(0.95, `cinechain_booking_checkout_seconds{${T}}`)}`, { unit: 's', decimals: 2, thresholds: WARN(2, 5), desc: 'Includes the payment provider call.' }),
    stat('Seats lost after capture', inRange(`cinechain_booking_seats_lost_after_capture_total{${T}}`), { thresholds: BAD_ABOVE(1), desc: 'Paid but the seats were gone: refunded automatically (FR-53). Should be rare.' }),
    row('Volume'),
    ts('Confirmed bookings / min by chain', [[perMin(`cinechain_booking_confirmed_total{${T}}`, 'tenant'), '{{tenant}}']], { stack: true }),
    ts('Tickets issued / min by chain', [[perMin(`cinechain_booking_tickets_issued_total{${T}}`, 'tenant'), '{{tenant}}']], { stack: true }),
    ts('Revenue / hour by currency (minor units)', [[`3600 * ${rate(`cinechain_booking_revenue_minor_total{${T}}`, 'currency')}`, '{{currency}}']], { desc: MINOR_NOTE }),
    ts('Bookings by channel / min', [[perMin(`cinechain_booking_confirmed_total{${T}}`, 'channel'), '{{channel}}']], { stack: true }),
    row('Checkout'),
    pie('Checkout outcomes', inRangeBy('outcome', `cinechain_booking_checkout_total{${T}}`), '{{outcome}}', { w: 8, desc: 'confirmed, pending (awaiting the provider), replayed, or the refusal code.' }),
    pie('Payment methods used', inRangeBy('method', `cinechain_booking_checkout_total{${T},outcome="confirmed"}`), '{{method}}', { w: 8 }),
    bars('Revenue by chain (minor units)', inRangeBy('tenant, currency', `cinechain_booking_revenue_minor_total{${T}}`), '{{tenant}} · {{currency}}', { w: 8, desc: MINOR_NOTE }),
    ts('Checkout latency', [
      [pq(0.5, `cinechain_booking_checkout_seconds{${T}}`), 'p50'],
      [pq(0.95, `cinechain_booking_checkout_seconds{${T}}`), 'p95'],
      [pq(0.99, `cinechain_booking_checkout_seconds{${T}}`), 'p99'],
    ], { unit: 's' }),
    ts('Checkout refusals / min by reason', [[perMin(`cinechain_booking_checkout_total{${T},outcome!~"confirmed|pending|replayed"}`, 'outcome'), '{{outcome}}']], { bars: true }),
    table('Per chain (selected range)', [
      [inRangeBy('tenant', `cinechain_booking_confirmed_total{${T}}`), 'Bookings'],
      [inRangeBy('tenant', `cinechain_booking_tickets_issued_total{${T}}`), 'Tickets'],
      [inRangeBy('tenant', `cinechain_booking_checkout_total{${T}}`), 'Checkout attempts'],
      [inRangeBy('tenant', `cinechain_booking_seats_lost_after_capture_total{${T}}`), 'Seats lost'],
    ], { sortBy: 'Bookings', byChain: true }),
  ],
  { tags: ['business'] },
);

// ================================================================== 2. Holds & seat inventory
dashboard(
  'cinechain-holds',
  'CineChain — Holds & seat inventory',
  'Seat holds: placed, refused, released, extended; Redis lock latency; the sweeper and integrity guards.',
  [
    stat('Holds placed', inRange(`cinechain_hold_placed_total{${T}}`)),
    stat('Holds refused', inRange(`cinechain_hold_refused_total{${T}}`), { desc: 'Seats taken, seat gaps, too many seats…' }),
    stat('Seats released', inRange(`cinechain_hold_released_total{${T}}`)),
    stat('Hold acquire p99', pq(0.99, `cinechain_hold_acquire_seconds{${T}}`), { unit: 's', decimals: 3, thresholds: WARN(0.25, 0.4), desc: 'Target: < 400 ms at p99 (step 25).' }),
    stat('Double sales (ever)', `sum(cinechain_double_sale_total)`, { thresholds: BAD_ABOVE(1), desc: 'Must stay 0. Any value pages.' }),
    stat('Locks past expiry', `sum(cinechain_seat_locks_past_expiry{${T}})`, { thresholds: WARN(1, 50), desc: 'Seat locks the sweeper has not yet reclaimed.' }),
    row('Flow'),
    ts('Holds placed / min by path', [[perMin(`cinechain_hold_placed_total{${T}}`, 'path'), '{{path}}']], { stack: true, desc: 'redis = fast path; postgres = fallback while Redis is degraded.' }),
    ts('Holds refused / min by reason', [[perMin(`cinechain_hold_refused_total{${T}}`, 'reason'), '{{reason}}']], { bars: true }),
    ts('Released and extended / min', [
      [perMin(`cinechain_hold_released_total{${T}}`), 'seats released'],
      [perMin(`cinechain_hold_extended_total{${T}}`), 'holds extended'],
      [perMin(`cinechain_sweeper_reclaimed_total{${T}}`), 'seats reclaimed by sweeper'],
    ]),
    ts('Hold acquire latency by path', [
      [pq(0.5, `cinechain_hold_acquire_seconds{${T}}`, 'path'), 'p50 {{path}}'],
      [pq(0.99, `cinechain_hold_acquire_seconds{${T}}`, 'path'), 'p99 {{path}}'],
    ], { unit: 's', thresholds: thresholds([['green', null], ['red', 0.4]]) }),
    row('Integrity & sweeper'),
    ts('Sweeper lag by chain', [[`max by (tenant) (cinechain_sweeper_lag{${T}})`, '{{tenant}}']], { unit: 's', w: 8 }),
    ts('Seat locks past expiry by chain', [[`sum by (tenant) (cinechain_seat_locks_past_expiry{${T}})`, '{{tenant}}']], { w: 8 }),
    ts('Redis ↔ Postgres divergence / min', [[perMin('cinechain_hold_redis_postgres_divergence_total'), 'divergences']], { w: 8, desc: 'Redis said free, Postgres said taken (or the reverse). Postgres wins.' }),
    pie('Refusal reasons', inRangeBy('reason', `cinechain_hold_refused_total{${T}}`), '{{reason}}', { w: 8 }),
    pie('Hold channel (refusals)', inRangeBy('channel', `cinechain_hold_refused_total{${T}}`), '{{channel}}', { w: 8 }),
    bars('Holds placed by chain', inRangeBy('tenant', `cinechain_hold_placed_total{${T}}`), '{{tenant}}', { w: 8 }),
  ],
  { tags: ['business'] },
);

// ================================================================== 3. Payments, refunds, reconciliation
dashboard(
  'cinechain-payments',
  'CineChain — Payments & refunds',
  'Provider captures and latency, webhooks, refunds by reason, and the reconciler that repairs orphaned payments.',
  [
    stat('Captures OK', inRange('cinechain_payment_capture_total{outcome="captured"}')),
    stat('Capture failures', inRange('cinechain_payment_capture_total{outcome="failed"}'), { thresholds: WARN(1, 20) }),
    stat('Capture success rate', ratio(inRange('cinechain_payment_capture_total{outcome="captured"}'), inRange('cinechain_payment_capture_total')), { unit: 'percentunit', decimals: 1 }),
    stat('Refunds succeeded', inRange(`cinechain_refund_total{${T},status="succeeded"}`)),
    stat('Refunds failed', inRange(`cinechain_refund_total{${T},status="failed"}`), { thresholds: BAD_ABOVE(1), desc: 'A failed refund PAGES: money owed to a customer.' }),
    stat('Webhook signature failures', inRange('cinechain_payment_webhook_total{result="invalid_signature"}'), { thresholds: WARN(1, 10), desc: 'Forged, stale or misconfigured provider callbacks.' }),
    row('Captures'),
    ts('Captures / min by provider and outcome', [[perMin('cinechain_payment_capture_total', 'provider, outcome'), '{{provider}} · {{outcome}}']], { stack: true }),
    ts('Provider capture latency', [
      [pq(0.5, 'cinechain_payment_capture_seconds', 'provider'), 'p50 {{provider}}'],
      [pq(0.95, 'cinechain_payment_capture_seconds', 'provider'), 'p95 {{provider}}'],
    ], { unit: 's' }),
    ts('Webhooks / min by result', [[perMin('cinechain_payment_webhook_total', 'provider, result'), '{{provider}} · {{result}}']], { stack: true }),
    pie('Capture outcomes', inRangeBy('outcome', 'cinechain_payment_capture_total'), '{{outcome}}', { w: 6 }),
    pie('Webhook results', inRangeBy('result', 'cinechain_payment_webhook_total'), '{{result}}', { w: 6 }),
    row('Refunds & reconciliation'),
    ts('Refunds / hour by reason', [[`3600 * ${rate(`cinechain_refund_total{${T}}`, 'reason')}`, '{{reason}}']], { bars: true }),
    ts('Refunded amount / hour (minor units)', [[`3600 * ${rate(`cinechain_refund_amount_minor_total{${T}}`, 'currency')}`, '{{currency}}']], { desc: MINOR_NOTE }),
    bars('Refunds by reason and status', inRangeBy('reason, status', `cinechain_refund_total{${T}}`), '{{reason}} · {{status}}', { w: 8 }),
    bars('Reconciler actions by chain', inRangeBy('tenant, action', `cinechain_reconciliation_actions_total{${T}}`), '{{tenant}} · {{action}}', { w: 8, desc: 'orphan_refunded: paid but never confirmed → refunded. refund_retried: a pending refund asked again.' }),
    stat('Reconciler runs', inRange(`cinechain_reconciliation_runs_total{${T}}`), { w: 8, h: 8, desc: 'One run per chain, every few minutes.' }),
  ],
  { tags: ['business'] },
);

// ================================================================== 4. Door & admission
dashboard(
  'cinechain-admission',
  'CineChain — Door & admission',
  'Ticket scans at the door: admitted, already used, wrong screening, invalid codes.',
  [
    stat('Scans', inRange(`cinechain_admission_scans_total{${T}}`)),
    stat('Admitted', inRange(`cinechain_admission_scans_total{${T},result="valid"}`), { thresholds: thresholds([['green', null]]) }),
    stat('Already used', inRange(`cinechain_admission_scans_total{${T},result="already_used"}`), { thresholds: WARN(1, 10), desc: 'A second scan of the same ticket: sharing, or a screenshot.' }),
    stat('Invalid codes', inRange(`cinechain_admission_scans_total{${T},result="invalid"}`), { thresholds: WARN(5, 50), desc: 'Unknown here — including another chain\'s codes, which are indistinguishable by design.' }),
    stat('Wrong screening / day', inRange(`cinechain_admission_scans_total{${T},result=~"wrong_screening|wrong_day"}`), { thresholds: WARN(1, 20) }),
    stat('Admit rate', ratio(inRange(`cinechain_admission_scans_total{${T},result="valid"}`), inRange(`cinechain_admission_scans_total{${T}}`)), { unit: 'percentunit', decimals: 1 }),
    row('Door traffic'),
    ts('Scans / min by result', [[perMin(`cinechain_admission_scans_total{${T}}`, 'result'), '{{result}}']], { stack: true, w: 16 }),
    pie('Scan results', inRangeBy('result', `cinechain_admission_scans_total{${T}}`), '{{result}}', { w: 8 }),
    ts('Scans / min by chain', [[perMin(`cinechain_admission_scans_total{${T}}`, 'tenant'), '{{tenant}}']], { stack: true }),
    ts('Ticket scan latency (POST /tickets/redeem)', [
      [`histogram_quantile(0.95, sum by (le) (rate(cinechain_http_route_duration_seconds_bucket{route=~".*/tickets/redeem"}[5m])))`, 'p95'],
      [`histogram_quantile(0.5, sum by (le) (rate(cinechain_http_route_duration_seconds_bucket{route=~".*/tickets/redeem"}[5m])))`, 'p50'],
    ], { unit: 's', desc: 'A door clerk waits on this; the queue at the door grows with it.' }),
    table('Per chain (selected range)', [
      [inRangeBy('tenant', `cinechain_admission_scans_total{${T},result="valid"}`), 'Admitted'],
      [inRangeBy('tenant', `cinechain_admission_scans_total{${T},result="already_used"}`), 'Already used'],
      [inRangeBy('tenant', `cinechain_admission_scans_total{${T},result="invalid"}`), 'Invalid'],
      [inRangeBy('tenant', `cinechain_admission_scans_total{${T},result=~"wrong_.*|void"}`), 'Wrong / void'],
    ], { sortBy: 'Admitted', byChain: true }),
  ],
  { tags: ['business'], vars: [tenantVar()] },
);

// ================================================================== 5. Notifications & background jobs
dashboard(
  'cinechain-jobs',
  'CineChain — Notifications & background jobs',
  'Ticket emails/SMS, report exports, guest-history linking, and BullMQ queue depths.',
  [
    stat('Notifications sent', inRange(`cinechain_notification_total{${T},outcome="sent"}`)),
    stat('Notification failures', inRange(`cinechain_notification_total{${T},outcome="failed"}`), { thresholds: WARN(1, 10), desc: 'Retried by BullMQ; the booking stays confirmed (FR-55).' }),
    stat('Report exports ready', inRange(`cinechain_report_exports_total{${T},outcome="ready"}`)),
    stat('Report exports failed', inRange(`cinechain_report_exports_total{${T},outcome="failed"}`), { thresholds: BAD_ABOVE(1) }),
    stat('Guest bookings linked', inRange(`cinechain_guest_link_bookings_linked_total{${T}}`), { desc: 'Guest purchases attached to a newly verified consumer account.' }),
    stat('Jobs failed (now)', 'sum(cinechain_queue_jobs{state="failed"})', { thresholds: WARN(1, 25), desc: 'Failed jobs retained in Redis across all queues.' }),
    row('Queues'),
    ts('Waiting + delayed jobs by queue', [[`sum by (queue) (cinechain_queue_jobs{state=~"waiting|delayed"})`, '{{queue}}']], { stack: true }),
    ts('Active jobs by queue', [[`sum by (queue) (cinechain_queue_jobs{state="active"})`, '{{queue}}']]),
    table('Queue depths (now)', [
      ['sum by (queue) (cinechain_queue_jobs{state="waiting"})', 'Waiting'],
      ['sum by (queue) (cinechain_queue_jobs{state="active"})', 'Active'],
      ['sum by (queue) (cinechain_queue_jobs{state="delayed"})', 'Delayed'],
      ['sum by (queue) (cinechain_queue_jobs{state="failed"})', 'Failed'],
      ['sum by (queue) (cinechain_queue_jobs{state="completed"})', 'Completed (kept)'],
    ], { rename: { queue: 'Queue' }, h: 8 }),
    row('Work done'),
    ts('Notifications / min by kind and outcome', [[perMin(`cinechain_notification_total{${T}}`, 'kind, outcome'), '{{kind}} · {{outcome}}']], { stack: true }),
    ts('Exports / hour by kind and outcome', [[`3600 * ${rate(`cinechain_report_exports_total{${T}}`, 'kind, outcome')}`, '{{kind}} · {{outcome}}']], { bars: true }),
    ts('Export rows / hour', [[`3600 * ${rate(`cinechain_report_export_rows_total{${T}}`, 'kind')}`, '{{kind}}']]),
    ts('Guest-link jobs and bookings linked / hour', [
      [`3600 * ${rate(`cinechain_guest_link_jobs_total{${T}}`)}`, 'jobs'],
      [`3600 * ${rate(`cinechain_guest_link_bookings_linked_total{${T}}`)}`, 'bookings linked'],
    ]),
  ],
  { tags: ['operations'] },
);

// ================================================================== 6. Rate limits & tiers
dashboard(
  'cinechain-rate-limits',
  'CineChain — Rate limits & tiers',
  'Noisy-neighbour control: per-tenant request rates against tier limits, 429s, and per-tenant latency.',
  [
    stat('429s in range', inRange(`cinechain_rate_limited_total{${T}}`), { thresholds: WARN(1, 1000) }),
    stat('Chains throttled now', `count(sum by (tenant) (rate(cinechain_rate_limited_total{${T}}[5m])) > 0)`, { thresholds: WARN(1, 3) }),
    stat('Busiest chain (req/s)', `max(sum by (tenant) (rate(cinechain_http_request_duration_seconds_count{${T},tenant!="none"}[5m])))`, { unit: 'reqps', decimals: 1 }),
    stat('Tiers in use', 'count(count by (tier) (cinechain_tenants{status="active"}))', { desc: 'Distinct tiers among active tenants (control plane).' }),
    stat('Active tenants', 'sum(cinechain_tenants{status="active"})'),
    stat('Unattributed req/s', `sum(rate(cinechain_http_request_duration_seconds_count{tenant="none"}[5m]))`, { unit: 'reqps', decimals: 1, desc: 'Requests with no tenant: health, login, discovery, refused early.' }),
    row('Throttling'),
    ts('429s / s by chain and scope', [[rate(`cinechain_rate_limited_total{${T}}`, 'tenant, scope'), '{{tenant}} · {{scope}}']], { unit: 'reqps', stack: true }),
    ts('Requests / s by chain', [[rate(`cinechain_http_request_duration_seconds_count{${T}}`, 'tenant'), '{{tenant}}']], { unit: 'reqps' }),
    ts('p95 latency by chain', [[pq(0.95, `cinechain_http_request_duration_seconds{${T}}`, 'tenant'), '{{tenant}}']], { unit: 's', desc: 'The noisy-neighbour signal: a quiet chain\'s p95 must not move when another chain floods.' }),
    ts('Share of requests refused (429) by chain', [[`${rate(`cinechain_rate_limited_total{${T}}`, 'tenant')} / clamp_min(${rate(`cinechain_http_request_duration_seconds_count{${T}}`, 'tenant')}, 1e-9)`, '{{tenant}}']], { unit: 'percentunit' }),
    bars('429s by chain (range)', inRangeBy('tenant', `cinechain_rate_limited_total{${T}}`), '{{tenant}}', { w: 12, thresholds: thresholds([['orange', null]]) }),
    pie('Tenants by tier', 'sum by (tier) (cinechain_tenants{status!="deleted"})', '{{tier}}', { w: 12, desc: 'Tier limits are rows (the tier table); see GET /admin/tiers.' }),
  ],
  { tags: ['operations'] },
);

// ================================================================== 7. Security & isolation
dashboard(
  'cinechain-security',
  'CineChain — Security & tenant isolation',
  'Cross-tenant probes, token misuse, failed logins, and access by suspended tenants.',
  [
    stat('Cross-tenant attempts', inRange('cinechain_security_events_total{kind="tenant_mismatch"}'), { thresholds: BAD_ABOVE(1), desc: 'A token for one chain used against another. Answered 404, never 403.' }),
    stat('Wrong token type', inRange('cinechain_security_events_total{kind="wrong_token_type"}'), { thresholds: WARN(1, 10) }),
    stat('Refresh-token reuse', inRange('cinechain_security_events_total{kind="refresh_token_reuse"}'), { thresholds: BAD_ABOVE(1), desc: 'A rotated refresh token presented again: likely theft. The family is revoked.' }),
    stat('Failed logins', inRange('cinechain_security_events_total{kind="login_failed"}'), { thresholds: WARN(10, 100) }),
    stat('Suspended-tenant access', inRange('cinechain_security_events_total{kind="suspended_tenant_access"}'), { thresholds: WARN(1, 50) }),
    stat('Max probes by one actor', `max(cinechain_cross_tenant_attempts_max_per_actor)`, { thresholds: WARN(3, 10), desc: 'The CrossTenantProbing alert input.' }),
    row('Trends'),
    ts('Security events / min by kind', [[perMin('cinechain_security_events_total', 'kind'), '{{kind}}']], { bars: true, w: 16 }),
    pie('Events by kind', inRangeBy('kind', 'cinechain_security_events_total'), '{{kind}}', { w: 8 }),
    ts('Cross-tenant probes: max per actor, by chain', [[`max by (tenant) (cinechain_cross_tenant_attempts_max_per_actor)`, '{{tenant}}']]),
    ts('401 / 403 / 404 responses / s', [
      [`sum(rate(cinechain_http_route_duration_seconds_count{status="401"}[5m]))`, '401'],
      [`sum(rate(cinechain_http_route_duration_seconds_count{status="403"}[5m]))`, '403'],
      [`sum(rate(cinechain_http_route_duration_seconds_count{status="404"}[5m]))`, '404'],
    ], { unit: 'reqps', desc: 'A burst of 404s on resource routes is what enumeration looks like.' }),
    logs('Security log lines (warn+)', '{service=~"cinechain-.*", level=~"warn|error|fatal"} |~ "(?i)(security|mismatch|reuse|forbidden|probe|suspended)"', { h: 10 }),
  ],
  { tags: ['security'], vars: [] },
);

// ================================================================== 8. API performance by route
dashboard(
  'cinechain-api',
  'CineChain — API performance by route',
  'RED metrics per route template: rate, errors, duration.',
  [
    stat('Requests / s', 'sum(rate(cinechain_http_route_duration_seconds_count{route=~"$route"}[5m]))', { unit: 'reqps', decimals: 1 }),
    stat('5xx rate', ratio('sum(rate(cinechain_http_route_duration_seconds_count{route=~"$route",status=~"5.."}[5m]))', 'sum(rate(cinechain_http_route_duration_seconds_count{route=~"$route"}[5m]))'), { unit: 'percentunit', decimals: 2, thresholds: WARN(0.01, 0.05) }),
    stat('4xx rate', ratio('sum(rate(cinechain_http_route_duration_seconds_count{route=~"$route",status=~"4.."}[5m]))', 'sum(rate(cinechain_http_route_duration_seconds_count{route=~"$route"}[5m]))'), { unit: 'percentunit', decimals: 1 }),
    stat('p50', `histogram_quantile(0.5, sum by (le) (rate(cinechain_http_route_duration_seconds_bucket{route=~"$route"}[5m])))`, { unit: 's', decimals: 3 }),
    stat('p95', `histogram_quantile(0.95, sum by (le) (rate(cinechain_http_route_duration_seconds_bucket{route=~"$route"}[5m])))`, { unit: 's', decimals: 3, thresholds: WARN(0.5, 1) }),
    stat('p99', `histogram_quantile(0.99, sum by (le) (rate(cinechain_http_route_duration_seconds_bucket{route=~"$route"}[5m])))`, { unit: 's', decimals: 3, thresholds: WARN(1, 2.5) }),
    row('Rate & errors'),
    ts('Requests / s by route', [['sum by (method, route) (rate(cinechain_http_route_duration_seconds_count{route=~"$route"}[5m]))', '{{method}} {{route}}']], { unit: 'reqps', legendTable: true, h: 10 }),
    ts('Responses / s by status', [['sum by (status) (rate(cinechain_http_route_duration_seconds_count{route=~"$route"}[5m]))', '{{status}}']], { unit: 'reqps', stack: true, h: 10 }),
    row('Duration'),
    ts('p95 by route', [['histogram_quantile(0.95, sum by (le, method, route) (rate(cinechain_http_route_duration_seconds_bucket{route=~"$route"}[5m])))', '{{method}} {{route}}']], { unit: 's', legendTable: true, h: 10 }),
    ts('5xx / s by route', [['sum by (method, route) (rate(cinechain_http_route_duration_seconds_count{route=~"$route",status=~"5.."}[5m]))', '{{method}} {{route}}']], { unit: 'reqps', h: 10 }),
    table('Routes (selected range)', [
      [inRangeBy('method, route', 'cinechain_http_route_duration_seconds_count{route=~"$route"}'), 'Requests'],
      [inRangeBy('method, route', 'cinechain_http_route_duration_seconds_count{route=~"$route",status=~"5.."}'), '5xx'],
      [inRangeBy('method, route', 'cinechain_http_route_duration_seconds_count{route=~"$route",status=~"4.."}'), '4xx'],
      ['histogram_quantile(0.95, sum by (le, method, route) (rate(cinechain_http_route_duration_seconds_bucket{route=~"$route"}[$__range])))', 'p95 (s)'],
    ], { sortBy: 'Requests', rename: { method: 'Method', route: 'Route' }, h: 12, overrides: [{ matcher: { id: 'byName', options: 'p95 (s)' }, properties: [{ id: 'unit', value: 's' }, { id: 'decimals', value: 3 }] }] }),
  ],
  {
    tags: ['operations'],
    vars: [
      {
        name: 'route',
        label: 'route',
        type: 'query',
        datasource: PROM,
        definition: 'label_values(cinechain_http_route_duration_seconds_count, route)',
        query: { query: 'label_values(cinechain_http_route_duration_seconds_count, route)', refId: 'route' },
        includeAll: true,
        multi: true,
        allValue: '.*',
        current: { text: 'All', value: '$__all' },
        refresh: 2,
        sort: 1,
      },
    ],
  },
);

// ================================================================== 9. Runtime & infrastructure
dashboard(
  'cinechain-runtime',
  'CineChain — Runtime & infrastructure',
  'Both planes up, Node event loop and memory, Postgres pools (booking vs reporting), Redis.',
  [
    stat('API (app plane) up', 'max(up{job="cinechain-api"})', { thresholds: thresholds([['red', null], ['green', 1]]), mappings: [{ type: 'value', options: { 0: { text: 'DOWN' }, 1: { text: 'UP' } } }], desc: 'Prometheus can scrape :3000.' }),
    stat('Control plane up', 'max(up{job="cinechain-control"})', { thresholds: thresholds([['red', null], ['green', 1]]), mappings: [{ type: 'value', options: { 0: { text: 'DOWN' }, 1: { text: 'UP' } } }] }),
    stat('Redis', 'max(cinechain_redis_up)', { thresholds: thresholds([['red', null], ['green', 1]]), mappings: [{ type: 'value', options: { 0: { text: 'DOWN' }, 1: { text: 'UP' } } }], desc: 'The app\'s circuit breaker view. Down = holds fall back to Postgres.' }),
    stat('Event-loop lag p99', 'max(cinechain_node_nodejs_eventloop_lag_p99_seconds{job="cinechain-api"})', { unit: 's', decimals: 3, thresholds: WARN(0.1, 0.5) }),
    stat('Heap used', 'sum(cinechain_node_nodejs_heap_size_used_bytes{job="cinechain-api"})', { unit: 'bytes' }),
    stat('Booking pool waiting', 'sum(cinechain_db_pool_connections{pool="booking",state="waiting_clients"})', { thresholds: WARN(1, 10), desc: 'Requests queued for a database connection: pool exhaustion.' }),
    row('Node.js'),
    ts('CPU (cores)', [['sum by (job) (rate(cinechain_node_process_cpu_seconds_total[5m]))', '{{job}}']], { unit: 'short', w: 8 }),
    ts('Resident memory', [['sum by (job) (cinechain_node_process_resident_memory_bytes)', '{{job}}']], { unit: 'bytes', w: 8 }),
    ts('Event-loop lag', [
      ['max by (job) (cinechain_node_nodejs_eventloop_lag_p50_seconds)', 'p50 {{job}}'],
      ['max by (job) (cinechain_node_nodejs_eventloop_lag_p99_seconds)', 'p99 {{job}}'],
    ], { unit: 's', w: 8 }),
    ts('Heap used vs total', [
      ['sum by (job) (cinechain_node_nodejs_heap_size_used_bytes)', 'used {{job}}'],
      ['sum by (job) (cinechain_node_nodejs_heap_size_total_bytes)', 'total {{job}}'],
    ], { unit: 'bytes', w: 8 }),
    ts('GC time / s', [['sum by (kind) (rate(cinechain_node_nodejs_gc_duration_seconds_sum[5m]))', '{{kind}}']], { unit: 's', w: 8 }),
    ts('Active handles', [['sum by (job) (cinechain_node_nodejs_active_handles_total)', '{{job}}']], { w: 8 }),
    row('Postgres pools'),
    ts('Booking pool', [['sum by (state) (cinechain_db_pool_connections{pool="booking"})', '{{state}}']], { stack: false, desc: 'The sale path. waiting_clients > 0 means requests queue for a connection.' }),
    ts('Reporting pool', [['sum by (state) (cinechain_db_pool_connections{pool="reporting"})', '{{state}}']], { desc: 'Separate and small: a slow report must never take the sale path\'s connections.' }),
    row('Scrapes'),
    ts('Scrape duration', [['max by (job) (scrape_duration_seconds{job=~"cinechain-.*"})', '{{job}}']], { unit: 's' }),
    ts('Series per scrape', [['max by (job) (scrape_samples_scraped{job=~"cinechain-.*"})', '{{job}}']], { desc: 'The tenant-label cap (top 50 + other) keeps this bounded.' }),
  ],
  { tags: ['operations'], vars: [] },
);

// ================================================================== 10. Platform: tenants, billing, lifecycle (control plane)
dashboard(
  'cinechain-platform',
  'CineChain — Platform: tenants, billing & lifecycle',
  'Control plane (127.0.0.1:3001): tenants by status and tier, subscriptions, invoices, metered usage, onboarding and offboarding.',
  [
    stat('Active tenants', 'sum(cinechain_tenants{status="active"})'),
    stat('Suspended', 'sum(cinechain_tenants{status="suspended"})', { thresholds: WARN(1, 5) }),
    stat('Offboarding / deleted', 'sum(cinechain_tenants{status=~"offboarding|deleted"})'),
    stat('Subscriptions past due', 'sum(cinechain_subscriptions{status="past_due"})', { thresholds: WARN(1, 5) }),
    stat('Open invoices', 'sum(cinechain_invoices{status="open"})'),
    stat('Overdue invoices', 'sum(cinechain_invoices_overdue)', { thresholds: BAD_ABOVE(1) }),
    stat('Open amount (minor units)', 'sum(cinechain_invoice_amount_minor{status="open"})', { desc: MINOR_NOTE, decimals: 0 }),
    stat('Paid amount (minor units)', 'sum(cinechain_invoice_amount_minor{status="paid"})', { desc: MINOR_NOTE, decimals: 0 }),
    stat('Onboarding stuck', 'sum(cinechain_onboarding_stuck_runs)', { thresholds: BAD_ABOVE(1), desc: 'Provisioning for more than 5 minutes.' }),
    stat('Offboarding in progress', 'sum(cinechain_offboarding_runs{status=~"offboarding|exported"})', { thresholds: WARN(1, 3) }),
    stat('Bookings metered (month)', 'sum(cinechain_metered_usage{metric="bookings"})'),
    stat('Requests metered (month)', 'sum(cinechain_metered_usage{metric="requests"})'),
    row('Tenants'),
    pie('Tenants by status', 'sum by (status) (cinechain_tenants)', '{{status}}', { w: 8 }),
    pie('Tenants by tier (not deleted)', 'sum by (tier) (cinechain_tenants{status!="deleted"})', '{{tier}}', { w: 8 }),
    pie('Subscriptions by status', 'sum by (status) (cinechain_subscriptions)', '{{status}}', { w: 8 }),
    ts('Tenants by status over time', [['sum by (status) (cinechain_tenants)', '{{status}}']], { stack: true }),
    ts('Subscriptions by plan over time', [['sum by (plan) (cinechain_subscriptions{status!="cancelled"})', '{{plan}}']], { stack: true }),
    row('Billing'),
    table('Invoices (now)', [
      ['sum by (status, currency) (cinechain_invoices)', 'Count'],
      ['sum by (status, currency) (cinechain_invoice_amount_minor)', 'Amount (minor units)'],
    ], { w: 12, h: 8, rename: { status: 'Status', currency: 'Currency' } }),
    bars('Metered usage this month (all tenants)', 'sum by (metric) (cinechain_metered_usage)', '{{metric}}', { w: 12, desc: 'Per-tenant usage: GET /admin/metering.' }),
    row('Lifecycle'),
    ts('Onboarding runs by status', [['sum by (status) (cinechain_onboarding_runs)', '{{status}}']], { w: 12 }),
    ts('Offboarding runs by status', [['sum by (status) (cinechain_offboarding_runs)', '{{status}}']], { w: 12, desc: 'offboarding → exported (verified) → deleted (report signed).' }),
  ],
  { tags: ['platform'], vars: [], refresh: '1m' },
);

// ================================================================== 11. Logs explorer
dashboard(
  'cinechain-logs',
  'CineChain — Logs explorer',
  'Loki: both planes, filterable by level, component (context) and tenant_id (structured metadata).',
  [
    lokiTs('Log lines / min by level', [['sum by (level) (count_over_time({service=~"$service", level=~"$level", context=~"$context"} | tenant_id=~"$tenant_id" [1m]))', '{{level}}']], { bars: true, w: 12, h: 7 }),
    lokiTs('Errors & warnings / min by component', [['sum by (context) (count_over_time({service=~"$service", level=~"warn|error|fatal", context=~"$context"} | tenant_id=~"$tenant_id" [1m]))', '{{context}}']], { stack: true, w: 12, h: 7 }),
    logs('Logs', '{service=~"$service", level=~"$level", context=~"$context"} | tenant_id=~"$tenant_id" |~ "$search"', { h: 18 }),
  ],
  {
    tags: ['logs'],
    from: 'now-1h',
    refresh: '',
    vars: [
      { name: 'service', label: 'service', type: 'custom', query: 'cinechain-api,cinechain-control', includeAll: true, multi: true, allValue: 'cinechain-.*', current: { text: 'All', value: '$__all' } },
      { name: 'level', label: 'level', type: 'custom', query: 'trace,debug,info,warn,error,fatal', includeAll: true, multi: true, allValue: '.+', current: { text: 'All', value: '$__all' } },
      {
        name: 'context',
        label: 'component',
        type: 'query',
        datasource: LOKI,
        query: { label: 'context', stream: '{service=~"cinechain-.*"}', type: 1, refId: 'context' },
        definition: 'label_values({service=~"cinechain-.*"}, context)',
        includeAll: true,
        multi: true,
        allValue: '.*',
        current: { text: 'All', value: '$__all' },
        refresh: 2,
        sort: 1,
      },
      { name: 'tenant_id', label: 'tenant_id', type: 'textbox', query: '.*', current: { text: '.*', value: '.*' } },
      { name: 'search', label: 'contains (regex)', type: 'textbox', query: '', current: { text: '', value: '' } },
    ],
  },
);

console.log('dashboards written to', OUT);
