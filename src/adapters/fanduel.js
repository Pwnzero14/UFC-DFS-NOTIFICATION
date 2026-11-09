// FanDuel Sportsbook - every UFC market on every fight, and every new one.
//
// Unlike the other adapters this does not watch a fixed list. FanDuel posts a
// fight's markets in waves: moneyline, method, distance and rounds first, then
// specials like "Under Time / Gone in 60 Seconds" and the stat props (knockdowns,
// takedowns, significant strikes) closer to the card. The point is to hear about
// each wave the moment it lands, so every market is tracked, and so is every
// selection inside it - a new runner added to an existing market is a drop too.
//
// Source: fanduel.boardFile, the same bridge Underdog and Betr use. The page in
// your own browser fetches its market JSON (event-page / content-managed-page
// responses); whatever captures those writes them to this file, and the watcher
// reads it. The file may hold any of:
//   - one raw FanDuel response object
//   - an array of them
//   - { responses: [ { url?, json } | rawResponse, ... ], fights?: [{ url }] }
// Markets are read out of every `attachments.markets` it can find, so the exact
// wrapping does not matter.

import { readFile, stat as statFile } from 'node:fs/promises';
import { propKey } from '../state.js';
import { loadConfig } from '../config.js';

const BOARD_URL = 'https://sportsbook.fanduel.com/navigation/ufc';
const BOARD_FILE_MAX_AGE_MS = 30 * 60_000;

// Markets you are specifically waiting on. They alert like everything else; a
// match just gets a star so it stands out in a busy channel. Overridable with
// fanduel.highlight in config.json (strings, read as case-insensitive regex).
export const DEFAULT_HIGHLIGHT = [
  'knockdown',
  'takedown',
  'sig(nificant)?\\.? ?strike',
  '60 seconds|gone in|under time',
];

// Head-to-head markets whose prices are worth watching: a favorite flipping to
// underdog, or a slight favorite turning into a heavy one. Overridable with
// fanduel.oddsMarkets in config.json (strings, read as case-insensitive regex).
export const DEFAULT_ODDS_MARKETS = ['^moneyline$', '^fight (winner|result)$', '^to win'];

export const meta = {
  key: 'fanduel',
  name: 'FanDuel Sportsbook',
  color: 0x1493ff,
  boardUrl: BOARD_URL,
  minIntervalMs: 60_000,
  // A real sportsbook: no fantasy line will ever post here.
  offersFantasy: false,
};

// ------------------------------------------------------------------ parsing

const slug = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[™®]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

/** The event id FanDuel puts at the end of every fight URL. */
export function eventIdFromUrl(url) {
  const m = String(url || '').split(/[?#]/)[0].match(/-(\d{6,})\/?$/);
  return m ? m[1] : null;
}

/** "ciryl-gane-v-josh-hokit-36094809" -> "Ciryl Gane v Josh Hokit" */
function eventNameFromUrl(url) {
  const last = String(url || '').split(/[?#]/)[0].split('/').filter(Boolean).pop() || '';
  const name = last
    .replace(/-\d{6,}$/, '')
    .split('-')
    .filter(Boolean)
    .map((w) => (w === 'v' || w === 'vs' ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
  return name || null;
}

/** Every value of `key` anywhere in a JSON tree. */
function collect(node, key, out = [], depth = 0) {
  if (!node || typeof node !== 'object' || depth > 12) return out;
  if (Array.isArray(node)) {
    for (const v of node) collect(v, key, out, depth + 1);
    return out;
  }
  for (const [k, v] of Object.entries(node)) {
    if (k === key) out.push(v);
    collect(v, key, out, depth + 1);
  }
  return out;
}

const values = (v) => (Array.isArray(v) ? v : v && typeof v === 'object' ? Object.values(v) : []);

function americanOddsNum(runner) {
  const a = runner?.winRunnerOdds?.americanDisplayOdds;
  const n = Number(a?.americanOddsInt ?? a?.americanOdds ?? runner?.winRunnerOdds?.americanOdds);
  return Number.isFinite(n) && n !== 0 ? n : null;
}

function americanOdds(runner) {
  const a = runner?.winRunnerOdds?.americanDisplayOdds;
  const raw = a?.americanOddsInt ?? a?.americanOdds ?? runner?.winRunnerOdds?.americanOdds;
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return String(raw);
  return n > 0 ? `+${n}` : String(n);
}

// A runner's line lives either in `handicap` or in its name ("Over 2.5").
// Only half-point numbers count as a line in a name: "Under 60 seconds" is a
// selection, not an Under at 60.
function runnerLine(runner) {
  const h = Number(runner?.handicap);
  if (Number.isFinite(h) && h !== 0) return Math.abs(h);
  const m = String(runner?.runnerName || '').match(/\b(?:over|under)\s+(\d+\.5)\b/i);
  return m ? Number(m[1]) : null;
}

// The part of a runner's name that identifies it across polls. An O/U number in
// the name changes every time the line moves and would read as a new selection,
// so it is dropped here; the line itself is reported on the market.
const runnerIdentity = (name) =>
  String(name || '').replace(/\b(over|under)\s+\d+\.5\b/gi, '$1').trim();

const liveRunner = (r) => !r?.runnerStatus || /^(active|open)$/i.test(r.runnerStatus);

function summarize(runners) {
  const shown = runners
    .slice(0, 3)
    .map((r) => `${r.runnerName}${r.odds ? ` ${r.odds}` : ''}`)
    .join(' · ');
  return runners.length > 3 ? `${shown} · +${runners.length - 3} more` : shown;
}

/** Accept the board file's shapes and return { responses: [json], fights: [{url, eventId}] }. */
export function normalizeBoardFile(raw) {
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.responses) ? raw.responses : [raw];
  const responses = list.filter(Boolean).map((r) => (r && r.json !== undefined ? r.json : r));
  const fights = (Array.isArray(raw?.fights) ? raw.fights : [])
    .map((f) => (typeof f === 'string' ? { url: f } : f))
    .filter((f) => f?.url)
    .map((f) => ({ url: f.url, eventId: String(f.eventId ?? eventIdFromUrl(f.url) ?? '') || null }));
  return { responses, fights };
}

/**
 * Turn captured FanDuel JSON into props: one per market, plus one per selection.
 *
 * Only MMA events are kept: those whose eventTypeId says MMA, or whose id
 * belongs to a fight page listed in `fights`. Anything else in the capture -
 * a promo carousel for another sport, say - is ignored.
 */
export function normalizeFanDuel(
  responses,
  fights = [],
  { highlight = DEFAULT_HIGHLIGHT, oddsMarkets = DEFAULT_ODDS_MARKETS } = {}
) {
  const starRes = highlight.map((h) => new RegExp(h, 'i'));
  const starred = (label) => starRes.some((re) => re.test(label));
  const oddsRes = oddsMarkets.map((h) => new RegExp(h, 'i'));
  const watchesOdds = (name) => oddsRes.some((re) => re.test(name));

  const fightById = new Map(fights.filter((f) => f.eventId).map((f) => [String(f.eventId), f]));

  const events = new Map();
  for (const json of responses) {
    for (const evs of collect(json, 'events')) {
      for (const e of values(evs)) {
        if (e?.eventId != null && e.name) events.set(String(e.eventId), e);
      }
    }
  }

  // MMA on FanDuel is eventTypeId 26420387. Kept loose: an event with no type
  // at all is accepted, so a capture that only has markets still works.
  const isMma = (eventId) => {
    if (fightById.has(eventId)) return true;
    const ev = events.get(eventId);
    if (!ev || ev.eventTypeId == null) return !fightById.size;
    return String(ev.eventTypeId) === '26420387';
  };

  // eventId -> marketName -> merged market. FanDuel lists one market under
  // several tabs, and sometimes splits a ladder across market ids that share a
  // name; both collapse into one tracked market.
  const byEvent = new Map();
  for (const json of responses) {
    for (const mks of collect(json, 'markets')) {
      for (const m of values(mks)) {
        if (!m || m.eventId == null || !m.marketName || !Array.isArray(m.runners)) continue;
        const eventId = String(m.eventId);
        if (!isMma(eventId)) continue;
        if (/^(closed|settled)$/i.test(m.marketStatus || '')) continue;

        if (!byEvent.has(eventId)) byEvent.set(eventId, new Map());
        const markets = byEvent.get(eventId);
        const name = String(m.marketName).trim();
        const merged = markets.get(name) || {
          name,
          status: m.marketStatus || 'OPEN',
          runners: new Map(),
          lines: new Set(),
        };
        for (const run of m.runners) {
          if (!run?.runnerName || !liveRunner(run)) continue;
          const line = runnerLine(run);
          // Every rung counts toward the market's lines, even the ones that
          // collapse into an existing selection below.
          if (line != null) merged.lines.add(line);
          const id = runnerIdentity(run.runnerName);
          // First sighting wins, so an alternate rung cannot overwrite the main line.
          if (!merged.runners.has(id)) {
            merged.runners.set(id, {
              runnerName: String(run.runnerName).trim(),
              id,
              odds: americanOdds(run),
              price: americanOddsNum(run),
            });
          }
        }
        markets.set(name, merged);
      }
    }
  }

  const props = [];
  for (const [eventId, markets] of byEvent) {
    const fight = fightById.get(eventId);
    const ev = events.get(eventId);
    const event = ev?.name || eventNameFromUrl(fight?.url) || `Event ${eventId}`;
    const startsAt = ev?.openDate || null;
    const url = fight?.url || BOARD_URL;

    for (const mk of markets.values()) {
      const runners = [...mk.runners.values()];
      if (!runners.length) continue;

      // A market's line only means something when it has exactly one. A ladder
      // (Over 1.5 / 2.5 / 3.5) has no single number to watch move.
      const lines = [...mk.lines];
      const value = lines.length === 1 ? lines[0] : null;

      const market = {
        book: meta.key,
        id: `${eventId}|${mk.name}`.toLowerCase(),
        event,
        fighter: null,
        statLabel: mk.name,
        statKey: slug(mk.name),
        kind: 'tracked',
        value,
        status: String(mk.status).toLowerCase(),
        startsAt,
        url,
        note: summarize(runners),
        starred: starred(mk.name),
      };
      props.push(market);

      const parentKey = propKey(market);
      // A two-way moneyline: each fighter's price is watched for big swings.
      const priced = runners.length === 2 && watchesOdds(mk.name);
      for (const r of runners) {
        if (priced && r.price != null) {
          props.push({
            book: meta.key,
            id: `${eventId}|${mk.name}|${r.id}`.toLowerCase(),
            event,
            fighter: r.runnerName,
            statLabel: mk.name,
            statKey: `${slug(mk.name)}::${slug(r.id)}`,
            kind: 'tracked',
            // American odds. Every tick is recorded, but only a swing that
            // matters alerts - see oddsMoveIsMajor in alerts.js.
            value: r.price,
            unit: 'odds',
            status: 'open',
            startsAt,
            url,
            note: r.odds,
            starred: false,
            parentKey,
          });
          continue;
        }
        props.push({
          book: meta.key,
          id: `${eventId}|${mk.name}|${r.id}`.toLowerCase(),
          event,
          fighter: null,
          statLabel: `${mk.name} — ${r.runnerName}`,
          statKey: `${slug(mk.name)}::${slug(r.id)}`,
          kind: 'tracked',
          // Odds move constantly; a selection is watched for appearing, not
          // for its price.
          value: null,
          status: 'open',
          startsAt,
          url,
          note: r.odds || 'posted',
          starred: starred(`${mk.name} ${r.runnerName}`),
          // A brand new market already announces its selections, so a
          // selection only alerts on its own when added to a market already up.
          parentKey,
        });
      }
    }
  }
  return props;
}

// ------------------------------------------------------------------- fetch

export async function fetchProps() {
  const cfg = await loadConfig().catch(() => ({}));
  const fd = cfg.fanduel || {};
  const boardFile = String(fd.boardFile || '').trim();
  if (!boardFile) {
    throw new Error('FanDuel needs fanduel.boardFile in config.json - see README');
  }

  let st;
  try {
    st = await statFile(boardFile);
  } catch {
    throw new Error(`FanDuel board file not found: ${boardFile} - is the capture writing it?`);
  }
  const ageMs = Date.now() - st.mtimeMs;
  if (ageMs > BOARD_FILE_MAX_AGE_MS) {
    throw new Error(
      `FanDuel board file is stale (${Math.round(ageMs / 60000)}m old) - the capture has not run recently`
    );
  }

  const raw = JSON.parse((await readFile(boardFile, 'utf8')).replace(/^﻿/, ''));
  const { responses, fights } = normalizeBoardFile(raw);
  const highlight = Array.isArray(fd.highlight) && fd.highlight.length ? fd.highlight : DEFAULT_HIGHLIGHT;
  const oddsMarkets =
    Array.isArray(fd.oddsMarkets) && fd.oddsMarkets.length ? fd.oddsMarkets : DEFAULT_ODDS_MARKETS;
  const props = normalizeFanDuel(responses, fights, { highlight, oddsMarkets });
  if (!props.length && responses.length) {
    throw new Error('FanDuel board file has no UFC markets in it - capture shape changed?');
  }
  return props;
}
