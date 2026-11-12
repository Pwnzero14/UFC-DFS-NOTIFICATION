// Turning one poll's diff into the alerts that get posted.
//
// The one rule worth stating: an alert covers exactly one market family. Every
// watched market used to share a bucket with fantasy, which left the headline
// naming whichever family it noticed first - a takedown line genuinely posted
// as "UFC FANTASY PROPS ARE UP", and a sig strikes move as "fantasy line
// moves". Splitting here is what lets buildDiscordPayload name a batch
// honestly instead of guessing at it.

import { ALERTING_KINDS, propKey, priceAnchor } from './state.js';
import { marketKey } from './fantasy.js';

/**
 * How far a line must move before it is worth saying so, for this prop.
 *
 * One global threshold could not serve five books at once. Fantasy points move
 * in ones and every move matters; significant strikes wander half a point
 * constantly across four books now; control time is stored in seconds, so any
 * number tuned for a fantasy line is meaningless against it. Thresholds are
 * read per market, in that market's own units, and fall back to the global
 * lineMoveMinDelta for anything unlisted.
 */
export function moveThreshold(prop, cfg) {
  const perMarket = cfg.lineMoveThresholds || {};
  const key = marketKey(prop.statLabel, prop.statKey);
  const specific = perMarket[key];
  const value = Number(specific ?? cfg.lineMoveMinDelta);
  return Number.isFinite(value) ? value : 0;
}

/** American odds -> implied win probability, 0..1. */
export function impliedProb(odds) {
  const o = Number(odds);
  if (!Number.isFinite(o) || o === 0) return null;
  return o < 0 ? -o / (-o + 100) : 100 / (o + 100);
}

/**
 * Favorite tiers. A move across one is news ("slight favorite is now a big
 * favorite") even when the raw number moved less than the probability
 * threshold.
 */
export function oddsTier(odds) {
  const o = Number(odds);
  if (o > 0) return o >= 250 ? 'big underdog' : o >= 150 ? 'underdog' : 'slight underdog';
  if (o <= -500) return 'huge favorite';
  if (o <= -250) return 'big favorite';
  if (o <= -150) return 'favorite';
  return 'slight favorite';
}

/**
 * Whether a price swing is worth a ping, and what to call it. Null when not.
 *
 * Three ways in:
 *   - a flip: favorite became underdog or the other way round
 *   - a tier change: slight favorite -> favorite -> big -> huge
 *   - a raw swing in implied probability of oddsMoveMinPct points or more
 * Flips and tier changes still need a couple of points of real movement, so a
 * price wobbling across a boundary (-148 / -152, -105 / +105) cannot ping on
 * every tick.
 */
export function oddsMoveIsMajor(from, to, cfg = {}) {
  const p0 = impliedProb(from);
  const p1 = impliedProb(to);
  if (p0 == null || p1 == null) return null;
  const swing = Math.abs(p1 - p0) * 100;
  const minPct = Number(cfg.oddsMoveMinPct ?? 10);

  const wasFav = Number(from) < 0;
  const isFav = Number(to) < 0;
  if (wasFav !== isFav && swing >= 2) {
    return isFav ? 'flipped to FAVORITE' : 'flipped to UNDERDOG';
  }
  const t0 = oddsTier(from);
  const t1 = oddsTier(to);
  if (t0 !== t1 && swing >= 4) return `${t0} → ${t1}`;
  if (swing >= minPct) return `${swing.toFixed(1)} pt swing`;
  return null;
}

/** Largest implied-probability move across the over and under, in points. */
export function priceSwingPct(p) {
  let best = 0;
  for (const [from, to] of [
    [p.previousOverOdds, p.overOdds],
    [p.previousUnderOdds, p.underOdds],
  ]) {
    const a = impliedProb(from);
    const b = impliedProb(to);
    if (a != null && b != null) best = Math.max(best, Math.abs(b - a) * 100);
  }
  return best;
}

/** Fantasy first, then everything else we watch. Never mixed. */
function byFamily(props) {
  return [
    props.filter((p) => p.kind === 'fantasy'),
    props.filter((p) => p.kind !== 'fantasy'),
  ];
}

export function buildAlerts(adapter, result, cfg, firstRun) {
  const alerts = [];
  const push = (kind, props) => {
    if (props.length) alerts.push({ kind, bookMeta: adapter.meta, props });
  };

  if (firstRun && !cfg.alertOnFirstRun) return alerts;

  // A selection inside a market (FanDuel reports both) is only news on its own
  // when the market was already up. When the whole market is new, the market's
  // own line already announces it, and listing its 30 selections beside it
  // would bury the one line that matters.
  const newKeys = new Set(result.newProps.map(propKey));
  const announced = (p) => p.parentKey && newKeys.has(p.parentKey);

  if (cfg.alertOnFantasy) {
    const opened = result.newProps.filter((p) => ALERTING_KINDS.has(p.kind) && !announced(p));
    const [fantasy, tracked] = byFamily(opened);
    push('fantasy', fantasy);
    // Still a market opening, and still worth the mention - it just gets
    // called by its own name rather than borrowing fantasy's.
    push('tracked', tracked);
  }
  if (cfg.alertOnUnknownStat) {
    push('unknown', result.newProps.filter((p) => p.kind === 'unknown'));
  }
  // A book can opt in to line moves on its own (fanduel.alertOnLineMove), so
  // sportsbook totals can move-alert while the DFS books stay quiet.
  const bookCfg = cfg[adapter.meta.key] || {};
  if (cfg.alertOnLineMove || bookCfg.alertOnLineMove === true) {
    // A threshold of 0 means "tell me about any move at all".
    const moved = result.moved.filter(
      (p) =>
        p.unit !== 'odds' &&
        Math.abs(Number(p.value) - Number(p.previousValue)) >= moveThreshold(p, cfg)
    );
    for (const family of byFamily(moved)) push('move', family);
  }

  if (bookCfg.alertOnOddsMove !== false) {
    const swings = [];
    for (const p of result.moved) {
      if (p.unit !== 'odds') continue;
      const why = oddsMoveIsMajor(p.previousValue, p.value, bookCfg);
      if (!why) continue;
      swings.push({ ...p, swing: why });
      // Reported: this price is the new anchor. If delivery fails the caller
      // rewinds the whole entry, anchor included, so the swing is re-sent.
      const entry = result.fresh?.[propKey(p)];
      if (entry) entry.anchor = p.value;
    }
    push('odds', swings);
  }

  // Over/under prices moving on a line that stayed put (DK Takedowns Landed
  // Over 1.5 going +120 -> +110). Every price change reports by default;
  // <book>.oddsChangeMinPct sets how many points of implied probability either
  // side must move first, if that turns out too chatty.
  if (bookCfg.alertOnOddsChange !== false && result.repriced?.length) {
    const minPct = Number(bookCfg.oddsChangeMinPct ?? 0);
    const changed = [];
    for (const p of result.repriced) {
      if (priceSwingPct(p) < minPct) continue;
      changed.push(p);
      // Reported: these prices become the new anchor. A failed send rewinds
      // the entry, so the change is re-detected and re-sent next poll.
      const entry = result.fresh?.[propKey(p)];
      if (entry) entry.odds = priceAnchor(p);
    }
    push('price', changed);
  }
  return alerts;
}
