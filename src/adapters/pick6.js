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
// So when a fantasy tab is present we drive the already-installed Chrome over
// the DevTools protocol, click that tab, and read the rendered grid. If that
// fails for any reason we fall back to reporting the market as open without
// values, which is strictly better than nothing and never breaks the poll.
// One browser session collects every market that needs a click, so Chrome is
// launched once per poll rather than once per market.
//
// Control Time lives behind a sub-pill on the Time tab, and its values are
// mm:ss ("06:30") rather than plain numbers - the card reader accepts both and
// the adapter converts to seconds so moves can be compared.
const BROWSER_SCRIPT = `(async () => {
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

  const readCards = () => [...document.querySelectorAll('[data-testid="playerStatCard"]')].map(c => {
    const name = c.querySelector('[data-testid="player-name"]');
    const txt = (c.innerText || '').split('\\n').map(s => s.trim()).filter(Boolean);
    // mm:ss first (Control Time), otherwise the first bare number.
    const value = txt.find(t => /^\\d{1,2}:\\d{2}$/.test(t))
               || txt.find(t => /^\\d+(\\.\\d+)?$/.test(t))
               || null;
    return {
      fighter: name ? name.textContent.trim() : (txt[0] || null),
      value,
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
  const openTab = async (re) => {
    const tab = tabsNow().find(t => re.test((t.textContent || '').trim()));
    if (!tab) return false;
    const before = JSON.stringify(readCards());
    tab.click();
    for (let i = 0; i < 60; i++) {
      await sleep(300);
      const cards = readCards();
      const withValues = cards.filter(c => c.value !== null).length;
      if (re.test(selectedTab()) && withValues >= 2 && JSON.stringify(cards) !== before) return true;
    }
    return re.test(selectedTab());
  };

  const out = { fantasy: null, controlTime: null, tabs: tabsNow().map(t => (t.textContent || '').trim()) };

  if (await openTab(/fantasy/i)) {
    out.fantasy = readCards().filter(c => c.fighter && c.value != null);
  }

  if (await openTab(/^time$/i)) {
    // Fight Time is the default pill; Control Time needs an explicit click.
    await clickLeaf(/^control\\s+time$/i);
    const cards = readCards();
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

async function fetchClickedMarkets() {
  const out = await evaluateOnPage(URL, BROWSER_SCRIPT, { timeoutMs: 120000 });
  if (!out) throw new Error('no result from page');
  if (!out.fantasy?.length) {
    // Fantasy is the market this browser trip exists for; if it did not render,
    // treat the whole trip as failed so the poll backs off rather than
    // reporting a half-board.
    throw new Error('fantasy tab produced no values');
  }
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
      event: card.opponent ? `${card.fighter} ${card.opponent}` : null,
      startsAt: null,
      url: meta.boardUrl,
    });
  }

  // Markets that need a click: fantasy, and Control Time behind the Time tab.
  // One browser trip covers both; anything it returns is emitted here, so the
  // tab-only placeholder below is only reached for markets nobody asked for.
  const hasFantasyTab = tabs.some((t) => classify(meta.key, t.label) === 'fantasy');
  const hasTimeTab = tabs.some((t) => /^time$/i.test(t.label));
  const clicked = { fantasy: null, controlTime: null };

  if ((hasFantasyTab || hasTimeTab) && findBrowser()) {
    try {
      const got = await fetchClickedMarkets();
      clicked.fantasy = got.fantasy;
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
      value: toNumber(card.value),
      status: 'open',
      // Canonical matchup so both fighters in a bout share one group,
      // rather than each becoming its own single-line embed.
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
      value: toNumber(card.value),
      unit: isTimeValue(card.value) ? 'time' : undefined,
      status: 'open',
      event: matchupKey(card.fighter, card.opponent),
      startsAt: null,
      url: meta.boardUrl,
    });
  }

  const handled = new Set(['fantasy points']);
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
