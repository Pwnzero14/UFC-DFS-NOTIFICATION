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
  quietHours: { enabled: false, startHour: 2, endHour: 8 },
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
    quietHours: { ...DEFAULTS.quietHours, ...(raw.quietHours || {}) },
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
