import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const DEFAULTS = {
  discord: {
    webhookUrl: '',
    username: 'UFC Fantasy Alerts',
    mention: '@everyone',
    mentionOnLineMove: false,
  },
  windowsToast: true,
  pollSeconds: 60,
  alertOnFantasy: true,
  alertOnUnknownStat: true,
  alertOnLineMove: true,
  lineMoveMinDelta: 0,
  alertOnFirstRun: false,
  books: { underdog: true, prizepicks: true, betr: true, pick6: true },
  // Betr closed its GraphQL endpoint to anonymous callers on 2026-09-07: the
  // gateway answers 401 before any query runs, so there is no query shape or
  // header that gets in. Paste a bearer token here and the adapter sends it.
  // Read fresh every poll, so a token can be added without a restart.
  betr: { authToken: '' },
  quietHours: { enabled: false, startHour: 2, endHour: 8 },
  heartbeat: { enabled: true, everyHours: 12 },
};

export async function loadConfig() {
  const path = join(ROOT, 'config.json');
  if (!existsSync(path)) {
    console.warn('[config] config.json not found — using defaults (no Discord webhook).');
    return { ...DEFAULTS, _path: path };
  }
  const raw = JSON.parse(await readFile(path, 'utf8'));
  return {
    ...DEFAULTS,
    ...raw,
    discord: { ...DEFAULTS.discord, ...(raw.discord || {}) },
    books: { ...DEFAULTS.books, ...(raw.books || {}) },
    betr: { ...DEFAULTS.betr, ...(raw.betr || {}) },
    quietHours: { ...DEFAULTS.quietHours, ...(raw.quietHours || {}) },
    heartbeat: { ...DEFAULTS.heartbeat, ...(raw.heartbeat || {}) },
    _path: path,
  };
}

export function inQuietHours(cfg, now = new Date()) {
  const q = cfg.quietHours;
  if (!q?.enabled) return false;
  const h = now.getHours();
  return q.startHour <= q.endHour
    ? h >= q.startHour && h < q.endHour
    : h >= q.startHour || h < q.endHour;
}
