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
const FANTASY_TAB_SCRIPT = `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const tabsNow = () => [...document.querySelectorAll('[role="tab"]')];

  for (let i = 0; i < 60; i++) {
    if (tabsNow().length && document.querySelectorAll('[data-testid="playerStatCard"]').length) break;
    await sleep(250);
  }

  const target = tabsNow().find(t => /fantasy/i.test(t.textContent || ''));
  if (!target) return { error: 'no fantasy tab' };

  const readCards = () => [...document.querySelectorAll('[data-testid="playerStatCard"]')].map(c => {
    const name = c.querySelector('[data-testid="player-name"]');
    const txt = (c.innerText || '').split('\\n').map(s => s.trim()).filter(Boolean);
    const num = txt.find(t => /^\\d+(\\.\\d+)?$/.test(t)) || null;
    const opp = txt.find(t => /^vs /i.test(t)) || null;
    return { fighter: name ? name.textContent.trim() : (txt[0] || null), value: num, opponent: opp };
  });

  const before = JSON.stringify(readCards());
  target.click();

  // The grid empties while it re-renders - wait for it to come back populated.
  let cards = [];
  for (let i = 0; i < 60; i++) {
    await sleep(300);
    const sel = tabsNow().find(t => t.getAttribute('aria-selected') === 'true');
    const selName = sel ? (sel.textContent || '').trim() : '';
    cards = readCards();
    const withValues = cards.filter(c => c.value !== null).length;
    if (/fantasy/i.test(selName) && withValues >= 2 && JSON.stringify(cards) !== before) break;
  }

  const sel = tabsNow().find(t => t.getAttribute('aria-selected') === 'true');
  return { selected: sel ? (sel.textContent || '').trim() : null, cards };
})()`;

/** "A. Wint" + "vs Chatman" -> "Chatman vs Wint", identical for both fighters. */
function matchupKey(fighter, opponent) {
  if (!fighter || !opponent) return null;
  const mine = String(fighter).replace(/^[A-Z]\.\s*/, '').trim();
  const theirs = String(opponent).replace(/^vs\s+/i, '').trim();
  if (!mine || !theirs) return null;
  return [mine, theirs].sort((a, b) => a.localeCompare(b)).join(' vs ');
}

async function fetchFantasyViaBrowser() {
  const out = await evaluateOnPage(URL, FANTASY_TAB_SCRIPT, { timeoutMs: 90000 });
  if (!out || out.error) throw new Error(out?.error || 'no result from page');
  if (!/fantasy/i.test(out.selected || '')) {
    throw new Error(`fantasy tab did not become selected (got "${out.selected}")`);
  }
  const cards = (out.cards || []).filter((c) => c.fighter && c.value != null);
  if (!cards.length) throw new Error('fantasy tab selected but no values rendered');
  return cards;
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

  // A tab with no readable numbers still counts as a market being offered.
  for (const tab of tabs) {
    if (tab.label === selected) continue;

    // For a fantasy tab, go get the real numbers rather than just flagging it.
    if (classify(meta.key, tab.label) === 'fantasy' && findBrowser()) {
      try {
        const cards = await fetchFantasyViaBrowser();
        for (const card of cards) {
          props.push({
            book: meta.key,
            id: `${tab.label}:${card.fighter}`,
            fighter: card.fighter,
            statLabel: tab.label,
            statKey: tab.label,
            kind: 'fantasy',
            value: Number(card.value),
            status: 'open',
            // Canonical matchup so both fighters in a bout share one group,
            // rather than each becoming its own single-line embed.
            event: matchupKey(card.fighter, card.opponent),
            startsAt: null,
            url: meta.boardUrl,
          });
        }
        continue; // got real values; no need for the placeholder
      } catch (err) {
        // A transient browser failure must NOT fall through to the tab-only
        // placeholder. That placeholder is a different prop key, so it reads as
        // a brand-new fantasy prop and fires a full "PROPS ARE UP" ping - for a
        // degradation rather than a drop. Throwing instead lets the scheduler
        // back off and the stored values carry over untouched, which is what
        // actually happened: one failed Chrome start, one false alarm.
        throw new Error(`fantasy values unavailable: ${err.message}`);
      }
    }

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
