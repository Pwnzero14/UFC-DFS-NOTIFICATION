// Betr Picks - GraphQL, no auth required for the public board.
// Two stages: list upcoming UFC events, then pull projections per event.

import { postJson } from '../http.js';
import { classify } from '../fantasy.js';

const ENDPOINT = 'https://api.fantasy.betr.app/graphql';

const EVENTS_QUERY = `query AllLeaguesUpcomingEvents {
  getUpcomingEventsV2 { id league status }
}`;

const EVENT_QUERY = `query EventInfoWithPlayers($id: String!) {
  getEventByIdV2(id: $id) {
    id name date status sport league
    ... on TeamVersusEvent {
      teams {
        id name
        players {
          id firstName lastName
          projections {
            marketId marketStatus type label name key value currentValue
          }
        }
      }
    }
  }
}`;

export const meta = {
  key: 'betr',
  name: 'Betr',
  color: 0xff6b00,
  boardUrl: 'https://picks.betr.app/',
  minIntervalMs: 90_000,
};

const gqlHeaders = {
  Origin: 'https://picks.betr.app',
  Referer: 'https://picks.betr.app/',
};

async function gql(query, variables = {}) {
  const body = await postJson(
    ENDPOINT,
    { query, variables },
    { headers: gqlHeaders }
  );
  if (body.errors?.length) {
    throw new Error(`Betr GraphQL: ${body.errors[0]?.message || 'unknown error'}`);
  }
  return body.data;
}

export async function fetchProps() {
  const list = await gql(EVENTS_QUERY);
  const ufcEvents = (list.getUpcomingEventsV2 || []).filter(
    (e) => e.league === 'UFC' && e.status !== 'FINISHED'
  );

  const props = [];
  // Sequential on purpose: keeps the request rate polite.
  for (const ev of ufcEvents) {
    let detail;
    try {
      detail = await gql(EVENT_QUERY, { id: ev.id });
    } catch {
      continue; // one bad event shouldn't sink the whole poll
    }
    const event = detail.getEventByIdV2;
    if (!event) continue;

    for (const team of event.teams || []) {
      for (const player of team.players || []) {
        const fighter = `${player.firstName || ''} ${player.lastName || ''}`.trim();
        for (const pr of player.projections || []) {
          const label = pr.label || pr.name || pr.key;
          const value = pr.value ?? pr.currentValue;
          props.push({
            book: meta.key,
            id: pr.marketId || `${event.id}:${player.id}:${pr.key}`,
            fighter,
            statLabel: label,
            statKey: pr.key,
            kind: classify(meta.key, label, pr.name, pr.key),
            value: value == null ? null : Number(value),
            status: pr.marketStatus,
            event: event.name || null,
            startsAt: event.date || null,
            url: meta.boardUrl,
          });
        }
      }
    }
  }
  return props;
}
