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

export async function save(path, state) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
  await rename(tmp, path);
}

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
      prop.kind === 'fantasy' &&
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

export function commit(state, book, fresh, ok = true) {
  state.books[book] = {
    props: fresh,
    updatedAt: new Date().toISOString(),
    healthy: ok,
  };
}
