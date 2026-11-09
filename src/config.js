import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const DEFAULTS = {
  discord: {
    webhookUrl: '',
    username: 'UFC Fantasy Alerts',
    // Per-book channel routing: bookKey -> webhook URL. A book with no entry
    // falls back to webhookUrl. The heartbeat and blackout notices always use
    // webhookUrl (the main channel) since they cover every book at once.
    webhooks: {},
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
  // FanDuel Sportsbook is read by a plain headless Chrome; boardFile, when set,
  // reads captured JSON from a file instead. highlight: market names (regex)
  // that get a star when they post.
  // Line moves (Total Rounds 2.5 -> 1.5) and big moneyline swings alert here
  // even when the global alertOnLineMove is off.
  fanduel: {
    boardFile: '',
    highlight: [],
    alertOnLineMove: true,
    alertOnOddsMove: true,
    oddsMoveMinPct: 10,
    oddsMarkets: [],
    // Where the watcher listens for the FanDuel capture extension. 0 = off.
    receiverPort: 47823,
  },
  quietHours: { enabled: false, startHour: 2, endHour: 8 },
  heartbeat: { enabled: true, everyHours: 12 },
};

export async function loadConfig() {
  const path = join(ROOT, 'config.json');
  if (!existsSync(path)) {
    console.warn('[config] config.json not found — using defaults (no Discord webhook).');
    return { ...DEFAULTS, _path: path };
  }
  // Strip a UTF-8 BOM before parsing. Windows editors and PowerShell's
  // `Set-Content -Encoding utf8` prepend one, and JSON.parse rejects it - which
  // is exactly how a hand-edited config.json silently stops the watcher.
  const text = (await readFile(path, 'utf8')).replace(/^﻿/, '');
  const raw = JSON.parse(text);
  return {
    ...DEFAULTS,
    ...raw,
    discord: { ...DEFAULTS.discord, ...(raw.discord || {}) },
    books: { ...DEFAULTS.books, ...(raw.books || {}) },
    betr: { ...DEFAULTS.betr, ...(raw.betr || {}) },
    fanduel: { ...DEFAULTS.fanduel, ...(raw.fanduel || {}) },
    quietHours: { ...DEFAULTS.quietHours, ...(raw.quietHours || {}) },
    heartbeat: { ...DEFAULTS.heartbeat, ...(raw.heartbeat || {}) },
    _path: path,
  };
}

/**
 * The Discord webhook a book's alerts post to: its own channel when mapped under
 * discord.webhooks, else the default webhookUrl (the main channel). Heartbeat and
 * blackout notices are not book-specific, so they use webhookUrl directly.
 */
export function webhookFor(cfg, bookKey) {
  return cfg.discord?.webhooks?.[bookKey] || cfg.discord?.webhookUrl || null;
}

export function inQuietHours(cfg, now = new Date()) {
  const q = cfg.quietHours;
  if (!q?.enabled) return false;
  const h = now.getHours();
  return q.startHour <= q.endHour
    ? h >= q.startHour && h < q.endHour
    : h >= q.startHour || h < q.endHour;
}
