// One-off maintenance: strip PrizePicks props stored as `known` from state.json
// so a classification change re-detects them as new on the next poll.
//
// Why this exists: propKey excludes kind, so when a market that was `known`
// starts classifying `tracked` (e.g. demon/goblin-only knockdowns, once the
// standard-offer rule landed), the existing prop just reclassifies in place -
// and a reclassification never alerts (state.js diff only fires on a NEW key or
// a value move). Removing the `known` entries makes the promoted ones read as
// new `tracked` props, which do ping. It is safe: a new `known` prop does not
// alert either (alerts.js filters newProps to fantasy/tracked), so the entries
// that stay `known` re-detect silently and only the flipped ones ping.
//
// MUST run while the watcher is stopped - it loads state once at startup and
// writes from memory each cycle, so a live edit is clobbered. resync-prizepicks.ps1
// sequences the stop, this strip, and the start.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const path = join(root, 'state.json');

const raw = readFileSync(path, 'utf8').replace(/^﻿/, '');
const state = JSON.parse(raw);
const pp = state.books?.prizepicks;

if (!pp?.props) {
  console.log('no prizepicks props in state - nothing to strip');
  process.exit(0);
}

let stripped = 0;
for (const key of Object.keys(pp.props)) {
  if (pp.props[key].kind === 'known') {
    delete pp.props[key];
    stripped++;
  }
}

writeFileSync(path, JSON.stringify(state));
console.log(`stripped ${stripped} prizepicks 'known' props - the promoted ones re-detect and ping on the next PrizePicks poll (up to 5 min)`);
