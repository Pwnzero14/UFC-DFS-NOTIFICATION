// Shared HTTP layer: browser-ish headers, gzip, timeouts, retries, 429 backoff.

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export class HttpError extends Error {
  constructor(status, body, url) {
    super(`HTTP ${status} for ${url}`);
    this.status = status;
    this.body = body;
    this.url = url;
  }
}

function baseHeaders(extra = {}) {
  return {
    'User-Agent': UA,
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'sec-ch-ua': '"Chromium";v="131", "Not_A Brand";v="24"',
    'sec-ch-ua-platform': '"Windows"',
    ...extra,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Fetch with retries. Throws HttpError on non-2xx after retries are exhausted.
 * A 429 surfaces `retryAfterMs` so the caller can park that adapter.
 */
export async function request(url, opts = {}) {
  const {
    method = 'GET',
    headers = {},
    body,
    timeoutMs = 30000,
    retries = 2,
    retryDelayMs = 1500,
  } = opts;

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        headers: baseHeaders(headers),
        body,
        signal: ctl.signal,
        redirect: 'follow',
      });

      if (res.status === 429 || res.status === 503) {
        const ra = Number(res.headers.get('retry-after'));
        const err = new HttpError(res.status, await safeText(res), url);
        err.retryAfterMs = Number.isFinite(ra) && ra > 0 ? ra * 1000 : null;
        throw err;
      }
      if (!res.ok) throw new HttpError(res.status, await safeText(res), url);
      return res;
    } catch (err) {
      lastErr = err;
      // Do not burn retries against a rate limiter.
      if (err instanceof HttpError && err.status === 429) break;
      if (attempt < retries) await sleep(retryDelayMs * (attempt + 1));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

async function safeText(res) {
  try {
    return (await res.text()).slice(0, 400);
  } catch {
    return '';
  }
}

export async function getJson(url, opts = {}) {
  const res = await request(url, opts);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    // Cloudflare / DataDome interstitials come back as HTML with a 200.
    throw new HttpError(
      res.status,
      text.slice(0, 300),
      `${url} (expected JSON, got ${res.headers.get('content-type') || 'unknown'})`
    );
  }
}

export async function getText(url, opts = {}) {
  const res = await request(url, opts);
  return res.text();
}

export async function postJson(url, payload, opts = {}) {
  return getJson(url, {
    ...opts,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    body: JSON.stringify(payload),
  });
}
