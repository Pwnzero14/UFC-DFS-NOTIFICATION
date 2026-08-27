// Turning one poll's diff into the alerts that get posted.
//
// The one rule worth stating: an alert covers exactly one market family. Every
// watched market used to share a bucket with fantasy, which left the headline
// naming whichever family it noticed first - a takedown line genuinely posted
// as "UFC FANTASY PROPS ARE UP", and a sig strikes move as "fantasy line
// moves". Splitting here is what lets buildDiscordPayload name a batch
// honestly instead of guessing at it.

import { ALERTING_KINDS } from './state.js';

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

  if (cfg.alertOnFantasy) {
    const opened = result.newProps.filter((p) => ALERTING_KINDS.has(p.kind));
    const [fantasy, tracked] = byFamily(opened);
    push('fantasy', fantasy);
    // Still a market opening, and still worth the mention - it just gets
    // called by its own name rather than borrowing fantasy's.
    push('tracked', tracked);
  }
  if (cfg.alertOnUnknownStat) {
    push('unknown', result.newProps.filter((p) => p.kind === 'unknown'));
  }
  if (cfg.alertOnLineMove) {
    // A threshold of 0 means "tell me about any move at all".
    const min = Number(cfg.lineMoveMinDelta) || 0;
    const moved = result.moved.filter(
      (p) => Math.abs(Number(p.value) - Number(p.previousValue)) >= min
    );
    for (const family of byFamily(moved)) push('move', family);
  }
  return alerts;
}
