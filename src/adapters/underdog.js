// Underdog Fantasy - public pick'em board, no auth.
// GET /beta/v6/over_under_lines?sport_id=MMA  (~25KB gzipped)
// Chain: over_under_line -> over_under.appearance_stat -> appearance -> player
//        appearance.match_id -> solo_games (the fight)

import { readFile, stat as statFile } from 'node:fs/promises';
import { getJson } from '../http.js';
import { classify, demoteToKnown } from '../fantasy.js';
import { loadConfig } from '../config.js';

// The /beta/v6 endpoint started answering 426 upgrade_required on 2026-09-10 -
// a client-version wall a background caller cannot satisfy. The older /v1
// endpoint still serves the same over_under_lines structure, unauthenticated,
// and takes the same sport_id filter. Found by reading which endpoint the UFC
// analyzer extension uses; /v6 was simply retired out from under us.
const URL = 'https://api.underdogfantasy.com/v1/over_under_lines?sport_id=MMA';

// Underdog's API started answering 426 upgrade_required on 2026-09-10, and
// unlike Betr there is no header that gets a background caller past it - the
// real app satisfies a version check the watcher cannot reproduce. So the board
// comes from a file the UFC analyzer extension writes: the analyzer runs inside
// the logged-in browser, intercepts the page's own over_under_lines fetch, and
// dumps the parsed fighters. betr.boardFile does the same for Betr; this is the
// underdog.boardFile equivalent, reading the analyzer's fighter shape
// ({ name, line_fp, line_ss, line_td, opponent }) rather than the raw API.
const BOARD_FILE_MAX_AGE_MS = 30 * 60_000;

/** "Silva" + "Delgado" -> "Delgado vs Silva", identical for both fighters. */
function matchupFromNames(name, opponent) {
  const surname = (n) => String(n || '').trim().split(/\s+/).pop();
  const a = surname(name);
  const b = surname(opponent);
  if (!a || !b) return name || null;
  return [a, b].sort((x, y) => x.localeCompare(y)).join(' vs ');
}

/** Build props from the analyzer's fighter array. One prop per line present. */
function propsFromAnalyzerFighters(fighters) {
  const props = [];
  const emit = (fighter, statLabel, statKey, value, opponent) => {
    if (value == null) return;
    props.push({
      book: meta.key,
      id: `${statKey}:${fighter}`,
      fighter,
      statLabel,
      statKey,
      kind: classify(meta.key, statLabel, statKey),
      value: Number(value),
      status: 'open',
      event: matchupFromNames(fighter, opponent),
      startsAt: null,
      url: meta.boardUrl,
    });
  };
  for (const f of fighters || []) {
    if (!f?.name) continue;
    emit(f.name, 'Fantasy Points', 'fantasy_points', f.line_fp, f.opponent);
    emit(f.name, 'Significant Strikes', 'significant_strikes', f.line_ss, f.opponent);
    emit(f.name, 'Takedowns', 'takedowns', f.line_td, f.opponent);
  }
  return props;
}

/** Accept the analyzer's shapes: { fighters: [...] } or a bare fighter array. */
export function normalizeUnderdogBoard(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && Array.isArray(raw.fighters)) return raw.fighters;
  throw new Error('Underdog board file has no fighters array');
}

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
  const cfg = await loadConfig().catch(() => ({}));
  const boardFile = String(cfg.underdog?.boardFile || '').trim();

  if (boardFile) {
    let st;
    try {
      st = await statFile(boardFile);
    } catch {
      throw new Error(`Underdog board file not found: ${boardFile} - run the analyzer's AUTO-FETCH`);
    }
    const ageMs = Date.now() - st.mtimeMs;
    if (ageMs > BOARD_FILE_MAX_AGE_MS) {
      throw new Error(
        `Underdog board file is stale (${Math.round(ageMs / 60000)}m old) - the analyzer has not fetched recently`
      );
    }
    const raw = JSON.parse((await readFile(boardFile, 'utf8')).replace(/^﻿/, ''));
    return propsFromAnalyzerFighters(normalizeUnderdogBoard(raw));
  }

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
