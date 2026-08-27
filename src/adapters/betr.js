// Betr Picks - GraphQL, no auth required for the public board.
// Two stages: list upcoming UFC events, then pull projections per event.

import { postJson } from '../http.js';
import { classify } from '../fantasy.js';

const ENDPOINT = 'https://api.fantasy.betr.app/graphql';

// One request for the whole league, players and projections included.
//
// This previously listed every league's events and then queried each UFC event
// individually - 14 requests per poll. That was wasteful, and fragile too: a
// single failed event query silently produced a partial board, which wiped
// those props from state and turned later line moves into phantom "new prop"
// alerts. (An older comment here blamed that volume for Betr's 401s in August
// 2026. That was a guess and it was wrong - the one-request rewrite landed
// three hours after the 401s began and five days at ~28x less load never
// recovered. It was an outage on their side, and it reverted on its own.)
//
// Every field here is one the adapter actually reads, and that is a
// correctness requirement rather than tidiness. Betr declares much of its
// schema non-null, so when one of their records has a null in it the null
// bubbles up and takes the whole response with it - `data` comes back null and
// the poll gets nothing. On 2026-08-27, twenty minutes after the UFC fantasy
// lines dropped, one event had a team with a null id and killed the board for
// three hours. We never used team id or name. Asking for a field you do not
// read is a liability, not a free extra.
const LEAGUE_QUERY = `query LeagueUpcomingEvents($league: League!) {
  getUpcomingEventsV2(league: $league) {
    id name date status
    ... on TeamVersusEvent {
      teams {
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
  // GraphQL can report errors and still return usable data - one bad record in
  // a nullable position nulls that record, not the response. Throwing on the
  // mere presence of `errors` threw away boards we could have read. Only a
  // genuinely empty `data` is a failed poll; anything else is a partial board,
  // which is worth having and worth saying so about.
  if (!body.data) {
    throw new Error(`Betr GraphQL: ${body.errors?.[0]?.message || 'no data returned'}`);
  }
  if (body.errors?.length) {
    console.log(`   [betr] partial board: ${body.errors[0]?.message?.slice(0, 120)}`);
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
