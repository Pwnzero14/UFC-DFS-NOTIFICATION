// Underdog Fantasy - public pick'em board, no auth.
// GET /beta/v6/over_under_lines?sport_id=MMA  (~25KB gzipped)
// Chain: over_under_line -> over_under.appearance_stat -> appearance -> player
//        appearance.match_id -> solo_games (the fight)

import { getJson } from '../http.js';
import { classify } from '../fantasy.js';

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

  const props = [];
  for (const line of data.over_under_lines || []) {
    const stat = line.over_under?.appearance_stat;
    if (!stat) continue;

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
      kind: classify(meta.key, stat.display_stat, stat.stat),
      value: line.stat_value == null ? null : Number(line.stat_value),
      status: line.status,
      event: matchupLabel(game),
      startsAt: game?.scheduled_at || null,
      url: meta.boardUrl,
    });
  }
  return props;
}
