// DraftKings Pick6 - no public JSON API; the board is server-rendered React.
//
// Two signals are pulled out of the SSR HTML for /?sport=UFC:
//   1. the stat category tabs (role="tab")  <- the real drop detector
//   2. the player cards for the selected tab (data-testid="playerStatCard")
//
// DK selects the first tab server-side and the selection is not
// URL-addressable, so the HTML only carries values for whichever category DK
// shows first. For a fantasy tab we therefore drive headless Chrome and click
// it (see below); everything else is read straight from the HTML.

import { getText } from '../http.js';
import { classify } from '../fantasy.js';
import { evaluateOnPage, findBrowser } from '../browser.js';

// DraftKings serves line values only for the tab it renders first (Significant
// Strikes). The other categories' numbers are not in the HTML, the .data
// payload, or any reachable endpoint - switching tabs is client-side state and
// is not URL-addressable. The only way to read them is to actually click.
//
// So for the markets we want - fantasy, Takedowns, Control Time - we drive the
// already-installed Chrome over the DevTools protocol, click the tab, and read
// the rendered grid. If that fails for any reason we fall back to reporting the
// market as open without values, which is strictly better than nothing and
// never breaks the poll. One browser session collects every market that needs a
// click, so Chrome is launched once per poll rather than once per market.
//
// DK posts the tabs as the card fills in - days out the board is Significant
// Strikes alone - so every one of them is optional and the trip is made for
// whichever have shown up.
//
// Control Time lives behind a sub-pill on the Time tab, and its values are
// mm:ss ("06:30") rather than plain numbers - so the reader is told which
// shape to expect per tab and the adapter converts mm:ss to seconds so moves
// can be compared.
//
// Which shape to expect is not a detail. Once a bout drops under an hour away
// DK renders a live countdown to lock inside every card for that fight, and it
// is mm:ss like a Control Time value is. A reader that just takes "the first
// mm:ss, else the first number" reads that clock as the line: on 2026-08-22 it
// turned two Fantasy Points lines into 3587 and back down a poll at a time, one
// @everyone ping every two minutes for four hours. So Fantasy reads numbers
// only, and the Control Time pass skips the clock the Fantasy pass saw.
export const BROWSER_SCRIPT = `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const tabsNow = () => [...document.querySelectorAll('[role="tab"]')];
  const selectedTab = () => {
    const t = tabsNow().find(x => x.getAttribute('aria-selected') === 'true');
    return t ? (t.textContent || '').trim() : '';
  };

  for (let i = 0; i < 60; i++) {
    if (tabsNow().length && document.querySelectorAll('[data-testid="playerStatCard"]').length) break;
    await sleep(250);
  }

  const CLOCK = /^\\d{1,2}:\\d{2}$/;
  const NUMBER = /^\\d+(\\.\\d+)?$/;
  const secs = t => Number(t.split(':')[0]) * 60 + Number(t.split(':')[1]);

  // The Fantasy tab serves plain numbers, so any mm:ss on a card there is the
  // lock countdown and nothing else. Remembering it per fighter is what lets
  // the Control Time pass tell the clock from the line.
  const countdown = {};
  // The two passes are seconds apart, so the clock will have ticked down a
  // little between them - match on proximity, not equality.
  const TICK_SLACK = 60;

  const readCards = (want) => [...document.querySelectorAll('[data-testid="playerStatCard"]')].map(c => {
    const name = c.querySelector('[data-testid="player-name"]');
    const txt = (c.innerText || '').split('\\n').map(s => s.trim()).filter(Boolean);
    const fighter = name ? name.textContent.trim() : (txt[0] || null);
    const clocks = txt.filter(t => CLOCK.test(t));
    const ticking = countdown[fighter];
    const value = want === 'clock'
      ? clocks.find(t => ticking == null || Math.abs(secs(t) - ticking) > TICK_SLACK) || null
      : txt.find(t => NUMBER.test(t)) || null;
    return {
      fighter,
      value,
      clocks,
      // Carried only when there is a clock to explain, so the diagnostic below
      // has the raw card text without every ordinary card hauling it back.
      lines: clocks.length ? txt : undefined,
      label: txt.find(t => /^(control|fight)\\s+time$/i.test(t)) || null,
      opponent: txt.find(t => /^vs /i.test(t)) || null,
    };
  });

  const clickLeaf = async (re) => {
    const leaf = [...document.querySelectorAll('button,a,div,span')]
      .find(e => e.children.length === 0 && re.test((e.textContent || '').trim()));
    if (!leaf) return false;
    (leaf.closest('button,a,[role="button"],[role="radio"],[role="tab"]') || leaf).click();
    await sleep(2200);
    return true;
  };

  // Select a tab and wait for the grid to repopulate - it empties mid-render.
  const openTab = async (re, want) => {
    const tab = tabsNow().find(t => re.test((t.textContent || '').trim()));
    if (!tab) return false;
    const before = JSON.stringify(readCards(want));
    tab.click();
    for (let i = 0; i < 60; i++) {
      await sleep(300);
      const cards = readCards(want);
      const withValues = cards.filter(c => c.value !== null).length;
      if (re.test(selectedTab()) && withValues >= 2 && JSON.stringify(cards) !== before) return true;
    }
    return re.test(selectedTab());
  };

  const out = {
    fantasy: null,
    takedowns: null,
    controlTime: null,
    tabs: tabsNow().map(t => (t.textContent || '').trim()),
  };

  // Any mm:ss on a tab that serves numbers is a clock, so every numbers pass
  // teaches the Control Time pass below what to ignore. Fantasy is not always
  // there - DK posts the tabs as the card fills in - so Takedowns doing this
  // too means the exclusion still works on a board that has no fantasy yet.
  out.countdowns = [];
  const learnCountdowns = (cards) => {
    for (const c of cards) {
      if (!c.fighter || !c.clocks.length) continue;
      // Always refresh the clock itself - a later pass is a fresher reading,
      // and the Control Time comparison is on proximity.
      const known = countdown[c.fighter] != null;
      countdown[c.fighter] = secs(c.clocks[0]);
      // Report each fighter once, though, however many numbers tabs saw them.
      if (!known) out.countdowns.push({ fighter: c.fighter, clocks: c.clocks, lines: c.lines });
    }
  };

  if (await openTab(/fantasy/i, 'number')) {
    const cards = readCards('number');
    learnCountdowns(cards);
    out.fantasy = cards.filter(c => c.fighter && c.value != null);
  }

  if (await openTab(/^takedowns$/i, 'number')) {
    const cards = readCards('number');
    learnCountdowns(cards);
    out.takedowns = cards.filter(c => c.fighter && c.value != null);
  }

  if (await openTab(/^time$/i, 'clock')) {
    // Fight Time is the default pill; Control Time needs an explicit click.
    await clickLeaf(/^control\\s+time$/i);
    const cards = readCards('clock');
    // Only accept it if the cards actually say Control Time.
    if (cards.some(c => /control/i.test(c.label || ''))) {
      out.controlTime = cards.filter(c => c.fighter && c.value != null && /control/i.test(c.label || ''));
    }
  }

  return out;
})()`;

/** "A. Wint" + "vs Chatman" -> "Chatman vs Wint", identical for both fighters. */
function matchupKey(fighter, opponent) {
  if (!fighter || !opponent) return null;
  const mine = String(fighter).replace(/^[A-Z]\.\s*/, '').trim();
  const theirs = String(opponent).replace(/^vs\s+/i, '').trim();
  if (!mine || !theirs) return null;
  return [mine, theirs].sort((a, b) => a.localeCompare(b)).join(' vs ');
}

/** "06:30" -> 390 seconds. Plain numbers pass straight through. */
function toNumber(raw) {
  const s = String(raw).trim();
  const t = s.match(/^(\d{1,2}):(\d{2})$/);
  if (t) return Number(t[1]) * 60 + Number(t[2]);
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const isTimeValue = (raw) => /^\d{1,2}:\d{2}$/.test(String(raw).trim());

// Backstop for anything the reader still picks up that cannot be a real line.
// The countdown-as-a-line bug is fixed above, but the lesson generalises: this
// adapter scrapes rendered text, so some future element will leak into a card
// eventually, and it must not be able to reach Discord. Every clicked value has
// to be physically possible for its market or it is not a value.
const MAX_VALUE = {
  // Pick6 UFC fantasy lines run roughly 25-115. 500 is far outside anything the
  // book has ever posted while still catching a clock read as a number.
  'Fantasy Points': 500,
  // Control time cannot exceed the fight: five rounds of five minutes.
  'Control Time': 25 * 60,
  // Takedown lines sit between 0.5 and about 5.5; 20 is well clear of any of
  // them and still nowhere near a stray clock or price.
  'Takedowns': 20,
};

/**
 * Convert a card value, or null it out if it is not a possible line.
 *
 * Nulled rather than dropped on purpose. A dropped card takes its prop key out
 * of the poll, and after MAX_MISSES the store forgets it - so when the market
 * recovers it reads as a brand-new prop and fires a full drop alert. Reporting
 * the prop with a null value keeps the key alive: diff() will not raise a move
 * against null in either direction, so a bad read goes quiet instead of loud,
 * and the rest of the board keeps working.
 */
export function boundedValue(statLabel, raw) {
  const n = toNumber(raw);
  if (n == null) return null;
  if (n < 0 || n > MAX_VALUE[statLabel]) {
    console.log(
      `   [pick6] ignoring impossible ${statLabel} value ${raw} (max ${MAX_VALUE[statLabel]})`
    );
    return null;
  }
  return n;
}

// Fighters whose countdown has already been recorded this run.
const dumpedCountdown = new Set();

/**
 * Record what a card actually says the first time a fighter's clock appears.
 *
 * The countdown bug had to be reconstructed backwards from Discord embeds,
 * because nothing anywhere kept what the page said - only what we made of it.
 * The reader should handle the clock now, but if a variant ever slips past it
 * again this is the evidence, captured at the moment it mattered.
 *
 * Once per fighter, so a full card costs about a dozen lines rather than one
 * every two minutes for the hour each bout spends inside its countdown.
 */
function logCountdowns(countdowns) {
  for (const c of countdowns || []) {
    if (!c.fighter || dumpedCountdown.has(c.fighter)) continue;
    dumpedCountdown.add(c.fighter);
    console.log(
      `   [pick6] lock countdown on ${c.fighter}: clocks ${JSON.stringify(c.clocks)}` +
        ` card ${JSON.stringify(c.lines)}`
    );
  }
}

async function fetchClickedMarkets({ expectFantasy }) {
  // Stealth is not optional here any more. On 2026-08-27, the day the fantasy
  // tab went up, DK put Pick6 behind the same Akamai protection the Sportsbook
  // has always needed: plain headless Chrome gets an "Access Denied" page from
  // errors.edgesuite.net, with no tabs and no cards, while the ordinary HTTP
  // fetch above still succeeds. That split is what made it look like a parsing
  // fault rather than a block.
  const out = await evaluateOnPage(URL, BROWSER_SCRIPT, {
    timeoutMs: 120000,
    stealth: true,
  });
  if (!out) throw new Error('no result from page');
  if (expectFantasy && !out.fantasy?.length) {
    // Fantasy is the market this browser trip exists for; if it did not render,
    // treat the whole trip as failed so the poll backs off rather than
    // reporting a half-board.
    //
    // Only when a fantasy tab was actually on the board, though. DK posts the
    // tabs as the card fills in - right now, days out, Pick6 has Significant
    // Strikes and nothing else - so a trip made for Takedowns alone must not
    // fail for the absence of a market that has not opened yet.
    throw new Error('fantasy tab produced no values');
  }
  logCountdowns(out.countdowns);
  return out;
}

const URL = 'https://pick6.draftkings.com/?sport=UFC';

export const meta = {
  key: 'pick6',
  name: 'DraftKings Pick6',
  color: 0x53d337,
  boardUrl: 'https://pick6.draftkings.com/?sport=UFC',
  // Reading fantasy values means launching headless Chrome (~7s), so poll a
  // little less aggressively than the pure-HTTP books.
  minIntervalMs: 120_000,
};

const TAB_RE =
  /role="tab"[^>]*aria-selected="(true|false)"[\s\S]{0,300}?>([A-Z][A-Za-z0-9 .()+\-/]{2,40})<\/div>/g;

function parseTabs(html) {
  const tabs = [];
  for (const m of html.matchAll(TAB_RE)) {
    tabs.push({ label: m[2].trim(), selected: m[1] === 'true' });
  }
  // De-dupe: DK renders a mobile and a desktop copy of the tab strip.
  const seen = new Set();
  return tabs.filter((t) => {
    const k = t.label.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function textTokens(fragment) {
  return fragment
    .replace(/<style[\s\S]*?<\/style>/g, ' ')
    .replace(/<script[\s\S]*?<\/script>/g, ' ')
    .replace(/<[^>]*>/g, '\u0001')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .split('\u0001')
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseCards(html) {
  const chunks = html.split('data-testid="playerStatCard"').slice(1);
  const cards = [];
  for (const chunk of chunks) {
    const window = chunk.slice(0, 8000);
    // Alt text on the avatar image ("Player Silhouette Icon", "Team Logo")
    // sits in the same subtree as the name, so drop icon-ish tokens.
    const tokens = textTokens(window)
      .filter((t) => t !== '>')
      .filter((t) => !/(icon|logo|silhouette|image)/i.test(t));
    if (!tokens.length) continue;

    // Prefer the explicit name node; fall back to the first text token.
    const nameNode = window.match(
      /data-testid="player-name"[^>]*>([\s\S]{0,160}?)<\/(?:div|span|p)>/
    );
    const fighter = nameNode
      ? textTokens(nameNode[1] + '<x>')[0] || tokens[0]
      : tokens[0];
    // Skip "3 Rds" style tokens, then take the first bare number as the line.
    let value = null;
    for (let i = 1; i < tokens.length; i++) {
      if (/^\d+(\.\d+)?$/.test(tokens[i])) {
        value = Number(tokens[i]);
        break;
      }
    }
    const opponent = tokens.find((t) => /^vs /i.test(t)) || null;
    cards.push({ fighter, value, opponent });
  }
  return cards;
}

export async function fetchProps() {
  const html = await getText(URL, {
    headers: { Accept: 'text/html,application/xhtml+xml', Referer: 'https://pick6.draftkings.com/' },
    timeoutMs: 35000,
  });

  const tabs = parseTabs(html);
  if (!tabs.length) {
    throw new Error('Pick6: no stat tabs found - page structure may have changed');
  }
  const selected = tabs.find((t) => t.selected)?.label || tabs[0].label;
  const cards = parseCards(html);

  const props = [];

  // One prop per player card, attributed to the selected category.
  for (const card of cards) {
    props.push({
      book: meta.key,
      id: `${selected}:${card.fighter}`,
      fighter: card.fighter,
      statLabel: selected,
      statKey: selected,
      kind: classify(meta.key, selected),
      value: card.value,
      status: 'open',
      // Same canonical matchup the clicked markets use. Built raw from the
      // fighter's own perspective, this produced a different event name for
      // each side of a bout - "J. Jenkins vs Woodson" and "S. Woodson vs
      // Jenkins" - and a third spelling again from the clicked path. One fight
      // became three events, which fragmented the embed grouping and left an
      // alert about sixteen props showing two of them.
      event: matchupKey(card.fighter, card.opponent),
      startsAt: null,
      url: meta.boardUrl,
    });
  }

  // Markets that need a click: fantasy, Takedowns, and Control Time behind the
  // Time tab. One browser trip covers all three; anything it returns is emitted
  // here, so the tab-only placeholder below is only reached for markets nobody
  // asked for.
  const hasFantasyTab = tabs.some((t) => classify(meta.key, t.label) === 'fantasy');
  const hasTakedownsTab = tabs.some((t) => /^takedowns$/i.test(t.label));
  const hasTimeTab = tabs.some((t) => /^time$/i.test(t.label));
  const clicked = { fantasy: null, takedowns: null, controlTime: null };

  if ((hasFantasyTab || hasTakedownsTab || hasTimeTab) && findBrowser()) {
    try {
      const got = await fetchClickedMarkets({ expectFantasy: hasFantasyTab });
      clicked.fantasy = got.fantasy;
      clicked.takedowns = got.takedowns;
      clicked.controlTime = got.controlTime;
    } catch (err) {
      // A transient browser failure must NOT fall through to the tab-only
      // placeholder. That placeholder is a different prop key, so it reads as
      // a brand-new fantasy prop and fires a full "PROPS ARE UP" ping - for a
      // degradation rather than a drop. Throwing instead lets the scheduler
      // back off and the stored values carry over untouched.
      throw new Error(`clicked markets unavailable: ${err.message}`);
    }
  }

  for (const card of clicked.fantasy || []) {
    props.push({
      book: meta.key,
      id: `Fantasy Points:${card.fighter}`,
      fighter: card.fighter,
      statLabel: 'Fantasy Points',
      statKey: 'Fantasy Points',
      kind: 'fantasy',
      value: boundedValue('Fantasy Points', card.value),
      status: 'open',
      // Canonical matchup so both fighters in a bout share one group,
      // rather than each becoming its own single-line embed.
      event: matchupKey(card.fighter, card.opponent),
      startsAt: null,
      url: meta.boardUrl,
    });
  }

  for (const card of clicked.takedowns || []) {
    props.push({
      book: meta.key,
      id: `Takedowns:${card.fighter}`,
      fighter: card.fighter,
      statLabel: 'Takedowns',
      statKey: 'Takedowns',
      // Asked for, so it alerts on a new line and on a move like fantasy does.
      kind: 'tracked',
      value: boundedValue('Takedowns', card.value),
      status: 'open',
      event: matchupKey(card.fighter, card.opponent),
      startsAt: null,
      url: meta.boardUrl,
    });
  }

  for (const card of clicked.controlTime || []) {
    props.push({
      book: meta.key,
      id: `Control Time:${card.fighter}`,
      fighter: card.fighter,
      statLabel: 'Control Time',
      statKey: 'Control Time',
      // Explicitly asked for, so it alerts on drops and moves like fantasy.
      // Fight Time, the other pill on that tab, is deliberately not emitted.
      kind: 'tracked',
      value: boundedValue('Control Time', card.value),
      unit: isTimeValue(card.value) ? 'time' : undefined,
      status: 'open',
      event: matchupKey(card.fighter, card.opponent),
      startsAt: null,
      url: meta.boardUrl,
    });
  }

  const handled = new Set(['fantasy points']);
  if (clicked.takedowns?.length) handled.add('takedowns');
  if (clicked.controlTime?.length) handled.add('time');

  // A tab with no readable numbers still counts as a market being offered.
  for (const tab of tabs) {
    if (tab.label === selected) continue;
    if (handled.has(tab.label.toLowerCase())) continue;

    props.push({
      book: meta.key,
      id: `tab:${tab.label}`,
      fighter: null,
      statLabel: tab.label,
      statKey: tab.label,
      kind: classify(meta.key, tab.label),
      value: null,
      status: 'tab-only',
      event: null,
      startsAt: null,
      url: meta.boardUrl,
      tabOnly: true,
      note:
        'market is OPEN on Pick6 — DraftKings only serves line values for the ' +
        'tab it selects first, so open the app to see the numbers',
    });
  }

  return props;
}
