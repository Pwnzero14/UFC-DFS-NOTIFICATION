// Underdog Fantasy - public pick'em board, no auth.
// GET /beta/v6/over_under_lines?sport_id=MMA  (~25KB gzipped)
// Chain: over_under_line -> over_under.appearance_stat -> appearance -> player
//        appearance.match_id -> solo_games (the fight)

import { getJson } from '../http.js';
import { classify, demoteToKnown } from '../fantasy.js';

const URL = 'https://api.underdogfantasy.com/beta/v6/over_under_lines?sport_id=MMA';

/**
 * Underdog truncates every one of its own title fields ("Hernandez vs Rodrig…"),
 * so rebuild the matchup from the full player names. Their fighter ordering is
 * editorial and not reliably home-first, so infer it from whichever surname the
 * (truncated) title leads with, and fall back to home-vs-away.
 */
function matchupLabel(game) {
  if (!game) return null;
  const raw = game.title || game.full_title || game.short_title || null;
  const home = game.home_player_name;
  const away = game.away_player_name;
  if (!home || !away) return raw;

  const surname = (n) => String(n).trim().split(/\s+/).pop().toLowerCase();
  const lead = String(raw || '').trim().toLowerCase();

  return lead.startsWith(surname(away))
    ? `${away} vs ${home}`
    : `${home} vs ${away}`;
}

export const meta = {
  key: 'underdog',
  name: 'Underdog',
  color: 0x000000,
  boardUrl: 'https://underdogfantasy.com/pick-em/higher-lower/all/mma',
  minIntervalMs: 60_000,
};

export async function fetchProps() {
  const data = await getJson(URL, {
    headers: { Referer: 'https://underdogfantasy.com/' },
  });

  const players = new Map((data.players || []).map((p) => [p.id, p]));
  const appearances = new Map((data.appearances || []).map((a) => [a.id, a]));
  const games = new Map((data.solo_games || []).map((g) => [String(g.id), g]));

  // Underdog sometimes posts alternate lines beside the standard one - a
  // second Significant Strikes offer for the same fighter at a different
  // number. They share everything propKey is built from, so both lines fought
  // over one key and whichever the feed listed last won it. Across polls that
  // swap read as a line move: on 2026-09-04 it reported Axel Sola's strikes
  // going 32.5 -> 89.5 and back, while his actual line never left 32.5.
  //
  // The standard offer is the balanced pick'em line - every option pays 1.0x.
  // An alternate is priced away from the middle, so its multipliers are not.
  const isStandardLine = (line) =>
    (line.options || []).every((o) => Number(o.payout_multiplier) === 1);

  // Only a line that actually competes with another for the same fighter and
  // stat can collide, so that is the only case treated as an alternate. Markets
  // that are simply multi-choice - Round of Victory, Method of Finish - price
  // each option differently and would otherwise be swept up by the rule above.
  const linesPerStat = new Map();
  for (const line of data.over_under_lines || []) {
    const s = line.over_under?.appearance_stat;
    if (!s) continue;
    const k = `${s.appearance_id}|${s.stat}`;
    linesPerStat.set(k, (linesPerStat.get(k) || 0) + 1);
  }

  const props = [];
  for (const line of data.over_under_lines || []) {
    const stat = line.over_under?.appearance_stat;
    if (!stat) continue;

    const contested = (linesPerStat.get(`${stat.appearance_id}|${stat.stat}`) || 0) > 1;
    const alternate = contested && !isStandardLine(line);

    const appearance = appearances.get(stat.appearance_id);
    if (!appearance) continue;

    const player = players.get(appearance.player_id);
    if (!player || player.sport_id !== 'MMA') continue;

    const game = games.get(String(appearance.match_id));
    const fighter = `${player.first_name || ''} ${player.last_name || ''}`.trim();

    props.push({
      book: meta.key,
      id: line.id,
      fighter,
      statLabel: stat.display_stat,
      statKey: stat.stat,
      // An alternate gets a key of its own so it can never take the standard
      // line's, and classifies known so it reports without alerting - it is a
      // different offer, not a movement of the line anyone is watching.
      variant: alternate ? `alt:${line.id}` : null,
      kind: alternate
        ? demoteToKnown(classify(meta.key, stat.display_stat, stat.stat))
        : classify(meta.key, stat.display_stat, stat.stat),
      value: line.stat_value == null ? null : Number(line.stat_value),
      status: line.status,
      event: matchupLabel(game),
      startsAt: game?.scheduled_at || null,
      url: meta.boardUrl,
    });
  }
  return props;
}
