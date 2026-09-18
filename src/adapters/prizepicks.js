// PrizePicks - league_id 12 is UFC.
//
// api.prizepicks.com sits behind DataDome and returns a captcha page to
// scripted clients. partner-api.prizepicks.com serves the same JSON:API
// payload without that check, but it IS rate limited by Cloudflare
// (error 1015), so this adapter polls on a slower cadence than the others
// and the scheduler parks it on a 429.

import { getJson } from '../http.js';
import { classify, demoteToKnown } from '../fantasy.js';

/** Anything that is not the plain pick'em line: demon, goblin, and whatever
 *  PrizePicks names next. Absent odds_type means the standard offer. */
export const isAlternate = (oddsType) =>
  !!oddsType && !/^standard$/i.test(String(oddsType).trim());

const UFC_LEAGUE_ID = '12';
const URL = `https://partner-api.prizepicks.com/projections?league_id=${UFC_LEAGUE_ID}`;

export const meta = {
  key: 'prizepicks',
  name: 'PrizePicks',
  color: 0x8a2be2,
  boardUrl: 'https://app.prizepicks.com/board',
  minIntervalMs: 300_000, // 5 min - Cloudflare rate limits this host
};

/**
 * Build props from the JSON:API payload. Pure, so the demon/goblin rule below
 * can be tested against fixture boards.
 */
export function normalizeBoard(data) {
  const included = new Map(
    (data.included || []).map((i) => [`${i.type}:${i.id}`, i])
  );

  // A demon/goblin line is an ALTERNATE to a standard pick'em offer, so it is
  // only silenced when that standard offer is actually on the board for the
  // same fighter+stat - otherwise there is nothing to prefer it over. When
  // PrizePicks posts a market ONLY as demon/goblin - knockdowns are routinely
  // alt-only, every card - the alt IS the market, and silencing it means the
  // market pings for nobody. So first record which fighter+stat pairs have a
  // standard offer; an alternate is demoted only when its pair is in that set.
  const standardOffers = new Set();
  for (const proj of data.data || []) {
    const a = proj.attributes || {};
    if (isAlternate(a.odds_type)) continue;
    const pid = proj.relationships?.new_player?.data?.id || '';
    standardOffers.add(`${pid}|${a.stat_type}`);
  }

  const props = [];
  for (const proj of data.data || []) {
    const a = proj.attributes || {};
    const rel = proj.relationships || {};
    if (rel.league?.data?.id && rel.league.data.id !== UFC_LEAGUE_ID) continue;

    const playerId = rel.new_player?.data?.id;
    const player = playerId ? included.get(`new_player:${playerId}`) : null;
    const label = a.stat_display_name || a.stat_type;

    const fighter = player?.attributes?.display_name || a.description || 'Unknown';
    // a.description holds the opponent, so build a readable matchup label.
    const event =
      a.description && a.description !== fighter
        ? `${fighter} vs ${a.description}`
        : fighter;

    // Demon and goblin are alternate lines on the same stat, priced away from
    // the middle. When a standard offer for the same fighter+stat exists, that
    // pick'em line is the only one worth alerting on - tracking all three means
    // one fighter's strikes line is three props that move independently, on the
    // book with the largest board of the five. The alternates then still report
    // (visible and countable) but classify known and keep quiet. But when no
    // standard exists, the alternate is the whole market and is tracked so it
    // still pings. Fantasy is deliberately exempt from demotion either way.
    const alternate = isAlternate(a.odds_type);
    const hasStandard = standardOffers.has(`${playerId || ''}|${a.stat_type}`);
    const baseKind = classify(meta.key, label, a.stat_type);

    props.push({
      book: meta.key,
      id: proj.id,
      fighter,
      statLabel: label,
      statKey: a.stat_type,
      // demon/goblin are separate offers on the same stat; game_id keeps
      // re-posted boards for the same matchup apart.
      variant: [a.odds_type, a.game_id].filter(Boolean).join(':') || null,
      kind: alternate && hasStandard ? demoteToKnown(baseKind) : baseKind,
      value: a.line_score == null ? null : Number(a.line_score),
      status: a.status,
      event,
      startsAt: a.start_time || null,
      url: meta.boardUrl,
    });
  }
  return props;
}

export async function fetchProps() {
  const data = await getJson(URL, {
    headers: {
      Origin: 'https://app.prizepicks.com',
      Referer: 'https://app.prizepicks.com/',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-site',
    },
  });
  return normalizeBoard(data);
}
