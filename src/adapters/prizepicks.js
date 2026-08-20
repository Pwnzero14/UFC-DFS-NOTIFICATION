// PrizePicks - league_id 12 is UFC.
//
// api.prizepicks.com sits behind DataDome and returns a captcha page to
// scripted clients. partner-api.prizepicks.com serves the same JSON:API
// payload without that check, but it IS rate limited by Cloudflare
// (error 1015), so this adapter polls on a slower cadence than the others
// and the scheduler parks it on a 429.

import { getJson } from '../http.js';
import { classify } from '../fantasy.js';

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
      kind: classify(meta.key, label, a.stat_type),
      value: a.line_score == null ? null : Number(a.line_score),
      status: a.status,
      event,
      startsAt: a.start_time || null,
      url: meta.boardUrl,
    });
  }
  return props;
}
