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
// the MMA page, then each fight's page, and reads the markets off the rendered
// page. BetMGM pushes its odds over a websocket rather than plain JSON requests
// (checked live on 2026-11-09: no feed request is ever made), so the page text
// is the reliable source. It does NOT disguise itself: if BetMGM refuses an automated browser, the poll fails
// with a plain "blocked" error and the heartbeat goes red. Nothing here tries
// to get round a bot check.

import { loadConfig } from '../config.js';
import { browseSession, findBrowser } from '../browser.js';

export const BOARD_URL = 'https://ky.betmgm.com/en/sports/mma-45';

// Market names to ping on, as case-insensitive regex. Overridable with
// betmgm.watch in config.json.
export const DEFAULT_WATCH = ['point\\s*deduct'];

// Only fights whose competition (the "USA | UFC 334" crumb on a fight page)
// matches one of these. BetMGM's MMA page can list PFL and others too. A fight
// whose crumb could not be read is kept. Overridable with betmgm.competitions.
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

/** The fixture id BetMGM puts at the end of every fight URL. */
export function fixtureIdFromUrl(url) {
  const m = String(url || '').split(/[?#]/)[0].match(/\/events\/[^/]*?-(\d{5,})\/?$/);
  return m ? m[1] : null;
}

/**
 * The fight's name. Page title first ("Cyril Gane - Josh Hokit Odds | BetMGM"),
 * else the URL slug ("cyril-gane-fra-josh-hokit-usa-19955231").
 */
export function fightName(title, url) {
  const t = String(title || '')
    .split('|')[0]
    .replace(/\b(odds|betting|lines|props)\b.*$/i, '')
    .replace(/\s*\([A-Z]{2,3}\)/g, '')
    .trim();
  if (/\s[-–]\s|\svs\.?\s/i.test(t)) return t.replace(/\s+[-–]\s+|\s+vs\.?\s+/i, ' vs ');
  const last = String(url || '').split(/[?#]/)[0].split('/').filter(Boolean).pop() || '';
  const name = last.replace(/-\d{5,}$/, '').replace(/-/g, ' ').trim();
  return name ? name.replace(/\b\w/g, (c) => c.toUpperCase()) : null;
}

/**
 * Turn what the fight pages showed into props: one per market per fight.
 *
 * `pages` is [{ url, title, competition, markets: [{ name, note }] }], one
 * entry per fight.
 * Markets whose name matches `watch` alert; the rest are recorded quietly.
 */
export function normalizeBetMGM(
  pages,
  { watch = DEFAULT_WATCH, competitions = DEFAULT_COMPETITIONS } = {}
) {
  const watchRes = watch.map((w) => new RegExp(w, 'i'));
  const watched = (name) => watchRes.some((re) => re.test(name));
  const compRes = competitions.map((c) => new RegExp(c, 'i'));

  const props = [];
  const seen = new Set();
  for (const page of pages || []) {
    const id = fixtureIdFromUrl(page?.url);
    if (!id) continue;
    if (page.competition && compRes.length && !compRes.some((re) => re.test(page.competition))) continue;
    const event = fightName(page.title, page.url) || `Fight ${id}`;
    for (const mk of page.markets || []) {
      const name = String(mk?.name || '').replace(/\s+/g, ' ').trim();
      if (!name) continue;
      const key = `${id}|${name}`.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const isWatched = watched(name);
      props.push({
        book: meta.key,
        id: key,
        event,
        fighter: null,
        statLabel: name,
        statKey: slug(name),
        // Watched markets alert the moment they appear. Everything else is
        // only recorded, so a moneyline tick never pings.
        kind: isWatched ? 'tracked' : 'board',
        value: null,
        status: 'open',
        startsAt: null,
        url: page.url,
        note: String(mk.note || '').trim() || 'posted',
        starred: isWatched,
      });
    }
  }
  return props;
}

// ------------------------------------------------------------- page scripts

const EVENT_LINK = '/\\/sports\\/events\\/[^/]+-\\d{5,}$/i';

// MMA board: every fight link. BetMGM fight URLs end in the fixture id:
// /en/sports/events/cyril-gane-fra-josh-hokit-usa-19955231
export const LIST_SCRIPT = `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const links = () => [...document.querySelectorAll('a[href]')]
    .map(a => a.href.split(/[?#]/)[0])
    .filter(h => ${EVENT_LINK}.test(h));
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

// Fight page: every market heading in the fight panel, with the prices under
// it. A heading is found two ways: its text matches a watched name or looks
// like a market title ("Fight result: 2-way"), or its element carries one of
// BetMGM's market-title classes. The left rail only lists fights, never market
// names, so it cannot produce a false match.
export const fightScript = (watch) => `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const watch = ${JSON.stringify(watch)}.map(w => new RegExp(w, 'i'));
  for (let i = 0; i < 40 && !/fight result|2-way|point deduct/i.test(document.body?.innerText || ''); i++) await sleep(300);
  await sleep(1500);

  const own = e => [...e.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join(' ').replace(/\\s+/g, ' ').trim();
  const TITLE_CLASS = /option-group-name|market-name|option-group-header|group-name|panel-title|market-title/i;
  const LOOKS_LIKE_MARKET = /^(fight result|method of victory|total rounds|round betting|will the fight|to win by|fight to go|point deduct|go the distance)/i;

  const markets = [];
  const seen = new Set();
  for (const e of document.querySelectorAll('body *')) {
    const t = own(e) || (e.children.length === 0 ? (e.textContent || '').trim() : '');
    if (!t || t.length < 4 || t.length > 120) continue;
    const cls = typeof e.className === 'string' ? e.className : '';
    if (!(watch.some(re => re.test(t)) || LOOKS_LIKE_MARKET.test(t) || TITLE_CLASS.test(cls))) continue;
    if (seen.has(t.toLowerCase())) continue;
    // Climb to the block holding this market's prices, without swallowing the
    // whole page.
    let box = e, note = '';
    for (let i = 0; i < 7 && box; i++, box = box.parentElement) {
      const txt = (box.innerText || '').trim();
      if (txt.length > 700) break;
      if (txt.length > t.length + 3 && /\\d/.test(txt.replace(t, ''))) { note = txt; break; }
    }
    if (!note && !watch.some(re => re.test(t))) continue;
    seen.add(t.toLowerCase());
    note = note.replace(t, '').split('\\n').map(s => s.trim()).filter(Boolean).join(' · ').slice(0, 180);
    markets.push({ name: t, note });
  }

  // "USA | UFC 334" above the fight names says which card this is.
  let competition = null;
  for (const e of document.querySelectorAll('body *')) {
    const m = own(e).match(/^[A-Za-z .]{2,30}\\s\\|\\s(.{2,60})$/);
    if (m) { competition = m[1].trim(); break; }
  }

  const links = [...document.querySelectorAll('a[href]')]
    .map(a => a.href.split(/[?#]/)[0])
    .filter(h => ${EVENT_LINK}.test(h));
  return { url: location.href.split(/[?#]/)[0], title: document.title, competition, markets, links: [...new Set(links)],
           text: (document.body?.innerText || '').slice(0, 300) };
})()`;

// What a refusal looks like. Matched so the error says "blocked" instead of
// an unhelpful "no fights", never so it can be worked around.
const BLOCKED = /access denied|you don't have permission to access|request blocked|press (&|and) hold|confirm you are a human|verify you are human|are you a robot|unusual (traffic|activity)|not available in your (location|area|region)/i;

const MAX_FIGHTS = 30;

async function readLive(boardUrl, watch) {
  if (!findBrowser()) throw new Error('BetMGM needs a local Chrome/Edge install');

  return browseSession(async (page) => {
    await page.goto(boardUrl);
    const listed = (await page.evaluate(LIST_SCRIPT, 60000)) || {};
    const pageText = `${listed.title || ''} ${listed.text || ''}`;
    const queue = [...(listed.links || [])];
    if (!queue.length && BLOCKED.test(pageText)) {
      throw new Error('BetMGM blocked the automated browser - turn books.betmgm off');
    }

    // Each fight's own page lists every market it has, not just the moneyline
    // the board shows. That is where a point deduction prop lands. The left
    // rail there also lists the rest of the card, which fills in any fight the
    // board did not show.
    const done = new Set();
    const pages = [];
    while (queue.length && done.size < MAX_FIGHTS) {
      const url = queue.shift();
      const id = fixtureIdFromUrl(url);
      if (!id || done.has(id)) continue;
      done.add(id);
      await page.goto(url);
      const got = await page.evaluate(fightScript(watch), 45000).catch(() => null);
      if (!got) continue;
      pages.push({ ...got, url });
      for (const l of got.links || []) if (!done.has(fixtureIdFromUrl(l))) queue.push(l);
    }
    return { pages, pageText: pageText.slice(0, 300) };
  });
}

// ------------------------------------------------------------------- fetch

export async function fetchProps() {
  const cfg = await loadConfig().catch(() => ({}));
  const bm = cfg.betmgm || {};
  const watch = Array.isArray(bm.watch) && bm.watch.length ? bm.watch : DEFAULT_WATCH;
  const { pages, pageText } = await readLive(bm.boardUrl || BOARD_URL, watch);

  if (!pages.length) {
    throw new Error(
      `BetMGM: MMA page showed no fights - page changed or blocked? (${pageText.replace(/\s+/g, ' ').slice(0, 80)})`
    );
  }
  const competitions = Array.isArray(bm.competitions) ? bm.competitions : DEFAULT_COMPETITIONS;
  const props = normalizeBetMGM(pages, { watch, competitions });
  if (!props.length) {
    throw new Error(`BetMGM: opened ${pages.length} fight page(s) but read no markets - page layout changed?`);
  }
  return props;
}
