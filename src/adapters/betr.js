// Betr Picks - GraphQL, no auth required for the public board.
// Two stages: list upcoming UFC events, then pull projections per event.

import { postJson } from '../http.js';
import { classify } from '../fantasy.js';

const ENDPOINT = 'https://api.fantasy.betr.app/graphql';

// One request for the whole league, players and projections included.
//
// This previously listed every league's events and then queried each UFC event
// individually - 14 requests per poll. That was both wasteful (Betr started
// answering 401, plausibly because of the volume) and fragile: a single failed
// event query silently produced a partial board, which wiped those props from
// state and turned later line moves into phantom "new prop" alerts.
const LEAGUE_QUERY = `query LeagueUpcomingEvents($league: League!) {
  getUpcomingEventsV2(league: $league) {
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
  // One request per poll now, but Betr started answering 401 after heavy
  // polling, so stay deliberately light-touch here.
  minIntervalMs: 180_000,
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
  const data = await gql(LEAGUE_QUERY, { league: 'UFC' });
  const events = (data.getUpcomingEventsV2 || []).filter(
    (e) => e.status !== 'FINISHED'
  );

  const props = [];
  for (const event of events) {
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
