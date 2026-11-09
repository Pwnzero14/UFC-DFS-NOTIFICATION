// BetMGM Sportsbook (Kentucky) - pings when a watched UFC market posts.
//
// Built for one prop: "point deduction". BetMGM puts up moneylines first and
// specials like the point deduction market closer to the card, so this watches
// every UFC fight on ky.betmgm.com and alerts the moment a market whose name
// matches betmgm.watch (default: point deduction) appears on any of them.
// Every other market is recorded too, quietly, so the console and heartbeat
// show the book is being read even while nothing watched has posted.
//
// Source: a plain headless Chrome, the same one FanDuel and Pick6 use. It opens
// the MMA page, then each fight's page, and keeps the market JSON those pages
// fetch for their own display (BetMGM's cds-api "bettingoffer" feed). It does
// NOT disguise itself: if BetMGM refuses an automated browser, the poll fails
// with a plain "blocked" error and the heartbeat goes red. Nothing here tries
// to get round a bot check.

import { loadConfig } from '../config.js';
import { browseSession, findBrowser } from '../browser.js';

export const BOARD_URL = 'https://ky.betmgm.com/en/sports/mma-45';

// Market names to ping on, as case-insensitive regex. Overridable with
// betmgm.watch in config.json.
export const DEFAULT_WATCH = ['point\\s*deduct'];

// Only fights in a competition matching one of these. BetMGM's MMA page also
// lists PFL and others. A fight with no competition name at all is kept.
export const DEFAULT_COMPETITIONS = ['ufc'];

export const meta = {
  key: 'betmgm',
  name: 'BetMGM',
  color: 0xc5a464,
  boardUrl: BOARD_URL,
  // One browser visits every fight on the card; no need to ask more often.
  minIntervalMs: 300_000,
  // A real sportsbook: no fantasy line will ever post here.
  offersFantasy: false,
};

// ------------------------------------------------------------------ parsing

const slug = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

// BetMGM wraps display text as { value: "..." } almost everywhere.
const text = (v) => (v && typeof v === 'object' ? v.value ?? v.text ?? '' : v ?? '');

/** "2:19955231" or 19955231 -> "19955231" */
export function fixtureId(id) {
  const m = String(id ?? '').match(/(\d{5,})\s*$/);
  return m ? m[1] : null;
}

/** The fixture id BetMGM puts at the end of every fight URL. */
export function fixtureIdFromUrl(url) {
  const m = String(url || '').split(/[?#]/)[0].match(/\/events\/[^/]*?-(\d{5,})\/?$/);
  return m ? m[1] : null;
}

/** Every object in a JSON tree that looks like a fixture carrying markets. */
function fixturesIn(node, out = [], depth = 0) {
  if (!node || typeof node !== 'object' || depth > 14) return out;
  if (Array.isArray(node)) {
    for (const v of node) fixturesIn(v, out, depth + 1);
    return out;
  }
  if (
    node.id != null &&
    node.name &&
    (Array.isArray(node.games) || Array.isArray(node.optionMarkets))
  ) {
    out.push(node);
  }
  for (const v of Object.values(node)) fixturesIn(v, out, depth + 1);
  return out;
}

function american(raw) {
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n === 0) return null;
  return n > 0 ? `+${n}` : String(n);
}

/** A market's selections as { name, odds }, from either feed shape. */
function selections(market) {
  const list = Array.isArray(market.results)
    ? market.results
    : Array.isArray(market.options)
      ? market.options
      : [];
  return list
    .filter((s) => s && text(s.name))
    .filter((s) => !/^(hidden|closed|settled)$/i.test(s.visibility || s.status || ''))
    .map((s) => ({
      name: String(text(s.name)).trim(),
      odds: american(s.americanOdds ?? s.price?.americanOdds),
    }));
}

function summarize(sels) {
  if (!sels.length) return 'posted';
  const shown = sels.slice(0, 3).map((s) => `${s.name}${s.odds ? ` ${s.odds}` : ''}`).join(' · ');
  return sels.length > 3 ? `${shown} · +${sels.length - 3} more` : shown;
}

/** "Cyril Gane (FRA) - Josh Hokit (USA)" -> "Cyril Gane vs Josh Hokit" */
function eventName(fx) {
  const parts = Array.isArray(fx.participants)
    ? fx.participants.map((p) => String(text(p.name)).trim()).filter(Boolean)
    : [];
  if (parts.length === 2) return `${parts[0]} vs ${parts[1]}`;
  const raw = String(text(fx.name)).trim();
  return raw.replace(/\s*\([A-Z]{2,3}\)/g, '').replace(/\s+-\s+/, ' vs ') || null;
}

const competitionOf = (fx) =>
  String(text(fx.competition?.name) || text(fx.tournament?.name) || '').trim();

/**
 * Turn captured BetMGM JSON into props: one per market per fight.
 *
 * `fights` ({ url, fixtureId }) are the fight pages found on the MMA board; a
 * fixture listed there is kept even when its competition name is missing.
 */
export function normalizeBetMGM(
  responses,
  fights = [],
  { watch = DEFAULT_WATCH, competitions = DEFAULT_COMPETITIONS } = {}
) {
  const watchRes = watch.map((w) => new RegExp(w, 'i'));
  const watched = (name) => watchRes.some((re) => re.test(name));
  const compRes = competitions.map((c) => new RegExp(c, 'i'));
  const urlById = new Map(fights.filter((f) => f.fixtureId).map((f) => [f.fixtureId, f.url]));

  // fixtureId -> { fixture, markets: Map(name -> selections) }. The same
  // fixture arrives several times (board, then its own page with every market);
  // markets merge so the fullest view wins.
  const byFixture = new Map();
  for (const json of responses) {
    for (const fx of fixturesIn(json)) {
      const id = fixtureId(fx.id);
      if (!id) continue;
      // MMA is sport 45 on BetMGM. Anything else in a capture is ignored.
      if (fx.sport?.id != null && String(fx.sport.id) !== '45') continue;
      const comp = competitionOf(fx);
      if (comp && compRes.length && !compRes.some((re) => re.test(comp))) continue;

      const entry = byFixture.get(id) || { fixture: fx, markets: new Map() };
      if (!entry.fixture.startDate && fx.startDate) entry.fixture = fx;
      for (const m of [...(fx.games || []), ...(fx.optionMarkets || [])]) {
        const name = String(text(m?.name)).trim();
        if (!name) continue;
        if (/^(closed|settled)$/i.test(m.status || m.visibility || '')) continue;
        const sels = selections(m);
        const prior = entry.markets.get(name);
        if (!prior || sels.length > prior.length) entry.markets.set(name, sels);
      }
      byFixture.set(id, entry);
    }
  }

  const props = [];
  for (const [id, { fixture, markets }] of byFixture) {
    const event = eventName(fixture) || `Fight ${id}`;
    const url = urlById.get(id) || BOARD_URL;
    for (const [name, sels] of markets) {
      const isWatched = watched(name);
      props.push({
        book: meta.key,
        id: `${id}|${name}`.toLowerCase(),
        event,
        fighter: null,
        statLabel: name,
        statKey: slug(name),
        // Watched markets alert the moment they appear. Everything else is
        // only recorded, so a moneyline tick never pings.
        kind: isWatched ? 'tracked' : 'board',
        value: null,
        status: 'open',
        startsAt: fixture.startDate || null,
        url,
        note: summarize(sels),
        starred: isWatched,
      });
    }
  }
  return props;
}

// ------------------------------------------------------------- page scripts

// The page's own market feed.
const CAPTURE = /\/cds-api\/bettingoffer\//i;

// MMA board: every fight link. BetMGM fight URLs end in the fixture id:
// /en/sports/events/cyril-gane-fra-josh-hokit-usa-19955231
export const LIST_SCRIPT = `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const links = () => [...document.querySelectorAll('a[href]')]
    .map(a => a.href.split(/[?#]/)[0])
    .filter(h => /\\/sports\\/events\\/[^/]+-\\d{5,}$/i.test(h));
  for (let i = 0; i < 50 && !links().length; i++) await sleep(300);
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

// What a refusal looks like. Matched so the error says "blocked" instead of
// an unhelpful "no fights", never so it can be worked around.
const BLOCKED = /access denied|you don't have permission to access|request blocked|press (&|and) hold|confirm you are a human|verify you are human|are you a robot|unusual (traffic|activity)|captcha|not available in your (location|area|region)/i;

async function readLive(boardUrl) {
  if (!findBrowser()) throw new Error('BetMGM needs a local Chrome/Edge install');

  return browseSession(
    async (page) => {
      await page.goto(boardUrl);
      const listed = (await page.evaluate(LIST_SCRIPT, 60000)) || {};
      await page.settle();

      const fights = (listed.links || []).map((url) => ({ url, fixtureId: fixtureIdFromUrl(url) }));
      const pageText = `${listed.title || ''} ${listed.text || ''}`;
      if (!fights.length && !page.responses.length && BLOCKED.test(pageText)) {
        throw new Error('BetMGM blocked the automated browser - turn books.betmgm off');
      }

      // Each fight's own page fetches every market it has, not just the
      // moneyline the board shows. That is where a point deduction prop lands.
      for (const fight of fights) {
        await page.goto(fight.url);
        await page.settle();
      }
      return {
        fights,
        responses: page.responses.map((r) => r.json),
        pageText: pageText.slice(0, 300),
      };
    },
    { capture: CAPTURE }
  );
}

// ------------------------------------------------------------------- fetch

export async function fetchProps() {
  const cfg = await loadConfig().catch(() => ({}));
  const bm = cfg.betmgm || {};
  const { fights, responses, pageText } = await readLive(bm.boardUrl || BOARD_URL);

  if (!fights.length && !responses.length) {
    throw new Error(
      `BetMGM: MMA page showed no fights and no market data - page changed or blocked? (${pageText.replace(/\s+/g, ' ').slice(0, 80)})`
    );
  }
  const watch = Array.isArray(bm.watch) && bm.watch.length ? bm.watch : DEFAULT_WATCH;
  const competitions = Array.isArray(bm.competitions) ? bm.competitions : DEFAULT_COMPETITIONS;
  const props = normalizeBetMGM(responses, fights, { watch, competitions });
  if (!props.length && fights.length) {
    throw new Error(
      `BetMGM: ${fights.length} fight(s) and ${responses.length} response(s) but no UFC markets read - feed shape changed?`
    );
  }
  return props;
}
