// Detection tests. All synthetic - no live API calls, so this is safe to run
// repeatedly without tripping any book's rate limiter.

import assert from 'node:assert/strict';
import * as store from '../src/state.js';
import { classify } from '../src/fantasy.js';
import { buildDiscordPayload, moveDelta, buildHeartbeatPayload } from '../src/notify.js';

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
  assert.equal(classify('underdog', 'Significant Strikes'), 'known');
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

console.log(`\n${passed} passed${process.exitCode ? ', SOME FAILED' : ''}\n`);
