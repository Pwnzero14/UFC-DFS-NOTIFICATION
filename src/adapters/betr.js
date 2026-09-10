// Betr Picks. The public GraphQL board went auth-only on 2026-09-07 and then
// session-only: the gateway requires a logged-in browser session, so this
// background watcher cannot call it directly at all. The board is instead read
// from a file the UFC analyzer's browser extension writes - see fetchProps.

import { readFile, stat as statFile } from 'node:fs/promises';
import { postJson } from '../http.js';
import { classify } from '../fantasy.js';
import { loadConfig } from '../config.js';

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

// The direct API is a dead end for this watcher and cannot be revived with a
// token. Betr's gateway does not just check a Bearer - it requires the live
// browser session (the cookies a logged-in tab carries), confirmed on
// 2026-09-10: a genuinely valid access token, lifted straight from a working
// browser session, still returns 401 from Node and even from a fresh headless
// Chrome. Only the real logged-in browser gets in. So there is no token, no
// header, and no refresh that helps; the board comes from the analyzer bridge
// (see fetchProps and readBoardFile). This call stays only so that if Betr ever
// reopens anonymous access it starts working again on its own.
async function gql(query, variables = {}) {
  let body;
  try {
    body = await postJson(ENDPOINT, { query, variables }, { headers: gqlHeaders });
  } catch (err) {
    if (err?.status === 401) {
      throw new Error(
        'Betr API needs a logged-in browser session - configure betr.boardFile ' +
          'to read the board from the analyzer instead'
      );
    }
    throw err;
  }
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

// A board dropped on disk by something that CAN reach Betr - the UFC analyzer's
// Chrome extension, which runs inside the logged-in browser and so carries the
// session cookies Betr's gateway now demands. The watcher is a background Node
// process with no browser session, so as of 2026-09-10 it cannot call Betr's
// API at all; reading what the extension already fetched is the way in.
//
// Two shapes are accepted: the raw GraphQL `data` object ({ getUpcomingEventsV2:
// [...] }), or a bare array of events. Anything else is ignored.
export function normalizeBoard(raw) {
  if (Array.isArray(raw)) return { getUpcomingEventsV2: raw };
  if (raw && Array.isArray(raw.getUpcomingEventsV2)) return raw;
  if (raw && raw.data && Array.isArray(raw.data.getUpcomingEventsV2)) return raw.data;
  throw new Error('Betr board file has no getUpcomingEventsV2 array');
}

async function readBoardFile(path) {
  return normalizeBoard(JSON.parse((await readFile(path, 'utf8')).replace(/^﻿/, '')));
}

// A board file older than this is stale - the extension stopped writing, and
// serving old lines as if live would misreport the board. Fail instead, so the
// heartbeat flags Betr unhealthy rather than the watcher quietly lying.
const BOARD_FILE_MAX_AGE_MS = 15 * 60_000;

export async function fetchProps() {
  const cfg = await loadConfig().catch(() => ({}));
  const boardFile = String(cfg.betr?.boardFile || '').trim();

  let data;
  if (boardFile) {
    // File source: the analyzer bridge. Preferred whenever configured, since
    // the direct API is a dead end for a session-less caller.
    let stat;
    try {
      stat = await statFile(boardFile);
    } catch {
      throw new Error(`Betr board file not found: ${boardFile} - is the analyzer writing it?`);
    }
    const ageMs = Date.now() - stat.mtimeMs;
    if (ageMs > BOARD_FILE_MAX_AGE_MS) {
      throw new Error(
        `Betr board file is stale (${Math.round(ageMs / 60000)}m old) - the analyzer stopped writing it`
      );
    }
    data = await readBoardFile(boardFile);
  } else {
    // No bridge configured: try the API directly. It will 401 until Betr
    // reopens anonymous access, but the path stays here for when it does.
    data = await gql(LEAGUE_QUERY, { league: 'UFC' });
  }

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
