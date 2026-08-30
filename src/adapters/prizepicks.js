// PrizePicks - league_id 12 is UFC.
//
// api.prizepicks.com sits behind DataDome and returns a captcha page to
// scripted clients. partner-api.prizepicks.com serves the same JSON:API
// payload without that check, but it IS rate limited by Cloudflare
// (error 1015), so this adapter polls on a slower cadence than the others
// and the scheduler parks it on a 429.

import { getJson } from '../http.js';
import { classify } from '../fantasy.js';

/** Anything that is not the plain pick'em line: demon, goblin, and whatever
 *  PrizePicks names next. Absent odds_type means the standard offer. */
export const isAlternate = (oddsType) =>
  !!oddsType && !/^standard$/i.test(String(oddsType).trim());

/** Quiet an alternate line without hiding it. Fantasy is left alone so a drop
 *  can never be missed on a variant technicality; only watched markets and
 *  never-seen stats are silenced, and 'known' is already the quiet kind. */
export const demoteToKnown = (kind) => (kind === 'fantasy' ? kind : 'known');

const UFC_LEAGUE_ID = '12';
const URL = `https://partner-api.prizepicks.com/projections?league_id=${UFC_LEAGUE_ID}`;

export const meta = {
  key: 'prizepicks',
  name: 'PrizePicks',
  color: 0x8a2be2,
  boardUrl: 'https://app.prizepicks.com/board',
  minIntervalMs: 300_000, // 5 min - Cloudflare rate limits this host
};

export async function fetchProps() {
  const data = await getJson(URL, {
    headers: {
      Origin: 'https://app.prizepicks.com',
      Referer: 'https://app.prizepicks.com/',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-site',
    },
  });

  const included = new Map(
    (data.included || []).map((i) => [`${i.type}:${i.id}`, i])
  );

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

    props.push({
      book: meta.key,
      id: proj.id,
      fighter,
      statLabel: label,
      statKey: a.stat_type,
      // demon/goblin are separate offers on the same stat; game_id keeps
      // re-posted boards for the same matchup apart.
      variant: [a.odds_type, a.game_id].filter(Boolean).join(':') || null,
      // Demon and goblin are alternate lines on the same stat, priced away
      // from the middle. The standard offer is the pick'em-value line and the
      // only one worth alerting on: tracking all three means one fighter's
      // strikes line is three props that move independently, on the book with
      // the largest board of the five. The alternates are still reported, so
      // they stay visible and countable - they just classify known and keep
      // quiet. Fantasy is deliberately exempt: the drop is the alert this all
      // exists for, and it is not worth risking on a variant assumption.
      kind: isAlternate(a.odds_type)
        ? demoteToKnown(classify(meta.key, label, a.stat_type))
        : classify(meta.key, label, a.stat_type),
      value: a.line_score == null ? null : Number(a.line_score),
      status: a.status,
      event,
      startsAt: a.start_time || null,
      url: meta.boardUrl,
    });
  }
  return props;
}
