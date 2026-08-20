// DraftKings Pick6 - no public JSON API; the board is server-rendered React.
//
// Two signals are pulled out of the SSR HTML for /?sport=UFC:
//   1. the stat category tabs (role="tab")  <- the real drop detector
//   2. the player cards for the selected tab (data-testid="playerStatCard")
//
// Caveat: DK selects the first tab server-side and the selection is not
// URL-addressable, so line VALUES are only readable for whichever category
// DK shows first. Tab presence is still detected for every category, so a
// "Fantasy Points" tab appearing always fires an alert even if its numbers
// can't be read on that same poll.

import { getText } from '../http.js';
import { classify } from '../fantasy.js';

const URL = 'https://pick6.draftkings.com/?sport=UFC';

export const meta = {
  key: 'pick6',
  name: 'DraftKings Pick6',
  color: 0x53d337,
  boardUrl: 'https://pick6.draftkings.com/?sport=UFC',
  minIntervalMs: 90_000,
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
    });
  }

  return props;
}
