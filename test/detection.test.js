// Detection tests. All synthetic - no live API calls, so this is safe to run
// repeatedly without tripping any book's rate limiter.

import assert from 'node:assert/strict';
import * as store from '../src/state.js';
import { classify } from '../src/fantasy.js';
import { blackoutSince } from '../src/blackout.js';
import { buildAlerts } from '../src/alerts.js';
import {
  buildDiscordPayload,
  moveDelta,
  buildHeartbeatPayload,
  buildBlackoutPayload,
  humanDuration,
} from '../src/notify.js';
import { BROWSER_SCRIPT, boundedValue } from '../src/adapters/pick6.js';

let passed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (err) {
    console.log(`  FAIL  ${name}\n        ${err.message}`);
    process.exitCode = 1;
  }
}

/** Same thing for a test that has to await something. */
async function atest(name, fn) {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (err) {
    console.log(`  FAIL  ${name}\n        ${err.message}`);
    process.exitCode = 1;
  }
}

const prop = (over) => ({
  book: 'underdog',
  event: 'Alvarez vs Turner',
  fighter: 'Joel Alvarez',
  statKey: 'significant_strikes',
  statLabel: 'Significant Strikes',
  kind: 'known',
  value: 38.5,
  ...over,
});

const fantasyProp = (over) =>
  prop({
    statKey: 'fantasy_points',
    statLabel: 'Fantasy Points',
    kind: 'fantasy',
    value: 83.99,
    ...over,
  });

console.log('\nfantasy stat classification');
test('Underdog "Fantasy Points" is fantasy', () => {
  assert.equal(classify('underdog', 'Fantasy Points', 'fantasy_points'), 'fantasy');
});
test('PrizePicks "Fantasy Score" is fantasy', () => {
  assert.equal(classify('prizepicks', 'Fantasy Score'), 'fantasy');
});
test('Betr FANTASY_POINTS key is fantasy', () => {
  assert.equal(classify('betr', 'Fantasy Pts', 'FANTASY_POINTS'), 'fantasy');
});
test('Pick6 "Fantasy Points" tab is fantasy', () => {
  assert.equal(classify('pick6', 'Fantasy Points'), 'fantasy');
});
test('Sig Strikes is NOT fantasy', () => {
  // Watched on most books now, but on none of them may it come back 'fantasy'.
  // That is the drop the whole watcher exists to catch and it must stay clean.
  for (const book of ['underdog', 'prizepicks', 'betr', 'pick6']) {
    assert.notEqual(classify(book, 'Significant Strikes'), 'fantasy', book);
    assert.notEqual(classify(book, 'Sig Strikes'), 'fantasy', book);
  }
  assert.equal(classify('underdog', 'Significant Strikes'), 'tracked');
});
test('Total Rounds is NOT fantasy', () => {
  assert.equal(classify('prizepicks', 'Total Rounds'), 'known');
});
test('an unseen stat is flagged unknown', () => {
  assert.equal(classify('underdog', 'Spinning Back Kicks'), 'unknown');
});

console.log('\ndrop detection');
test('fantasy prop appearing after baseline is reported new', () => {
  const state = { books: {} };
  const baseline = [prop()];
  let d = store.diff(state, 'underdog', baseline);
  store.commit(state, 'underdog', d.fresh);

  d = store.diff(state, 'underdog', [prop(), fantasyProp()]);
  assert.equal(d.newProps.length, 1, 'expected exactly one new prop');
  assert.equal(d.newProps[0].kind, 'fantasy');
  assert.equal(d.newProps[0].value, 83.99);
});

test('the same fantasy prop does not re-alert', () => {
  const state = { books: {} };
  const board = [prop(), fantasyProp()];
  let d = store.diff(state, 'underdog', board);
  store.commit(state, 'underdog', d.fresh);

  d = store.diff(state, 'underdog', board);
  assert.equal(d.newProps.length, 0, 'a steady board must produce no new props');
});

test('both fighters on a card are detected', () => {
  const state = { books: {} };
  let d = store.diff(state, 'underdog', [prop()]);
  store.commit(state, 'underdog', d.fresh);

  d = store.diff(state, 'underdog', [
    prop(),
    fantasyProp({ fighter: 'Joel Alvarez', value: 83.99 }),
    fantasyProp({ fighter: 'Jalin Turner', value: 89.99 }),
  ]);
  assert.equal(d.newProps.length, 2);
});

test('line moves on a fantasy prop are tracked separately from new props', () => {
  const state = { books: {} };
  let d = store.diff(state, 'underdog', [fantasyProp({ value: 83.99 })]);
  store.commit(state, 'underdog', d.fresh);

  d = store.diff(state, 'underdog', [fantasyProp({ value: 86.5 })]);
  assert.equal(d.newProps.length, 0, 'a moved line is not a new prop');
  assert.equal(d.moved.length, 1);
  assert.equal(d.moved[0].previousValue, 83.99);
  assert.equal(d.moved[0].value, 86.5);
});

test('a line move on a non-fantasy prop is ignored', () => {
  const state = { books: {} };
  let d = store.diff(state, 'underdog', [prop({ value: 38.5 })]);
  store.commit(state, 'underdog', d.fresh);

  d = store.diff(state, 'underdog', [prop({ value: 41.5 })]);
  assert.equal(d.moved.length, 0);
});

test('PrizePicks demon and goblin variants stay distinct', () => {
  const state = { books: {} };
  const base = {
    book: 'prizepicks',
    event: 'A vs B',
    fighter: 'A',
    statKey: 'Fantasy Score',
    statLabel: 'Fantasy Score',
    kind: 'fantasy',
  };
  const d = store.diff(state, 'prizepicks', [
    { ...base, variant: 'standard:g1', value: 80 },
    { ...base, variant: 'demon:g1', value: 92 },
    { ...base, variant: 'goblin:g1', value: 68 },
  ]);
  assert.equal(d.newProps.length, 3, 'each odds variant is its own offer');
  assert.equal(Object.keys(d.fresh).length, 3);
});

test('books do not leak into one another', () => {
  const state = { books: {} };
  let d = store.diff(state, 'underdog', [fantasyProp()]);
  store.commit(state, 'underdog', d.fresh);

  // Same prop shape, different book: must still be new for that book.
  d = store.diff(state, 'betr', [fantasyProp({ book: 'betr' })]);
  assert.equal(d.newProps.length, 1);
});

console.log('\nalert rendering');
test('discord payload carries fighters, lines and a mention', () => {
  const payload = buildDiscordPayload(
    {
      kind: 'fantasy',
      bookMeta: { name: 'Underdog', color: 0, boardUrl: 'https://x' },
      props: [
        fantasyProp({ fighter: 'Joel Alvarez', value: 83.99, startsAt: '2026-08-23T01:40:00Z' }),
        fantasyProp({ fighter: 'Jalin Turner', value: 89.99, startsAt: '2026-08-23T01:40:00Z' }),
      ],
    },
    { discord: { mention: '@everyone' } }
  );
  assert.match(payload.content, /@everyone/);
  assert.match(payload.content, /FANTASY PROPS ARE UP/);
  assert.equal(payload.embeds.length, 1, 'one embed per event');
  assert.match(payload.embeds[0].description, /Joel Alvarez/);
  assert.match(payload.embeds[0].description, /83\.99/);
  assert.match(payload.embeds[0].description, /Jalin Turner/);
});

test('discord embed count stays within the API limit', () => {
  const props = Array.from({ length: 25 }, (_, i) =>
    fantasyProp({ event: `Card ${i}`, fighter: `Fighter ${i}` })
  );
  const payload = buildDiscordPayload(
    { kind: 'fantasy', bookMeta: { name: 'Underdog', color: 0, boardUrl: 'https://x' }, props },
    {}
  );
  assert.ok(payload.embeds.length <= 10, 'Discord rejects more than 10 embeds');
});

test('a line move renders both the old and the new value', () => {
  const payload = buildDiscordPayload(
    {
      kind: 'move',
      bookMeta: { name: 'Underdog', color: 0, boardUrl: 'https://x' },
      props: [fantasyProp({ value: 86.5, previousValue: 83.99 })],
    },
    {}
  );
  assert.match(payload.embeds[0].description, /83\.99/);
  assert.match(payload.embeds[0].description, /86\.5/);
});

console.log('\nline moves');
const moveAlert = (over = {}) => ({
  kind: 'move',
  bookMeta: { name: 'Underdog', color: 0, boardUrl: 'https://x' },
  props: [fantasyProp({ value: 86.5, previousValue: 83.99 })],
  ...over,
});

test('an upward move renders an up arrow and a signed delta', () => {
  assert.equal(moveDelta(83.99, 86.5), '\u{1F53A} +2.51');
});

test('a downward move renders a down arrow and a negative delta', () => {
  assert.equal(moveDelta(86.5, 83.99), '\u{1F53B} -2.51');
});

test('a move alert titles as a move, not as a drop', () => {
  const payload = buildDiscordPayload(moveAlert(), { discord: { mention: '@everyone' } });
  assert.match(payload.content, /line move/);
  assert.doesNotMatch(payload.content, /PROPS ARE UP/);
});

test('moves post without a ping by default', () => {
  const payload = buildDiscordPayload(moveAlert(), { discord: { mention: '@everyone' } });
  assert.doesNotMatch(payload.content, /@everyone/);
});

test('moves ping when mentionOnLineMove is enabled', () => {
  const payload = buildDiscordPayload(moveAlert(), {
    discord: { mention: '@everyone', mentionOnLineMove: true },
  });
  assert.match(payload.content, /@everyone/);
});

test('a genuine drop still pings', () => {
  const payload = buildDiscordPayload(
    {
      kind: 'fantasy',
      bookMeta: { name: 'Underdog', color: 0, boardUrl: 'https://x' },
      props: [fantasyProp()],
    },
    { discord: { mention: '@everyone' } }
  );
  assert.match(payload.content, /@everyone/);
});

console.log('\nunderdog watched markets');
// Underdog has not posted these yet, so cover the naming variants it might use
// rather than waiting to find out live.
for (const [label, key] of [
  ['Round 1 Significant Strikes', 'round_1_significant_strikes'],
  ['Round 1 Sig Strikes', 'round_1_sig_strikes'],
  ['1st Round Significant Strikes', 'first_round_significant_strikes'],
  ['Round 1 Significant Strikes O/U', 'round_1_significant_strikes'],
]) {
  test(`"${label}" is tracked, not a quiet unknown`, () => {
    assert.equal(classify('underdog', label, key), 'tracked');
  });
}

test('a tracked prop alerts on a drop', () => {
  const state = { books: {} };
  const base = prop({ book: 'underdog' });
  let d = store.diff(state, 'underdog', [base]);
  store.commit(state, 'underdog', d.fresh);

  const r1 = prop({
    book: 'underdog',
    statKey: 'round_1_significant_strikes',
    statLabel: 'Round 1 Significant Strikes',
    kind: 'tracked',
    value: 12.5,
  });
  d = store.diff(state, 'underdog', [base, r1]);
  assert.equal(d.newProps.length, 1);
  assert.ok(store.ALERTING_KINDS.has(d.newProps[0].kind), 'must be an alerting kind');
});

test('a tracked prop alerts on a line move in either direction', () => {
  const state = { books: {} };
  const at = (v) =>
    prop({
      book: 'underdog',
      statKey: 'round_1_significant_strikes',
      statLabel: 'Round 1 Significant Strikes',
      kind: 'tracked',
      value: v,
    });

  let d = store.diff(state, 'underdog', [at(12.5)]);
  store.commit(state, 'underdog', d.fresh);

  d = store.diff(state, 'underdog', [at(14.5)]);
  assert.equal(d.moved.length, 1, 'upward move');
  assert.equal(d.moved[0].previousValue, 12.5);
  store.commit(state, 'underdog', d.fresh);

  d = store.diff(state, 'underdog', [at(11.5)]);
  assert.equal(d.moved.length, 1, 'downward move');
  assert.equal(d.moved[0].value, 11.5);
});

test('underdog ordinary markets stay quiet', () => {
  assert.equal(classify('underdog', 'Knockouts', 'knockouts'), 'known');
  assert.equal(classify('underdog', 'Control Time', 'control_time'), 'known');
  assert.equal(classify('underdog', 'Fight Time (Mins)', 'fight_time'), 'known');
});

test('underdog full-fight sig strikes and takedowns are watched', () => {
  assert.equal(classify('underdog', 'Significant Strikes', 'significant_strikes'), 'tracked');
  assert.equal(classify('underdog', 'Takedowns', 'takedowns'), 'tracked');
});

test('the attempted markets are not swept up with the ones asked for', () => {
  // The trap: "Significant Strikes Attempted" contains "Significant Strikes".
  // It is a different line, and promoting it would ping on a market nobody
  // asked about.
  assert.equal(
    classify('underdog', 'Significant Strikes Attempted', 'significant_strikes_attempted'),
    'known'
  );
});

test('watching sig strikes does not leak to the books that did not ask', () => {
  assert.equal(classify('prizepicks', 'Significant Strikes', 'significant_strikes'), 'known');
  assert.equal(classify('dksportsbook', 'Significant Strikes', 'significant_strikes'), 'unknown');
});

test('betr sig strikes and takedowns are watched, in betr spelling', () => {
  // Betr abbreviates the label and shouts the key: "Sig Strikes"/SIG_STRIKES.
  assert.equal(classify('betr', 'Sig Strikes', null, 'SIG_STRIKES'), 'tracked');
  assert.equal(classify('betr', 'Significant Strikes', null, 'significant_strikes'), 'tracked');
  assert.equal(classify('betr', 'Takedowns', null, 'TAKEDOWNS'), 'tracked');
});

test('betr takedowns are caught under either spelling of the market', () => {
  // Betr had no takedown market posted when this was written, so the label is
  // unobserved - its own known list carried both spellings and DK words it
  // "Takedowns Landed", so both are matched rather than guessing one.
  assert.equal(classify('betr', 'Takedowns Landed', null, 'TAKEDOWNS_LANDED'), 'tracked');
});

test('betr attempted markets are not swept in with the ones asked for', () => {
  // Anchored patterns: the attempted markets are supersets of these words.
  assert.notEqual(classify('betr', 'Sig Strikes Attempted', null, 'SIG_STRIKES_ATTEMPTED'), 'tracked');
  assert.notEqual(classify('betr', 'Takedowns Attempted', null, 'TAKEDOWNS_ATTEMPTED'), 'tracked');
});

test('betr fantasy still outranks the watched markets', () => {
  assert.equal(classify('betr', 'Fantasy Pts', null, 'FANTASY_POINTS'), 'fantasy');
});

test('betr ordinary markets stay quiet', () => {
  for (const [label, key] of [
    ['Fight Time (Minutes)', 'FIGHT_TIME'],
    ['Decision Win', 'DECISION_WIN'],
    ['Finishes', 'FINISHES'],
    ['Knockdowns', 'KNOCKDOWNS'],
    ['Control Time', 'CONTROL_TIME'],
    ['Round of Victory', 'ROUND_OF_VICTORY'],
  ]) {
    assert.equal(classify('betr', label, null, key), 'known', label);
  }
});

test('pick6 full-fight sig strikes is watched', () => {
  assert.equal(classify('pick6', 'Significant Strikes', 'significant_strikes'), 'tracked');
  assert.equal(
    classify('pick6', 'Significant Strikes Attempted', 'significant_strikes_attempted'),
    'known'
  );
});

test('pick6 takedowns classify known so the tab placeholder stays quiet', () => {
  // The real Pick6 takedown props are built with an explicit kind:'tracked' and
  // never reach classify. The tab-only placeholder does, and it carries a
  // different prop key - watched, it would read as a brand new prop and fire a
  // drop alert for what is only a failed read of a market already on the board.
  assert.equal(classify('pick6', 'Takedowns', 'takedowns'), 'known');
});

test('round 1 sig strikes is still watched in its own right', () => {
  // The new whole-name patterns must not have displaced the round-scoped ones.
  assert.equal(classify('underdog', 'Round 1 Significant Strikes'), 'tracked');
  assert.equal(classify('underdog', 'round_1_significant_strikes'), 'tracked');
});

test('underdog fantasy still classifies as fantasy, not tracked', () => {
  assert.equal(classify('underdog', 'Fantasy Points', 'fantasy_points'), 'fantasy');
});

test('PrizePicks round 1 is watched too, in either word order', () => {
  for (const label of [
    'Round 1 Significant Strikes',
    'Significant Strikes (Round 1)',
    '1st Round Sig Strikes',
    'round_1_significant_strikes',
  ]) {
    assert.equal(classify('prizepicks', label), 'tracked', label);
  }
});

test('PrizePicks ordinary markets stay quiet', () => {
  for (const label of ['Total Rounds', 'Significant Strikes', 'Fight Time (Mins)', 'Takedowns']) {
    assert.notEqual(classify('prizepicks', label), 'tracked', label);
  }
  assert.equal(classify('prizepicks', 'Fantasy Score'), 'fantasy');
});

test('Underdog round-scoped finish markets stay quiet as a family', () => {
  for (const label of [
    'Round 1 Knockout', 'Round 2 Knockout', 'Round 3 Submission',
    '1st Round Finish', '5th Round Finish', 'Round 1 Decision', 'RD 2 KO',
  ]) {
    assert.equal(classify('underdog', label), 'known', label);
  }
});

test('silencing the round-finish family does not touch round 1 sig strikes', () => {
  for (const label of [
    'Round 1 Significant Strikes', 'RD 1 Significant Strikes', '1st Round Sig Strikes',
  ]) {
    assert.equal(classify('underdog', label), 'tracked', label);
  }
  assert.equal(classify('underdog', 'Fantasy Points'), 'fantasy');
});

test('PrizePicks knockdowns are watched', () => {
  for (const label of ['Knockdowns', 'Knockdown', 'Knockdowns Landed', 'knockdowns_landed']) {
    assert.equal(classify('prizepicks', label), 'tracked', label);
  }
});

test('knockdowns never collide with knockouts', () => {
  for (const label of ['Knockouts', 'Knockout', 'KOs']) {
    assert.notEqual(classify('prizepicks', label), 'tracked', label);
  }
});

test('knockdowns are watched on PrizePicks only', () => {
  assert.equal(classify('prizepicks', 'Knockdowns'), 'tracked');
  assert.notEqual(classify('underdog', 'Knockdowns'), 'tracked');
});

test('a round 2 market is not mistaken for round 1', () => {
  assert.notEqual(classify('prizepicks', 'Significant Strikes (Round 2)'), 'tracked');
  assert.notEqual(classify('underdog', 'Round 2 Significant Strikes'), 'tracked');
});

test('the watched list is per-book: pick6 round 1 is not underdog', () => {
  // Only Underdog was asked for; other books keep their existing behaviour.
  assert.notEqual(classify('pick6', 'Round 1 Significant Strikes'), 'tracked');
});

console.log('\ntime-valued markets');
test('a time move renders as mm:ss with a seconds delta', () => {
  const p = buildDiscordPayload(
    {
      kind: 'move',
      bookMeta: { name: 'DraftKings Pick6', color: 0, boardUrl: 'https://x' },
      props: [
        {
          fighter: 'A. Hernandez',
          statLabel: 'Control Time',
          value: 330,
          previousValue: 390,
          unit: 'time',
          event: 'Hernandez vs Rodrigues',
        },
      ],
    },
    {}
  );
  const body = p.embeds[0].description;
  assert.match(body, /6:30/, 'old value as clock');
  assert.match(body, /5:30/, 'new value as clock');
  assert.match(body, /-60s/, 'delta in seconds');
  assert.doesNotMatch(body, /390|330/, 'raw seconds must not leak into the text');
});

test('non-time markets are unaffected by the clock formatting', () => {
  assert.equal(moveDelta(105.5, 108.5), '\u{1F53A} +3.00');
  const p = buildDiscordPayload(
    {
      kind: 'move',
      bookMeta: { name: 'DraftKings Pick6', color: 0, boardUrl: 'https://x' },
      props: [fantasyProp({ value: 108.5, previousValue: 105.5 })],
    },
    {}
  );
  assert.match(p.embeds[0].description, /105\.5.*108\.5/);
});

test('control time is an alerting kind', () => {
  assert.ok(store.ALERTING_KINDS.has('tracked'));
});

console.log('\nfeed churn');
test('a prop that blinks out and returns at a new value is a MOVE, not a new prop', () => {
  const state = { books: {} };
  const at = (v) => [fantasyProp({ book: 'betr', value: v })];

  // Seen at 91.5
  let d = store.diff(state, 'betr', at(91.5));
  store.commit(state, 'betr', d.fresh);

  // Vanishes from the feed for a poll (partial fetch, failed sub-query, ...)
  d = store.diff(state, 'betr', []);
  store.commit(state, 'betr', d.fresh);

  // Returns at 96.5 - this must be a move, not a fresh "PROPS ARE UP" alert.
  d = store.diff(state, 'betr', at(96.5));
  assert.equal(d.newProps.length, 0, 'must NOT be reported as a new prop');
  assert.equal(d.moved.length, 1, 'must be reported as a move');
  assert.equal(d.moved[0].previousValue, 91.5);
});

test('a prop absent long enough is eventually forgotten', () => {
  const state = { books: {} };
  let d = store.diff(state, 'betr', [fantasyProp({ book: 'betr', value: 91.5 })]);
  store.commit(state, 'betr', d.fresh);

  for (let i = 0; i < 5; i++) {
    d = store.diff(state, 'betr', []);
    store.commit(state, 'betr', d.fresh);
  }
  assert.equal(Object.keys(state.books.betr.props).length, 0, 'stale prop should be dropped');
});

test('a prop present every poll never accrues misses', () => {
  const state = { books: {} };
  const p = [fantasyProp({ book: 'betr', value: 91.5 })];
  for (let i = 0; i < 8; i++) {
    const d = store.diff(state, 'betr', p);
    store.commit(state, 'betr', d.fresh);
  }
  const only = Object.values(state.books.betr.props)[0];
  assert.equal(only.misses, undefined, 'misses must reset while the prop is present');
  assert.equal(only.value, 91.5);
});

console.log('\ndelivery failures');
test('a prop held back after a failed send is re-detected next poll', () => {
  const state = { books: {} };

  // Poll 1: baseline with the old value.
  let d = store.diff(state, 'betr', [fantasyProp({ book: 'betr', value: 91.5 })]);
  store.commit(state, 'betr', d.fresh);

  // Poll 2: value moves, but delivery fails - rewind that key (what pollOne does).
  const movedProps = [fantasyProp({ book: 'betr', value: 96.5 })];
  d = store.diff(state, 'betr', movedProps);
  assert.equal(d.moved.length, 1, 'move must be detected');

  const prior = state.books.betr.props;
  const k = store.propKey(movedProps[0]);
  d.fresh[k] = prior[k]; // simulate the held-back rewind
  store.commit(state, 'betr', d.fresh);

  // Poll 3: same live value - must be detected AGAIN because we never recorded it.
  const d3 = store.diff(state, 'betr', movedProps);
  assert.equal(d3.moved.length, 1, 'held-back move must resurface');
  assert.equal(d3.moved[0].previousValue, 91.5);
  assert.equal(d3.moved[0].value, 96.5);
});

test('without the rewind the alert would be lost (regression guard)', () => {
  const state = { books: {} };
  let d = store.diff(state, 'betr', [fantasyProp({ book: 'betr', value: 91.5 })]);
  store.commit(state, 'betr', d.fresh);

  const movedProps = [fantasyProp({ book: 'betr', value: 96.5 })];
  d = store.diff(state, 'betr', movedProps);
  store.commit(state, 'betr', d.fresh); // commit WITHOUT rewinding

  const d3 = store.diff(state, 'betr', movedProps);
  assert.equal(d3.moved.length, 0, 'this is the silent-loss path the rewind prevents');
});

console.log('\nheartbeat');
const BOOKS = [
  { key: 'underdog', name: 'Underdog' },
  { key: 'betr', name: 'Betr' },
];
const healthyState = {
  books: {
    underdog: {
      healthy: true,
      updatedAt: new Date().toISOString(),
      props: { a: { kind: 'known' }, b: { kind: 'known' } },
    },
    betr: {
      healthy: true,
      updatedAt: new Date().toISOString(),
      props: { c: { kind: 'known' } },
    },
  },
};

test('a healthy heartbeat reports all books green', () => {
  const p = buildHeartbeatPayload(healthyState, {}, BOOKS, 3_600_000);
  assert.match(p.content, /all books healthy/);
  assert.match(p.embeds[0].description, /🟢 \*\*Underdog\*\* — 2 props/);
  assert.match(p.embeds[0].description, /🟢 \*\*Betr\*\* — 1 props/);
});

test('a heartbeat can never ping', () => {
  const p = buildHeartbeatPayload(healthyState, { discord: { mention: '@everyone' } }, BOOKS, 0);
  assert.deepEqual(p.allowed_mentions, { parse: [] });
  assert.doesNotMatch(p.content, /@everyone/);
});

test('an unhealthy book flips the heartbeat to a warning', () => {
  const bad = structuredClone(healthyState);
  bad.books.betr.healthy = false;
  const p = buildHeartbeatPayload(bad, {}, BOOKS, 0);
  assert.match(p.content, /unhealthy/);
  assert.match(p.embeds[0].description, /🔴 \*\*Betr\*\*/);
});

test('a missing book is reported rather than silently skipped', () => {
  const p = buildHeartbeatPayload({ books: {} }, {}, BOOKS, 0);
  assert.match(p.content, /unhealthy/);
  assert.match(p.embeds[0].description, /no data yet/);
});

test('fantasy props are called out once they exist', () => {
  const withFantasy = structuredClone(healthyState);
  withFantasy.books.underdog.props.z = { kind: 'fantasy' };
  const p = buildHeartbeatPayload(withFantasy, {}, BOOKS, 0);
  assert.match(p.embeds[0].description, /\*\*1 FANTASY\*\*/);
});

test('a manual heartbeat does not claim a bogus uptime', () => {
  const p = buildHeartbeatPayload(healthyState, {}, BOOKS, null);
  assert.match(p.embeds[0].footer.text, /manual check/);
  assert.doesNotMatch(p.embeds[0].footer.text, /up 0h 0m/);
});

test('a daemon heartbeat reports real uptime', () => {
  const p = buildHeartbeatPayload(healthyState, {}, BOOKS, 5 * 3_600_000 + 12 * 60_000);
  assert.match(p.embeds[0].footer.text, /up 5h 12m/);
});

// ------------------------------------------- Pick6: the lock countdown clock
//
// On 2026-08-22 the Pick6 reader started returning 3587 for two Fantasy Points
// lines and walking it down ~138 every poll, one @everyone ping every couple of
// minutes for four hours. 3587 is 59:47 in seconds: once a bout is under an
// hour away DK renders a live countdown to lock inside its cards, the reader
// preferred "the first mm:ss" over "the first number", and it read the clock.
//
// These run the REAL page script against a fake board rather than a copy of its
// logic, so the thing under test is the string that actually ships.

function fakeBoard(opts = {}) {
  const { countdownSecs = null } = opts;
  let selected = 'Significant Strikes';
  let pill = 'Fight Time';
  let ticking = countdownSecs;

  const clock = () => {
    if (ticking == null) return null;
    ticking -= 1; // the clock keeps running between the two tab passes
    return `${Math.floor(ticking / 60)}:${String(ticking % 60).padStart(2, '0')}`;
  };

  // fighter -> [opponent, stat lines]. The countdown is spliced in ahead of the
  // stat value, which is what made the old "first mm:ss wins" reader take it.
  const GRID = {
    'Significant Strikes': [['S. Dyer', 'vs Reed', '54.5'], ['E. Reed', 'vs Dyer', '48.5']],
    'Fantasy Points': [['S. Dyer', 'vs Reed', '93.5'], ['E. Reed', 'vs Dyer', '33.5']],
    Takedowns: [['S. Dyer', 'vs Reed', '1.5'], ['E. Reed', 'vs Dyer', '2.5']],
    'Time/Fight Time': [
      ['S. Dyer', 'vs Reed', '9:30', 'Fight Time'],
      ['E. Reed', 'vs Dyer', '9:30', 'Fight Time'],
    ],
    'Time/Control Time': [
      ['S. Dyer', 'vs Reed', '1:30', 'Control Time'],
      ['E. Reed', 'vs Dyer', '0:45', 'Control Time'],
    ],
  };

  const cardsNow = () => {
    const rows = GRID[selected === 'Time' ? `Time/${pill}` : selected] || [];
    return rows.map(([fighter, opponent, ...rest]) => {
      const tick = clock();
      const lines = [fighter, opponent, ...(tick ? [tick] : []), ...rest];
      return {
        innerText: lines.join('\n'),
        querySelector: (sel) =>
          sel.includes('player-name') ? { textContent: fighter } : null,
      };
    });
  };

  const tab = (label) => ({
    textContent: label,
    getAttribute: (a) => (a === 'aria-selected' ? String(selected === label) : null),
    click() {
      selected = label;
      pill = 'Fight Time'; // the Time tab always opens on its default pill
    },
  });
  const tabs = (opts.tabs || ['Significant Strikes', 'Fantasy Points', 'Takedowns', 'Time']).map(tab);

  const leaf = (label) => ({
    textContent: label,
    children: [],
    closest: () => null,
    click() {
      pill = label;
    },
  });
  const leaves = [leaf('Fight Time'), leaf('Control Time')];

  return {
    querySelectorAll(sel) {
      if (sel === '[role="tab"]') return tabs;
      if (sel === '[data-testid="playerStatCard"]') return cardsNow();
      if (sel === 'button,a,div,span') return leaves;
      return [];
    },
  };
}

async function readBoard(opts) {
  globalThis.document = fakeBoard(opts);
  try {
    return await eval(BROWSER_SCRIPT);
  } finally {
    delete globalThis.document;
  }
}

const byFighter = (cards) =>
  Object.fromEntries((cards || []).map((c) => [c.fighter, c.value]));

await atest('a lock countdown is not read as a Fantasy Points line', async () => {
  const out = await readBoard({ countdownSecs: 3587 }); // 59:47, the real one
  assert.deepEqual(byFighter(out.fantasy), { 'S. Dyer': '93.5', 'E. Reed': '33.5' });
});

await atest('a lock countdown is not read as a Control Time line', async () => {
  const out = await readBoard({ countdownSecs: 3587 });
  assert.deepEqual(byFighter(out.controlTime), { 'S. Dyer': '1:30', 'E. Reed': '0:45' });
});

await atest('a countdown that has ticked down near the line is still skipped', async () => {
  // The dangerous case is late in the hour, when the clock stops being an
  // obvious outlier and starts looking like a plausible control time.
  const out = await readBoard({ countdownSecs: 200 }); // 3:20, next to 1:30
  assert.deepEqual(byFighter(out.controlTime), { 'S. Dyer': '1:30', 'E. Reed': '0:45' });
  assert.deepEqual(byFighter(out.fantasy), { 'S. Dyer': '93.5', 'E. Reed': '33.5' });
});

await atest('a board with no countdown still reads both markets', async () => {
  const out = await readBoard();
  assert.deepEqual(byFighter(out.fantasy), { 'S. Dyer': '93.5', 'E. Reed': '33.5' });
  assert.deepEqual(byFighter(out.controlTime), { 'S. Dyer': '1:30', 'E. Reed': '0:45' });
});

await atest('a countdown is reported with the raw card text behind it', async () => {
  // The diagnostic exists so a variant that slips past the reader leaves
  // evidence, rather than having to be reconstructed from Discord embeds.
  const out = await readBoard({ countdownSecs: 3587 });
  assert.equal(out.countdowns.length, 2);
  const [dyer] = out.countdowns;
  assert.equal(dyer.fighter, 'S. Dyer');
  // The fake clock ticks with every read, as the real one does, so assert the
  // shape rather than an exact second.
  assert.equal(dyer.clocks.length, 1);
  assert.match(dyer.clocks[0], /^59:\d{2}$/);
  assert.deepEqual(dyer.lines, ['S. Dyer', 'vs Reed', dyer.clocks[0], '93.5']);
});

await atest('a quiet board reports no countdowns to log', async () => {
  const out = await readBoard();
  assert.deepEqual(out.countdowns, []);
});

await atest('takedowns are read off their own tab', async () => {
  const out = await readBoard();
  assert.deepEqual(byFighter(out.takedowns), { 'S. Dyer': '1.5', 'E. Reed': '2.5' });
});

await atest('a countdown is not read as a takedown line either', async () => {
  const out = await readBoard({ countdownSecs: 3587 });
  assert.deepEqual(byFighter(out.takedowns), { 'S. Dyer': '1.5', 'E. Reed': '2.5' });
});

await atest('a board with takedowns but no fantasy tab still reads them', async () => {
  // Days out, DK has posted Significant Strikes and little else. The trip has
  // to work for whichever tabs exist rather than assuming fantasy is up.
  const out = await readBoard({ tabs: ['Significant Strikes', 'Takedowns'] });
  assert.equal(out.fantasy, null);
  assert.deepEqual(byFighter(out.takedowns), { 'S. Dyer': '1.5', 'E. Reed': '2.5' });
});

await atest('takedowns still dodge the clock with no fantasy tab to learn from', async () => {
  // With no fantasy pass, the Takedowns pass is what teaches Control Time the
  // countdown - and must not be fooled by it itself.
  const out = await readBoard({
    tabs: ['Takedowns', 'Time'],
    countdownSecs: 3587,
  });
  assert.deepEqual(byFighter(out.takedowns), { 'S. Dyer': '1.5', 'E. Reed': '2.5' });
  assert.deepEqual(byFighter(out.controlTime), { 'S. Dyer': '1:30', 'E. Reed': '0:45' });
});

test('an impossible takedown value is nulled too', () => {
  assert.equal(boundedValue('Takedowns', '2.5'), 2.5);
  assert.equal(boundedValue('Takedowns', 3587), null);
});

test('an impossible fantasy value is nulled, not published', () => {
  assert.equal(boundedValue('Fantasy Points', '93.5'), 93.5);
  assert.equal(boundedValue('Fantasy Points', 3587), null);
});

test('control time is capped at the length of a five round fight', () => {
  assert.equal(boundedValue('Control Time', '6:30'), 390);
  assert.equal(boundedValue('Control Time', '25:00'), 1500);
  assert.equal(boundedValue('Control Time', '59:47'), null);
});

test('a nulled value cannot raise a line move in either direction', () => {
  // This is why boundedValue nulls rather than drops: the prop key survives,
  // so a bad read goes quiet instead of firing, and recovering from one does
  // not read as a brand new prop and fire a drop alert.
  const p = (value) => [prop({ book: 'pick6', kind: 'fantasy', value })];
  let state = { books: {} };
  store.commit(state, 'pick6', store.diff(state, 'pick6', p(93.5)).fresh);
  assert.equal(store.diff(state, 'pick6', p(null)).moved.length, 0);
  store.commit(state, 'pick6', store.diff(state, 'pick6', p(null)).fresh);
  assert.equal(store.diff(state, 'pick6', p(93.5)).moved.length, 0);
  assert.equal(store.diff(state, 'pick6', p(93.5)).newProps.length, 0);
});

// ------------------------------------------------------------- blackouts
//
// Sleeping the laptop suspends the watcher without killing it. Over four days
// that cost ~45% of uptime, in stretches up to 10h51m, and on wake it just
// resumed - nothing marked the catch-up alerts as hours stale.

const T0 = Date.parse('2026-08-25T07:28:32Z'); // the real 10h51m sleep
const WOKE = Date.parse('2026-08-25T18:19:14Z');

test('the August 25 sleep would have been caught', () => {
  const gap = blackoutSince(T0, null, WOKE);
  assert.ok(gap);
  assert.equal(humanDuration(gap.ms), '10h 51m');
});

test('an ordinary cycle is not a blackout', () => {
  assert.equal(blackoutSince(WOKE - 5_000, null, WOKE), null);
  // Pick6's browser trip plus DK's page is the slowest honest cycle there is.
  assert.equal(blackoutSince(WOKE - 4 * 60_000, null, WOKE), null);
});

test('the very first run ever reports nothing missed', () => {
  assert.equal(blackoutSince(null, null, WOKE), null);
  assert.equal(blackoutSince(null, undefined, WOKE), null);
});

test('an unparseable lastRun is not treated as an infinite blackout', () => {
  // Date.parse of junk is NaN, and NaN comparisons are false - easy to get
  // wrong in a way that reports a gap since the epoch.
  assert.equal(blackoutSince(null, 'not a date', WOKE), null);
});

test('a restart falls back to the persisted stamp', () => {
  // Nothing in memory yet, so state.lastRun is the only evidence. This is the
  // reboot and crash case; sleep is covered by memory.
  const gap = blackoutSince(null, new Date(T0).toISOString(), WOKE);
  assert.ok(gap);
  assert.equal(humanDuration(gap.ms), '10h 51m');
});

test('a deliberate restart is not reported as a blackout', () => {
  // The user restarts the task constantly to deploy - that must stay silent.
  assert.equal(blackoutSince(null, new Date(WOKE - 20_000).toISOString(), WOKE), null);
});

test('memory wins over the persisted stamp after a sleep', () => {
  // state.lastRun was written before the machine went under, so it is older
  // and would overstate the gap. The in-memory cycle time is the truth.
  const stale = new Date(T0 - 6 * 3_600_000).toISOString();
  const gap = blackoutSince(T0, stale, WOKE);
  assert.equal(humanDuration(gap.ms), '10h 51m'); // not 16h51m
});

test('a clock that jumps backwards is not a blackout', () => {
  // DST or an NTP correction can make now earlier than the last cycle.
  assert.equal(blackoutSince(WOKE + 3_600_000, null, WOKE), null);
});

test('a blackout is reported in hours and minutes', () => {
  // The real one: 2026-08-25 03:28 -> 14:19.
  assert.equal(humanDuration(10 * 3_600_000 + 51 * 60_000), '10h 51m');
});

test('a short blackout does not claim a bogus 0h', () => {
  assert.equal(humanDuration(43 * 60_000), '43m');
  assert.doesNotMatch(humanDuration(43 * 60_000), /0h/);
});

test('the blackout notice says how long and that alerts may be stale', () => {
  const now = Date.now();
  const p = buildBlackoutPayload({}, { from: now - 39_060_000, to: now, ms: 39_060_000 });
  assert.match(p.content, /10h 51m/);
  assert.match(p.embeds[0].description + p.embeds[0].title, /late|stale/i);
});

test('a blackout notice can never ping', () => {
  // Same rule as the heartbeat: this is status, and it is read at a keyboard.
  const now = Date.now();
  const p = buildBlackoutPayload(
    { discord: { mention: '@everyone', mentionOnLineMove: true } },
    { from: now - 39_060_000, to: now, ms: 39_060_000 }
  );
  assert.deepEqual(p.allowed_mentions, { parse: [] });
  assert.doesNotMatch(p.content, /@everyone/);
  assert.doesNotMatch(JSON.stringify(p.embeds), /@everyone/);
});

// ------------------------------------------ telling the markets apart
//
// Every watched market used to share one bucket with fantasy, so the headline
// named whichever family the payload noticed first. A takedown line really did
// post as "UFC FANTASY PROPS ARE UP", and a sig strikes move as "fantasy line
// moves". On Saturday a real drop and a takedown opening can land in the same
// poll, and they have to be distinguishable at a glance.

const titleOf = (kind, props) =>
  buildDiscordPayload(
    { kind, bookMeta: { name: 'Betr', color: 0, boardUrl: 'https://x' }, props },
    {}
  ).content;

test('at most one embed carries the board link', () => {
  // Discord merges embeds that share a `url` into a single preview. With the
  // board URL on every one, a twelve-prop alert across seven bouts arrived
  // showing one embed and two lines - the rest were sent and swallowed.
  const P = (f, e) => prop({ kind: 'tracked', fighter: f, event: e, value: 50 });
  const payload = buildDiscordPayload(
    {
      kind: 'tracked',
      bookMeta: { name: 'Pick6', color: 0, boardUrl: 'https://pick6.example' },
      props: [
        P('A', 'A vs B'), P('B', 'A vs B'),
        P('C', 'C vs D'), P('D', 'C vs D'),
        P('E', 'E vs F'), P('F', 'E vs F'),
      ],
    },
    {}
  );
  assert.equal(payload.embeds.length, 3, 'one embed per bout');
  assert.equal(payload.embeds.filter((e) => e.url).length, 1, 'only one may link');
  const lines = payload.embeds.reduce((n, e) => n + e.description.split('\n').length, 0);
  assert.equal(lines, 6, 'every prop still rendered');
});

test('a takedown market opening is not announced as fantasy', () => {
  const t = titleOf('tracked', [
    prop({ kind: 'tracked', statLabel: 'Takedowns', fighter: 'Denise Gomes', value: 1.5 }),
  ]);
  assert.match(t, /TAKEDOWNS ARE UP/);
  assert.doesNotMatch(t, /FANTASY/i);
});

test('the fantasy drop still announces as fantasy', () => {
  const t = titleOf('fantasy', [fantasyProp()]);
  assert.match(t, /FANTASY PROPS ARE UP/);
});

test('a watched market opening pings like the drop does', () => {
  // It is still a market opening, and the whole point of watching it is to be
  // told when it appears - it just gets called by its own name.
  const p = buildDiscordPayload(
    {
      kind: 'tracked',
      bookMeta: { name: 'Betr', color: 0, boardUrl: 'https://x' },
      props: [prop({ kind: 'tracked', statLabel: 'Takedowns', value: 1.5 })],
    },
    { discord: { mention: '@everyone' } }
  );
  assert.match(p.content, /@everyone/);
});

test('a sig strikes move is not titled a fantasy move', () => {
  const t = titleOf('move', [
    prop({ kind: 'tracked', statLabel: 'Sig Strikes', value: 42.5, previousValue: 45.5 }),
  ]);
  assert.match(t, /sig strikes line move/);
  assert.doesNotMatch(t, /fantasy/i);
});

test('a fantasy move is still titled a fantasy move', () => {
  const t = titleOf('move', [fantasyProp({ value: 99.5, previousValue: 94.5 })]);
  assert.match(t, /fantasy line move/);
});

test('a mixed batch is never built in the first place', () => {
  // The split happens upstream in buildAlerts, so the payload never has to
  // guess. This pins the guarantee the naming depends on.
  const result = {
    newProps: [
      fantasyProp({ fighter: 'Umar' }),
      prop({ kind: 'tracked', statLabel: 'Takedowns', fighter: 'Gomes', value: 1.5 }),
    ],
    moved: [
      fantasyProp({ fighter: 'Tsuruya', value: 99.5, previousValue: 94.5 }),
      prop({ kind: 'tracked', statLabel: 'Sig Strikes', fighter: 'Hasan', value: 42.5, previousValue: 45.5 }),
    ],
  };
  const alerts = buildAlerts(
    { meta: { key: 'betr', name: 'Betr' } },
    result,
    { alertOnFantasy: true, alertOnLineMove: true, lineMoveMinDelta: 0 },
    false
  );
  for (const a of alerts) {
    const kinds = new Set(a.props.map((p) => p.kind));
    assert.equal(kinds.size, 1, `alert "${a.kind}" mixed families: ${[...kinds]}`);
  }
  assert.equal(alerts.length, 4, 'two openings and two moves, split by family');
});

console.log(`\n${passed} passed${process.exitCode ? ', SOME FAILED' : ''}\n`);
