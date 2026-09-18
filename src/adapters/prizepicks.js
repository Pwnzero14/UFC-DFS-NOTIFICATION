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

  // How many offers PrizePicks posts for each fighter+stat. An alternate
  // (demon/goblin) line is tracked ONLY when it is the whole market for its
  // fighter+stat - a single line with nothing to collide with. That covers the
  // alt-only markets worth alerting on (knockdowns, always a lone 0.5) without
  // reintroducing the collision the silencing exists to prevent: PrizePicks also
  // posts alt LADDERS - several demon/goblin lines at once (takedowns at
  // 0.5/2.5/3.5/4.5) - that all share one variant (odds_type + game_id) and so
  // land on one propKey. Tracked, each poll a different rung wins the key and
  // reads as a fake line move (Doo Ho Choi "1.5 -> 4.5", "1.5 -> 3.5", ... every
  // poll, 2026-09-18). So a fighter+stat with more than one offer keeps only its
  // standard line tracked (if any); every alternate there stays known and quiet.
  const offerCount = new Map();
  for (const proj of data.data || []) {
    const pid = proj.relationships?.new_player?.data?.id || '';
    const gk = `${pid}|${proj.attributes?.stat_type}`;
    offerCount.set(gk, (offerCount.get(gk) || 0) + 1);
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

    // A standard line is always tracked. An alternate is tracked only when it is
    // the lone offer for its fighter+stat - otherwise (a standard sibling to
    // prefer, or a ladder of alt lines that would collide) it stays known.
    const alternate = isAlternate(a.odds_type);
    const soleOffer = offerCount.get(`${playerId || ''}|${a.stat_type}`) === 1;
    const trackable = !alternate || soleOffer;
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
      kind: trackable ? baseKind : demoteToKnown(baseKind),
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
