// FanDuel Sportsbook - every UFC market on every fight, and every new one.
//
// Unlike the other adapters this does not watch a fixed list. FanDuel posts a
// fight's markets in waves: moneyline, method, distance and rounds first, then
// specials like "Under Time / Gone in 60 Seconds" and the stat props (knockdowns,
// takedowns, significant strikes) closer to the card. The point is to hear about
// each wave the moment it lands, so every market is tracked, and so is every
// selection inside it - a new runner added to an existing market is a drop too.
//
// Source: a plain headless Chrome, the way Pick6 is read. It opens the UFC page,
// then each fight and each of its tabs, and keeps the market JSON those pages
// fetch for their own display (event-page / content-managed-page). It does NOT
// disguise itself as a person: if FanDuel refuses an automated browser, this
// reports that plainly and the heartbeat goes red, rather than trying to get
// round it.
//
// FanDuel answers headless Chrome with a press-and-hold bot check, so in
// practice the board comes from the capture extension (extension/fanduel-capture):
// it reads the odds your own FanDuel tabs loaded and posts them to the watcher,
// which saves them to fanduel-board.json. When that file exists it is used.
//
// fanduel.boardFile overrides both, reading captured FanDuel JSON from a
// file instead. The file may hold one raw response, an array of them, or
// { responses: [ { url?, json } | raw, ... ], fights?: [url, ...] }.

import { readFile, stat as statFile } from 'node:fs/promises';
import { propKey } from '../state.js';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { loadConfig, ROOT } from '../config.js';
import { browseSession, findBrowser } from '../browser.js';

const BOARD_URL = 'https://sportsbook.fanduel.com/navigation/ufc';
const BOARD_FILE_MAX_AGE_MS = 30 * 60_000;

// Where the watcher's local receiver saves what the FanDuel capture extension
// sends (see src/receiver.js). When this file exists it is used instead of the
// headless browser, which FanDuel blocks.
export const RECEIVED_BOARD = join(ROOT, 'fanduel-board.json');

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
  // One browser walks every fight and every tab, which takes a few minutes on
  // a full card; asking more often than this would just stack runs up.
  minIntervalMs: 300_000,
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

// ------------------------------------------------------------- page scripts

// Responses worth keeping: the page's own market feeds.
const CAPTURE = /fanduel\.com\/api\/(?:event-page|content-managed-page)/i;

// UFC landing page: every fight link. FanDuel fight URLs end in the numeric
// event id: /mma/ufc-matches/ciryl-gane-v-josh-hokit-36094809
export const LIST_SCRIPT = `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const links = () => [...document.querySelectorAll('a[href]')]
    .map(a => a.href.split(/[?#]/)[0])
    .filter(h => /sportsbook\\.fanduel\\.com\\/(?:mma|ufc)\\/.+-\\d{6,}$/i.test(h));
  for (let i = 0; i < 40 && !links().length; i++) await sleep(300);
  let last = -1, stable = 0;
  for (let i = 0; i < 40 && stable < 3; i++) {
    window.scrollBy(0, Math.round(window.innerHeight * 0.85));
    await sleep(350);
    const n = links().length;
    stable = n === last ? stable + 1 : 0;
    last = n;
  }
  const text = (document.body?.innerText || '').slice(0, 2000);
  return { links: [...new Set(links())], text, title: document.title };
})()`;

// Fight page: the tab bar's titles (Popular, Method of Victory, Round Props,
// Time Props, and whatever FanDuel adds later), found by anchoring on Popular
// and reading the other short labels in the same row.
export const TABS_SCRIPT = `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const leaves = () => [...document.querySelectorAll('a,button,span,div,p')]
    .filter(e => e.children.length === 0 && (e.textContent || '').trim());
  const anchor = () => leaves().find(e => /^(popular|all)$/i.test(e.textContent.trim()));
  for (let i = 0; i < 40 && !anchor(); i++) await sleep(300);
  const a = anchor();
  if (!a) return [];
  const top = a.getBoundingClientRect().top;
  let row = a.parentElement;
  for (let i = 0; i < 8 && row; i++, row = row.parentElement) {
    const peers = [...row.querySelectorAll('*')]
      .filter(e => e.children.length === 0)
      .filter(e => Math.abs(e.getBoundingClientRect().top - top) < 12)
      .map(e => (e.textContent || '').trim())
      .filter(t => t && t.length < 40);
    if (peers.length >= 2) return [...new Set(peers)];
  }
  return [a.textContent.trim()];
})()`;

/** Click the tab whose visible text is exactly `title`. */
export const clickTabScript = (title) => `(async () => {
  const want = ${JSON.stringify(title)}.toLowerCase();
  const leaf = [...document.querySelectorAll('a,button,span,div,p')]
    .find(e => e.children.length === 0 && (e.textContent || '').trim().toLowerCase() === want);
  if (!leaf) return false;
  (leaf.closest('a,button,[role="tab"],[role="button"]') || leaf).click();
  await new Promise(r => setTimeout(r, 1800));
  return true;
})()`;

/** Tab titles an event-page response lists, if it lists any. */
export function tabsFromJson(json) {
  const titles = [];
  for (const tabs of collect(json, 'tabs')) {
    for (const t of values(tabs)) {
      if (t && typeof t.title === 'string' && t.title.trim()) titles.push(t.title.trim());
    }
  }
  return [...new Set(titles)];
}

// What a refusal looks like. Matched so the error says "blocked" instead of
// an unhelpful "no fights", never so it can be worked around.
const BLOCKED = /access denied|access to this page has been denied|press (&|and) hold|confirm you are a human|unusual (traffic|activity)|are you a robot|verify you are human|captcha|not available in your (location|area)|request blocked/i;

async function readLive(boardUrl) {
  if (!findBrowser()) throw new Error('FanDuel needs a local Chrome/Edge install');

  return browseSession(
    async (page) => {
      await page.goto(boardUrl);
      const listed = (await page.evaluate(LIST_SCRIPT, 60000)) || {};
      const fights = (listed.links || []).map((url) => ({ url, eventId: eventIdFromUrl(url) }));
      await page.settle();

      if (!fights.length && !page.responses.length && BLOCKED.test(`${listed.title} ${listed.text}`)) {
        throw new Error('FanDuel blocked the automated browser (press-and-hold bot check) - use the FanDuel capture extension');
      }

      for (const fight of fights) {
        const before = page.responses.length;
        await page.goto(fight.url);
        await page.settle();

        const fromJson = page.responses.slice(before).flatMap((r) => tabsFromJson(r.json));
        const fromDom = (await page.evaluate(TABS_SCRIPT, 30000).catch(() => [])) || [];
        const tabs = [...new Set([...fromJson, ...fromDom])].filter(
          // Popular is already open; Same Game Parlay repeats the other tabs.
          (t) => !/^(popular|all)$/i.test(t) && !/same game parlay|^sgp/i.test(t)
        );

        for (const tab of tabs) {
          const n = page.responses.length;
          const clicked = await page.evaluate(clickTabScript(tab), 20000).catch(() => false);
          await page.settle();
          // FanDuel also addresses tabs as ?tab=<slug>; use that when the click
          // did not land or did not fetch anything.
          if (!clicked || page.responses.length === n) {
            await page.goto(`${fight.url}?tab=${slug(tab)}`);
            await page.settle();
          }
        }
      }
      return { fights, responses: page.responses.map((r) => r.json) };
    },
    { capture: CAPTURE }
  );
}

async function readBoardFile(boardFile) {
  let st;
  try {
    st = await statFile(boardFile);
  } catch {
    throw new Error(`FanDuel board file not found: ${boardFile}`);
  }
  const ageMs = Date.now() - st.mtimeMs;
  if (ageMs > BOARD_FILE_MAX_AGE_MS) {
    throw new Error(`FanDuel board file is stale (${Math.round(ageMs / 60000)}m old)`);
  }
  return normalizeBoardFile(JSON.parse((await readFile(boardFile, 'utf8')).replace(/^﻿/, '')));
}

// ------------------------------------------------------------------- fetch

export async function fetchProps() {
  const cfg = await loadConfig().catch(() => ({}));
  const fd = cfg.fanduel || {};
  const boardFile =
    String(fd.boardFile || '').trim() || (existsSync(RECEIVED_BOARD) ? RECEIVED_BOARD : '');

  const { responses, fights } = boardFile
    ? await readBoardFile(boardFile)
    : await readLive(fd.boardUrl || BOARD_URL);

  if (!fights.length && !responses.length) {
    throw new Error('FanDuel: UFC page showed no fights and no market data - page changed or blocked?');
  }
  const highlight = Array.isArray(fd.highlight) && fd.highlight.length ? fd.highlight : DEFAULT_HIGHLIGHT;
  const oddsMarkets =
    Array.isArray(fd.oddsMarkets) && fd.oddsMarkets.length ? fd.oddsMarkets : DEFAULT_ODDS_MARKETS;
  const props = normalizeFanDuel(responses, fights, { highlight, oddsMarkets });
  if (!props.length && (fights.length || responses.length)) {
    throw new Error(
      `FanDuel: ${fights.length} fight(s) and ${responses.length} response(s) but no UFC markets read - feed shape changed?`
    );
  }
  return props;
}
