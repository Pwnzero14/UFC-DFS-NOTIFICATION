#!/usr/bin/env node
// UFC prop alerts: fantasy points on Underdog, PrizePicks, Betr and DK Pick6,
// plus tracked over/under markets on the DraftKings Sportsbook.

import { join } from 'node:path';
import { loadConfig, inQuietHours, ROOT } from './config.js';
import * as store from './state.js';
import * as lock from './lock.js';
import { teeConsoleTo } from './logfile.js';
import * as notify from './notify.js';
import { HttpError } from './http.js';

import * as underdog from './adapters/underdog.js';
import * as prizepicks from './adapters/prizepicks.js';
import * as betr from './adapters/betr.js';
import * as pick6 from './adapters/pick6.js';
import * as dksportsbook from './adapters/dksportsbook.js';

const ADAPTERS = [underdog, prizepicks, betr, pick6, dksportsbook];
const STATE_PATH = join(ROOT, 'state.json');
const LOCK_PATH = join(ROOT, 'watcher.lock');
const LOG_PATH = join(ROOT, 'watcher.log');
const MAX_BACKOFF_MS = 30 * 60_000;

const args = new Set(process.argv.slice(2));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ts = () => new Date().toLocaleTimeString();

// ---------------------------------------------------------------- scheduling

const runtime = new Map(); // adapter key -> { nextRunAt, backoffMs, fails }

function schedule(key, delayMs) {
  const r = runtime.get(key) || { backoffMs: 0, fails: 0 };
  r.nextRunAt = Date.now() + delayMs;
  runtime.set(key, r);
}

function due(adapter) {
  const r = runtime.get(adapter.meta.key);
  if (!r?.nextRunAt) return true;
  return Date.now() >= r.nextRunAt;
}

function baseInterval(adapter, cfg) {
  const configured = (cfg.pollSeconds || 60) * 1000;
  // Never poll a book faster than its own safe floor (Cloudflare, etc).
  const floor = adapter.meta.minIntervalMs || 60_000;
  return Math.max(configured, floor) + Math.random() * 5000; // jitter
}

// ------------------------------------------------------------------- alerting

async function dispatch(alert, cfg) {
  notify.logAlert(alert);

  if (inQuietHours(cfg)) {
    console.log('   [quiet hours] desktop toast suppressed');
  } else if (cfg.windowsToast) {
    const headline =
      alert.kind === 'fantasy'
        ? `${alert.bookMeta.name}: UFC FANTASY PROPS UP`
        : `${alert.bookMeta.name}: new UFC market`;
    const body = alert.props
      .slice(0, 3)
      .map((p) => `${p.fighter || 'market'} ${p.statLabel} ${p.value ?? ''}`.trim())
      .join(' - ');
    const res = await notify.sendWindowsToast(headline, body || 'Open the app');
    if (res.error) console.log(`   [toast failed] ${res.error}`);
  }

  const url = cfg.discord?.webhookUrl;
  if (!url) return true;

  try {
    await notify.sendDiscord(url, notify.buildDiscordPayload(alert, cfg));
    console.log('   [discord] sent');
    return true;
  } catch (err) {
    // Report failure so the caller can decline to mark these props as seen.
    // Swallowing this used to lose the alert permanently: the new value was
    // committed to state, the next poll saw no change, and you were never told.
    console.log(`   [discord FAILED - will retry next poll] ${err.message}`);
    return false;
  }
}

function buildAlerts(adapter, result, cfg, firstRun) {
  const alerts = [];
  const push = (kind, props) => {
    if (props.length) alerts.push({ kind, bookMeta: adapter.meta, props });
  };

  if (firstRun && !cfg.alertOnFirstRun) return alerts;

  if (cfg.alertOnFantasy) {
    push('fantasy', result.newProps.filter((p) => store.ALERTING_KINDS.has(p.kind)));
  }
  if (cfg.alertOnUnknownStat) {
    push('unknown', result.newProps.filter((p) => p.kind === 'unknown'));
  }
  if (cfg.alertOnLineMove) {
    // A threshold of 0 means "tell me about any move at all".
    const min = Number(cfg.lineMoveMinDelta) || 0;
    push(
      'move',
      result.moved.filter(
        (p) => Math.abs(Number(p.value) - Number(p.previousValue)) >= min
      )
    );
  }
  return alerts;
}

// ------------------------------------------------------------------ poll loop

async function pollOne(adapter, state, cfg) {
  const key = adapter.meta.key;
  const r = runtime.get(key) || { backoffMs: 0, fails: 0 };

  try {
    const props = await adapter.fetchProps();
    const firstRun = !state.books[key];
    const result = store.diff(state, key, props);
    const fantasyCount = props.filter((p) => p.kind === 'fantasy').length;

    console.log(
      `[${ts()}] ${adapter.meta.name.padEnd(18)} ${String(props.length).padStart(3)} props` +
        ` | fantasy ${fantasyCount}` +
        (result.newProps.length ? ` | +${result.newProps.length} new` : '') +
        (firstRun ? ' | baseline' : '')
    );

    // Any prop whose alert failed to deliver must NOT be recorded as seen, or
    // the next poll finds no change and the alert is lost for good. Holding the
    // previous value back means it is re-detected and re-sent next time.
    const undelivered = new Set();
    for (const alert of buildAlerts(adapter, result, cfg, firstRun)) {
      const ok = await dispatch(alert, cfg);
      if (!ok) for (const p of alert.props) undelivered.add(store.propKey(p));
    }

    if (undelivered.size) {
      const prior = state.books[key]?.props || {};
      for (const k of undelivered) {
        if (prior[k]) result.fresh[k] = prior[k]; // rewind to force a re-alert
        else delete result.fresh[k]; // never seen before: treat as still-new
      }
      console.log(
        `[${ts()}] ${adapter.meta.name.padEnd(18)} ${undelivered.size} prop(s) held back for retry`
      );
    }

    store.commit(state, key, result.fresh, true);
    r.backoffMs = 0;
    r.fails = 0;
    runtime.set(key, r);
    schedule(key, baseInterval(adapter, cfg));
    return true;
  } catch (err) {
    r.fails = (r.fails || 0) + 1;

    let wait;
    if (err instanceof HttpError && err.status === 429) {
      wait = err.retryAfterMs || Math.min(MAX_BACKOFF_MS, 5 * 60_000 * r.fails);
      console.log(
        `[${ts()}] ${adapter.meta.name.padEnd(18)} rate limited - backing off ${Math.round(wait / 1000)}s`
      );
    } else {
      wait = Math.min(MAX_BACKOFF_MS, baseInterval(adapter, cfg) * Math.pow(2, r.fails));
      console.log(
        `[${ts()}] ${adapter.meta.name.padEnd(18)} ERROR ${err.message.slice(0, 110)}` +
          ` - retry in ${Math.round(wait / 1000)}s`
      );
    }

    r.backoffMs = wait;
    runtime.set(key, r);
    schedule(key, wait);
    if (state.books[key]) state.books[key].healthy = false;
    return false;
  }
}

function activeAdapters(cfg) {
  return ADAPTERS.filter((a) => cfg.books[a.meta.key] !== false);
}

const STARTED_AT = Date.now();

/**
 * Heartbeat timing lives in state.json, not memory, so the run.bat restart loop
 * cannot turn a crash into a stream of status posts.
 */
async function maybeHeartbeat(state, cfg, force = false) {
  if (!force) {
    if (!cfg.heartbeat?.enabled) return;
    if (!cfg.discord?.webhookUrl) return;

    const everyMs = Math.max(1, Number(cfg.heartbeat.everyHours) || 12) * 3_600_000;
    const last = state.lastHeartbeatAt ? Date.parse(state.lastHeartbeatAt) : null;
    // First ever run sends one immediately so a restart is visibly confirmed;
    // the persisted timestamp stops it repeating on the next start.
    if (last && Date.now() - last < everyMs) return;
  }

  const books = activeAdapters(cfg).map((a) => a.meta);
  const payload = notify.buildHeartbeatPayload(
    state,
    cfg,
    books,
    force ? null : Date.now() - STARTED_AT
  );

  try {
    await notify.sendDiscord(cfg.discord.webhookUrl, payload);
    // A manual --heartbeat is an extra on-demand check, not the scheduled one:
    // it must not reset the timer. It also runs in a separate process while the
    // daemon owns state.json, so writing here would just get clobbered anyway.
    if (!force) state.lastHeartbeatAt = new Date().toISOString();
    console.log(`[${ts()}] heartbeat sent`);
  } catch (err) {
    // Never let a status post take the watcher down.
    console.log(`[${ts()}] heartbeat failed: ${err.message.slice(0, 100)}`);
  }
}

async function runCycle(state, cfg, force = false) {
  for (const adapter of activeAdapters(cfg)) {
    if (force || due(adapter)) await pollOne(adapter, state, cfg);
  }
  await maybeHeartbeat(state, cfg);
  state.lastRun = new Date().toISOString();
  await store.save(STATE_PATH, state);
}

// ------------------------------------------------------------------- commands

async function cmdStatus(cfg) {
  console.log('Current UFC boards\n');
  for (const adapter of activeAdapters(cfg)) {
    try {
      const props = await adapter.fetchProps();
      const byStat = {};
      for (const p of props) byStat[p.statLabel] = (byStat[p.statLabel] || 0) + 1;
      const fantasy = props.filter((p) => p.kind === 'fantasy');

      console.log(`${adapter.meta.name}  (${props.length} props)`);
      for (const [stat, n] of Object.entries(byStat).sort((a, b) => b[1] - a[1])) {
        const mark = /fantasy|fpts/i.test(stat) ? '   <-- FANTASY' : '';
        console.log(`   ${String(n).padStart(3)}  ${stat}${mark}`);
      }
      if (fantasy.length) {
        console.log('   --- fantasy lines ---');
        for (const p of fantasy.slice(0, 20)) {
          console.log(`   ${(p.fighter || '').padEnd(24)} ${p.value}`);
        }
      }
      console.log();
    } catch (err) {
      console.log(`${adapter.meta.name}  ERROR: ${err.message}\n`);
    }
  }
}

/**
 * Dress rehearsal: take a real poll of a real book, pretend fantasy props just
 * landed on the actual upcoming card, and run the genuine detection + alert
 * path. Never writes state, so it can be run as often as you like.
 */
async function cmdSimulate(cfg) {
  const adapter = underdog; // cheapest board to pull, and the one with real events
  console.log(`Simulating a fantasy drop on ${adapter.meta.name} using the live card...\n`);

  const live = await adapter.fetchProps();
  const scratch = { books: {} };

  // Baseline against the real board exactly as the watcher would.
  let d = store.diff(scratch, adapter.meta.key, live);
  store.commit(scratch, adapter.meta.key, d.fresh);
  console.log(`Baseline: ${live.length} real props, ${d.newProps.length} flagged new (expected ${live.length} on a cold start)`);

  // Pick two *different* fighters from a genuine upcoming fight.
  const seenFighters = new Set();
  const sample = live
    .filter((p) => p.event && p.fighter && !seenFighters.has(p.fighter) && seenFighters.add(p.fighter))
    .slice(0, 2);
  if (!sample.length) {
    console.log('No upcoming MMA card on the board right now - nothing to simulate against.');
    return;
  }
  const injected = sample.map((p, i) => ({
    ...p,
    id: `sim-${i}`,
    statKey: 'fantasy_points',
    statLabel: 'Fantasy Points',
    kind: 'fantasy',
    value: [83.99, 89.99][i] ?? 85.5,
  }));

  d = store.diff(scratch, adapter.meta.key, [...live, ...injected]);
  const fantasyNew = d.newProps.filter((p) => p.kind === 'fantasy');
  console.log(`After injection: ${d.newProps.length} new prop(s), ${fantasyNew.length} of them fantasy\n`);

  if (!fantasyNew.length) {
    console.log('DETECTION FAILED - the fantasy props were not picked up.');
    process.exitCode = 1;
    return;
  }

  await dispatch({ kind: 'fantasy', bookMeta: adapter.meta, props: fantasyNew }, cfg);

  // Now bump those same lines and prove the move path fires too.
  if (cfg.alertOnLineMove) {
    const bumped = injected.map((p, i) => ({
      ...p,
      previousValue: p.value,
      value: Number((p.value + (i === 0 ? 2.51 : -1.5)).toFixed(2)),
    }));
    const d2 = store.diff(
      { books: { [adapter.meta.key]: { props: d.fresh } } },
      adapter.meta.key,
      [...live, ...bumped]
    );
    console.log(`\nSimulating line moves: ${d2.moved.length} detected`);
    if (d2.moved.length) {
      await dispatch({ kind: 'move', bookMeta: adapter.meta, props: d2.moved }, cfg);
    }
  }

  console.log('\nDetection works. Nothing was written to state.json.');
}

async function cmdTestNotify(cfg) {
  const soon = new Date(Date.now() + 864e5).toISOString();
  const sample = {
    kind: 'fantasy',
    bookMeta: underdog.meta,
    props: [
      { fighter: 'Test Fighter A', statLabel: 'Fantasy Points', value: 88.5, event: 'Test vs Test', startsAt: soon },
      { fighter: 'Test Fighter B', statLabel: 'Fantasy Points', value: 91.5, event: 'Test vs Test', startsAt: soon },
    ],
  };
  console.log('Sending a sample alert through every configured channel...');
  await dispatch(sample, cfg);
  if (!cfg.discord?.webhookUrl) {
    console.log('\n(no discord.webhookUrl in config.json - Discord step skipped)');
  }
}

// ----------------------------------------------------------------------- main

async function main() {
  const cfg = await loadConfig();

  if (args.has('--reset')) {
    await store.save(STATE_PATH, { version: 1, initialized: false, books: {}, lastRun: null });
    console.log('state.json cleared - next run re-baselines.');
    return;
  }
  if (args.has('--status')) return cmdStatus(cfg);
  if (args.has('--test-notify')) return cmdTestNotify(cfg);
  if (args.has('--simulate')) return cmdSimulate(cfg);
  if (args.has('--heartbeat')) {
    // Read-only: never writes state, so it is safe to run alongside the daemon.
    const st = await store.load(STATE_PATH);
    await maybeHeartbeat(st, cfg, true); // force, ignores the interval
    return;
  }

  const state = await store.load(STATE_PATH);
  const books = activeAdapters(cfg).map((a) => a.meta.name).join(', ');

  if (args.has('--once')) {
    console.log(`Single poll - ${books}\n`);
    await runCycle(state, cfg, true);
    return;
  }

  // Only the long-running mode takes the lock; --once/--status/--simulate are
  // read-mostly and safe to run alongside a live watcher.
  const held = lock.acquire(LOCK_PATH);
  if (!held.ok) {
    console.log(`A watcher is already running (pid ${held.pid}).`);
    console.log('Stop that one first, or use --status to inspect the boards.');
    return;
  }

  // Log to file from here on: the Scheduled Task has no shell to redirect for us.
  teeConsoleTo(LOG_PATH);

  console.log('UFC Fantasy Prop Alerts');
  console.log(`Watching : ${books}`);
  console.log(`Interval : ${cfg.pollSeconds}s (per-book floors apply)`);
  console.log(`Discord  : ${cfg.discord?.webhookUrl ? 'configured' : 'NOT configured'}`);
  console.log(`Toast    : ${cfg.windowsToast ? 'on' : 'off'}`);
  console.log('Ctrl+C to stop\n');

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    console.log('\nSaving state...');
    await store.save(STATE_PATH, state);
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  await runCycle(state, cfg, true); // immediate first pass
  while (!stopping) {
    await sleep(5000);
    if (stopping) break;
    await runCycle(state, cfg, false);
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
