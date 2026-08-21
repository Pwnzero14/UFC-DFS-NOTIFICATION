// Durable seen-prop store. Atomic writes so a crash mid-save can't corrupt it.

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';

const EMPTY = { version: 1, initialized: false, books: {}, lastRun: null };

export async function load(path) {
  if (!existsSync(path)) return structuredClone(EMPTY);
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    return { ...structuredClone(EMPTY), ...parsed };
  } catch {
    console.warn(`[state] ${path} unreadable, starting fresh`);
    return structuredClone(EMPTY);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Atomic-ish save that tolerates the file briefly being held open.
 *
 * The rename can fail with EPERM/EBUSY when something else has state.json open
 * at that instant - the tray widget polls it, and OneDrive syncs this folder.
 * That killed the watcher once. A save is never worth crashing over: retry the
 * rename, then fall back to writing in place, and let the caller carry on
 * either way.
 */
export async function save(path, state) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  const json = JSON.stringify(state, null, 2);
  await writeFile(tmp, json, 'utf8');

  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await rename(tmp, path);
      return;
    } catch (err) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(err.code) || attempt === 4) {
        // Last resort: write straight to the target. Less atomic, but a
        // momentarily torn file beats losing the process.
        try {
          await writeFile(path, json, 'utf8');
          return;
        } catch {
          console.warn(`[state] could not persist (${err.code}) - will retry next cycle`);
          return;
        }
      }
      await sleep(120 * (attempt + 1));
    }
  }
}

// Kinds worth telling you about: fantasy points on the DFS books, and the
// sportsbook markets we were explicitly asked to watch. Both alert on a new
// line and on a line move; everything else is tracked but stays quiet.
export const ALERTING_KINDS = new Set(['fantasy', 'tracked']);

export function propKey(prop) {
  // `variant` separates board entries that share a fighter+stat but are
  // genuinely different offers (PrizePicks demon/goblin, alternate lines).
  // It must be stable across polls, so it never includes the line value.
  return [
    prop.book,
    prop.event || '-',
    prop.fighter || '-',
    prop.statKey,
    prop.variant || '-',
  ]
    .join('|')
    .toLowerCase();
}

/**
 * Compare a fresh poll against what we've already seen for that book.
 * Returns the props that are genuinely new, plus line moves on fantasy props.
 */
export function diff(state, book, props) {
  const seen = state.books[book]?.props || {};
  const fresh = {};
  const newProps = [];
  const moved = [];

  for (const prop of props) {
    const key = propKey(prop);
    const prior = seen[key];
    fresh[key] = { value: prop.value, kind: prop.kind, statLabel: prop.statLabel };

    if (!prior) {
      newProps.push(prop);
    } else if (
      ALERTING_KINDS.has(prop.kind) &&
      prior.value != null &&
      prop.value != null &&
      prior.value !== prop.value
    ) {
      moved.push({ ...prop, previousValue: prior.value });
    }
  }

  const removed = Object.keys(seen).filter((k) => !(k in fresh)).length;
  return { newProps, moved, fresh, removed };
}

// How many consecutive polls a prop may be absent before we forget it.
// Books drop props from their feed transiently - Betr's per-event queries fail
// individually, boards get rebuilt mid-refresh - and forgetting a prop the
// moment it blinks out is destructive: when it returns at a NEW value there is
// no stored value to compare against, so a line MOVE is misreported as a brand
// new prop. Carrying it for a few polls keeps move detection intact.
const MAX_MISSES = 5;

export function commit(state, book, fresh, ok = true) {
  const prior = state.books[book]?.props || {};
  const merged = {};

  // Everything seen this poll, with its miss counter cleared.
  for (const [k, v] of Object.entries(fresh)) {
    const { misses, ...rest } = v;
    merged[k] = rest;
  }

  // Props absent this poll: keep their last known value for a while.
  for (const [k, v] of Object.entries(prior)) {
    if (k in merged) continue;
    const misses = (v.misses || 0) + 1;
    if (misses < MAX_MISSES) merged[k] = { ...v, misses };
  }

  state.books[book] = {
    props: merged,
    updatedAt: new Date().toISOString(),
    healthy: ok,
  };
}
