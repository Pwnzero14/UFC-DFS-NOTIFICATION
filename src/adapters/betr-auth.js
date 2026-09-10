// Betr auth: turn a one-time refresh token into a live access token, forever.
//
// Betr closed its board to anonymous callers on 2026-09-07. Every request now
// needs `Authorization: Bearer <access token>`, and access tokens are minted
// per user and expire in minutes - pasting one lasts until lunch.
//
// The way out is the refresh token. Betr's own login asks Keycloak for
// `offline_access`, which issues a refresh token that does not die from
// inactivity, and `betr-rn` is a public client (no secret) whose token endpoint
// accepts the refresh_token grant. So the watcher holds ONE refresh token and
// trades it for a new access token whenever the old one is near expiry - no
// human after the first grab, and because it refreshes every few minutes the
// offline session's idle clock never runs down.
//
// The one operational detail that matters: Keycloak rotates the refresh token
// on every use. Each refresh hands back a NEW refresh token and invalidates the
// one just spent. Miss a single rotation and the chain is broken and the user
// has to grab a fresh token by hand - the exact thing this exists to avoid. So
// a rotated token is persisted to config.json before its access token is ever
// returned, and that write has to succeed.

import { readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { ROOT } from '../config.js';

const TOKEN_URL =
  'https://account.betr.app/realms/betr/protocol/openid-connect/token';
const CLIENT_ID = 'betr-rn';
const CONFIG_PATH = join(ROOT, 'config.json');

// Refresh a little before the access token actually expires, so a poll never
// races the clock and fires with a token that died in flight.
const EXPIRY_SKEW_MS = 30_000;

// Access token cached in memory across polls; the refresh token lives in
// config.json (rotated), so a restart resumes without re-grabbing anything.
let cached = null; // { accessToken, expiresAt }

/** Test seam: swap the network and the persistence in unit tests. */
export function _reset() {
  cached = null;
}

/**
 * A valid Bearer access token, or null if no refresh token is configured.
 * Throws with an actionable message when a configured token is rejected.
 *
 * @param {() => Promise<object>} loadConfig  the app's config loader
 * @param {object} [io]  { fetch, persist } - injected in tests
 */
export async function betrAccessToken(loadConfig, io = {}) {
  const doFetch = io.fetch || fetch;
  const persist = io.persist || persistRefreshToken;

  const now = Date.now();
  if (cached && cached.expiresAt - EXPIRY_SKEW_MS > now) return cached.accessToken;

  const cfg = await loadConfig();
  const refreshToken = String(cfg.betr?.refreshToken || '').trim();
  if (!refreshToken) return null; // not configured - caller falls back to none

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: CLIENT_ID,
    refresh_token: refreshToken,
    scope: 'openid offline_access',
  });

  const res = await doFetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    // invalid_grant means the refresh token is spent, revoked, or expired -
    // the chain is broken and only a human can restart it.
    if (/invalid_grant/.test(text)) {
      cached = null;
      throw new Error(
        'Betr refresh token is no longer valid - re-grab it from the app ' +
          '(betr.refreshToken in config.json)'
      );
    }
    throw new Error(`Betr token refresh failed: HTTP ${res.status}`);
  }

  const tok = await res.json();
  if (!tok.access_token) throw new Error('Betr token refresh returned no access_token');

  // Persist the rotated refresh token BEFORE handing back the access token.
  // If this write fails we must not proceed, or the next poll refreshes with a
  // token Keycloak has already invalidated and the whole chain dies silently.
  if (tok.refresh_token && tok.refresh_token !== refreshToken) {
    await persist(tok.refresh_token);
  }

  cached = {
    accessToken: tok.access_token,
    expiresAt: now + (Number(tok.expires_in) || 300) * 1000,
  };
  return cached.accessToken;
}

/**
 * Write a rotated refresh token back into config.json, preserving everything
 * else. Atomic via temp+rename so a crash mid-write cannot corrupt the config
 * and strand the webhook with it.
 */
async function persistRefreshToken(newToken) {
  const raw = JSON.parse(await readFile(CONFIG_PATH, 'utf8'));
  raw.betr = { ...(raw.betr || {}), refreshToken: newToken };
  const json = JSON.stringify(raw, null, 2) + '\n';
  const tmp = `${CONFIG_PATH}.tmp`;
  await writeFile(tmp, json, 'utf8');
  await rename(tmp, CONFIG_PATH);
}
