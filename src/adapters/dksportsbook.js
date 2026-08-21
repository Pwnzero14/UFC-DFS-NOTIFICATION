// DraftKings Sportsbook - UFC over/under player props.
//
// Unlike the DFS books this is a real sportsbook, so the markets here are
// Over/Under lines with odds rather than pick'em fantasy points. Tracked
// markets: Significant Strikes O/U, Takedowns Landed O/U, and Round 1
// Significant Strikes O/U (which DK offers but had not posted yet when this
// was written - it is picked up automatically whenever it appears).
//
// The JSON API is behind Akamai and answers 403 to any scripted request, and
// the tab selection is not URL-addressable, so this drives headless Chrome the
// same way the Pick6 adapter does. Stealth flags are required: without them DK
// serves a stripped page with the odds grid missing entirely.

import { evaluateOnPage, findBrowser } from '../browser.js';

const URL = 'https://sportsbook.draftkings.com/leagues/mma/ufc';

// Tabs to visit. Round Props is included so Round 1 Significant Strikes is
// caught the moment DK posts it.
const TABS = ['Significant Strikes', 'Takedowns', 'Round Props'];

export const meta = {
  key: 'dksportsbook',
  name: 'DraftKings Sportsbook',
  color: 0x006f3c,
  boardUrl: URL,
  // One browser session covers every tab, but it is a heavy page - be gentle.
  minIntervalMs: 300_000,
};

const SCRIPT = `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const wait = async (fn, tries = 60) => {
    for (let i = 0; i < tries; i++) { if (fn()) return true; await sleep(300); }
    return false;
  };

  await wait(() => / vs /i.test(document.body.innerText));
  await sleep(1200);

  const tabEl = (name) => [...document.querySelectorAll('a[class*="tab-switcher-tab"]')]
    .find(e => (e.textContent || '').trim().toLowerCase() === name.toLowerCase());

  // DK lazy-loads fights as you scroll. Step down the page rather than jumping
  // to the bottom (a single jump often skips the intersection observers), and
  // only stop once the market count has been stable for several passes.
  const countMarkets = () => (document.body.innerText.match(/Total .+ O\\/U/gi) || []).length;

  const loadAll = async () => {
    let last = -1;
    let stable = 0;
    for (let i = 0; i < 60; i++) {
      window.scrollBy(0, Math.round(window.innerHeight * 0.85));
      await sleep(400);

      // Some layouts scroll an inner container rather than the window.
      const scroller = [...document.querySelectorAll('div')].find(
        (d) => d.scrollHeight > d.clientHeight + 400 && d.clientHeight > 300
      );
      if (scroller) scroller.scrollTop += Math.round(scroller.clientHeight * 0.85);

      // Expand anything hidden behind a "show more" style control.
      for (const b of document.querySelectorAll('button,a,div')) {
        const t = (b.textContent || '').trim().toLowerCase();
        if (/^(show more|see more|more fights|load more)$/.test(t)) { b.click(); await sleep(400); }
      }

      const n = countMarkets();
      const atBottom =
        window.innerHeight + window.scrollY >= document.body.scrollHeight - 80;
      stable = n === last ? stable + 1 : 0;
      last = n;
      if (stable >= 4 && atBottom) break;
    }
    window.scrollTo(0, 0);
    await sleep(400);
  };

  const parseMarkets = () => {
    const lines = document.body.innerText.split('\\n').map(s => s.trim()).filter(Boolean);
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^(.+?) Total (.+?) O\\/U$/i);
      if (!m) continue;
      const w = lines.slice(i + 1, i + 9).join(' | ');
      const over = w.match(/Over\\s+([0-9]+(?:\\.[0-9]+)?)/i);
      if (!over) continue;
      const odds = [...w.matchAll(/([+-]\\d{3,4})/g)].map(x => x[1]);
      out.push({
        fighter: m[1].trim(),
        market: m[2].trim(),
        line: Number(over[1]),
        overOdds: odds[0] || null,
        underOdds: odds[1] || null,
      });
    }
    return out;
  };

  const results = [];
  const tabsSeen = [...document.querySelectorAll('a[class*="tab-switcher-tab"]')]
    .map(e => (e.textContent || '').trim());

  // Each tab can hold several sub-filter pills - "SIGNIFICANT STRIKES O/U"
  // today, with "ROUND 1 SIGNIFICANT STRIKES O/U" expected alongside it. Only
  // the selected pill's markets are rendered, so every pill has to be clicked
  // or the others are invisible.
  const pillTexts = () => [...new Set(
    [...document.querySelectorAll('button,a,span,div')]
      .filter(e => e.children.length === 0)
      .map(e => (e.textContent || '').trim())
      .filter(t => /O\\/U$/i.test(t) && !/ Total /i.test(t) && t.length > 2 && t.length < 60)
  )];

  const clickPill = async (text) => {
    const leaf = [...document.querySelectorAll('button,a,span,div')]
      .find(e => e.children.length === 0 && (e.textContent || '').trim() === text);
    if (!leaf) return false;
    (leaf.closest('button,a,[role="button"],[role="tab"]') || leaf).click();
    await sleep(1000);
    return true;
  };

  const pillsSeen = {};

  for (const name of __TABS__) {
    const tab = tabEl(name);
    if (!tab) continue;
    tab.click();
    await sleep(900);
    await wait(() => /Total .+ O\\/U/i.test(document.body.innerText), 30);

    const pills = pillTexts();
    pillsSeen[name] = pills;

    // No pills exposed: just read whatever the tab renders.
    for (const pill of pills.length ? pills : [null]) {
      if (pill) await clickPill(pill);
      await loadAll();
      for (const mk of parseMarkets()) {
        results.push({ ...mk, tab: name, pill: pill || null });
      }
    }
  }

  return { tabsSeen, pillsSeen, markets: results };
})()`;

export async function fetchProps() {
  if (!findBrowser()) {
    throw new Error('DK Sportsbook needs a local Chrome/Edge install');
  }

  const out = await evaluateOnPage(URL, SCRIPT.replace('__TABS__', JSON.stringify(TABS)), {
    timeoutMs: 180000,
    stealth: true,
  });

  if (!out || !Array.isArray(out.markets)) {
    throw new Error('DK Sportsbook: no market data returned');
  }
  if (!out.tabsSeen?.length) {
    throw new Error('DK Sportsbook: page structure changed - no tabs found');
  }

  // De-dupe: the same market can appear under more than one tab.
  const seen = new Set();
  const props = [];

  for (const m of out.markets) {
    const key = `${m.fighter}|${m.market}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const odds =
      m.overOdds && m.underOdds
        ? `O ${m.overOdds} / U ${m.underOdds}`
        : m.overOdds || null;

    props.push({
      book: meta.key,
      id: key,
      fighter: m.fighter,
      statLabel: `${m.market} O/U`,
      statKey: m.market.toLowerCase().replace(/\s+/g, '_'),
      // Everything this book reports is a market we were asked to watch, so it
      // alerts on drops and on line moves exactly like a fantasy prop does.
      kind: 'tracked',
      value: m.line,
      status: 'open',
      event: null,
      startsAt: null,
      url: meta.boardUrl,
      odds,
    });
  }

  return props;
}
