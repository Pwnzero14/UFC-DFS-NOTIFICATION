// Minimal headless-Chrome driver over the DevTools Protocol.
//
// Some books only serve the numbers for whichever tab they render first
// (DraftKings Pick6 does this), so the values behind the other tabs cannot be
// fetched - a real click is required. Rather than pull in Playwright, this
// drives the Chrome that is already installed, over CDP, using Node's built-in
// WebSocket. No dependencies.

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME_CANDIDATES = [
  `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`,
  `${process.env['ProgramFiles(x86)']}\\Google\\Chrome\\Application\\chrome.exe`,
  `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
  `${process.env.ProgramFiles}\\Microsoft\\Edge\\Application\\msedge.exe`,
  `${process.env['ProgramFiles(x86)']}\\Microsoft\\Edge\\Application\\msedge.exe`,
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];

export function findBrowser() {
  return CHROME_CANDIDATES.find((p) => p && existsSync(p)) || null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForDevTools(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return await res.json();
    } catch {
      /* not up yet */
    }
    await sleep(200);
  }
  throw new Error('Chrome DevTools did not become ready');
}

/** CDP command/response plus event subscription over an open socket. */
function makeClient(ws) {
  let nextId = 1;
  const pending = new Map();
  const waiters = [];
  const listeners = new Map(); // method -> [callback]

  ws.addEventListener('message', (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      return;
    }
    if (msg.method) {
      for (const cb of listeners.get(msg.method) || []) {
        try { cb(msg.params); } catch { /* a listener must not kill the socket */ }
      }
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i].method === msg.method) {
          waiters[i].resolve(msg.params);
          waiters.splice(i, 1);
        }
      }
    }
  });

  const send = (method, params = {}, timeoutMs = 30000) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, timeoutMs);
    });

  const once = (method, timeoutMs = 30000) =>
    new Promise((resolve, reject) => {
      const w = { method, resolve };
      waiters.push(w);
      setTimeout(() => {
        const i = waiters.indexOf(w);
        if (i >= 0) {
          waiters.splice(i, 1);
          reject(new Error(`CDP event timeout: ${method}`));
        }
      }, timeoutMs);
    });

  const on = (method, cb) => {
    if (!listeners.has(method)) listeners.set(method, []);
    listeners.get(method).push(cb);
  };

  return { send, once, on };
}

const REAL_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * Start headless Chrome and open one blank tab on it. Returns the CDP client
 * plus a cleanup that always tears the browser and its profile down.
 */
async function openSession({ stealth = false } = {}) {
  const bin = findBrowser();
  if (!bin) throw new Error('no Chrome/Edge install found');

  const port = 9000 + Math.floor(Math.random() * 1000);
  const profile = await mkdtemp(join(tmpdir(), 'ufc-cdp-'));

  const child = spawn(
    bin,
    [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--disable-extensions',
      '--disable-background-networking',
      '--mute-audio',
      '--window-size=1280,2000',
      // Sites behind bot protection fingerprint headless Chrome; these make it
      // look like an ordinary browser session.
      ...(stealth
        ? [
            '--disable-blink-features=AutomationControlled',
            `--user-agent=${REAL_UA}`,
            '--lang=en-US,en',
          ]
        : []),
      'about:blank',
    ],
    { stdio: 'ignore', windowsHide: true }
  );

  let ws;
  const cleanup = async () => {
    try { ws?.close(); } catch { /* ignore */ }
    try { child.kill('SIGTERM'); } catch { /* ignore */ }
    // Chrome can linger; make sure it is gone before removing its profile.
    await sleep(300);
    try { child.kill('SIGKILL'); } catch { /* ignore */ }
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  };

  try {
    await waitForDevTools(port, 20000);

    // Open a blank target first. Navigating afterwards - and waiting for load -
    // avoids evaluating into a context Chrome is about to destroy mid-redirect.
    const targetRes = await fetch(
      `http://127.0.0.1:${port}/json/new?about:blank`,
      { method: 'PUT' }
    );
    if (!targetRes.ok) throw new Error(`could not open target: HTTP ${targetRes.status}`);
    const target = await targetRes.json();

    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('CDP socket failed')), { once: true });
      setTimeout(() => reject(new Error('CDP socket timeout')), 15000);
    });

    const client = makeClient(ws);
    await client.send('Page.enable');
    await client.send('Runtime.enable');

    if (stealth) {
      // navigator.webdriver is the first thing bot checks look at.
      await client.send('Page.addScriptToEvaluateOnNewDocument', {
        source: `
          Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
          Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
          Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
          window.chrome = window.chrome || { runtime: {} };
        `,
      }).catch(() => {});
    }

    return { ...client, cleanup };
  } catch (err) {
    await cleanup();
    throw err;
  }
}

async function navigate({ send, once }, url) {
  const loaded = once('Page.loadEventFired', 45000);
  await send('Page.navigate', { url });
  await loaded.catch(() => {}); // proceed on timeout; the script polls anyway
  await sleep(1200); // let the SPA hydrate before touching the DOM
}

async function evaluate({ send }, expression, timeoutMs) {
  // A site that redirects after load (Betr bounces logged-out visitors) tears
  // down the execution context mid-evaluate. Settle and try once more against
  // wherever it ended up rather than failing the whole poll.
  let result;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      result = await send(
        'Runtime.evaluate',
        { expression, awaitPromise: true, returnByValue: true },
        timeoutMs
      );
      break;
    } catch (err) {
      const transient = /navigated or closed|context was destroyed/i.test(err.message);
      if (!transient || attempt === 1) throw err;
      await sleep(3000);
    }
  }

  if (result.exceptionDetails) {
    throw new Error(
      `page script threw: ${result.exceptionDetails.exception?.description || 'unknown'}`
    );
  }
  return result.result?.value;
}

/**
 * Load `url` in headless Chrome, run `pageFunction` (an IIFE source string that
 * may await), and return its value. Always tears the browser down.
 */
export async function evaluateOnPage(
  url,
  pageFunction,
  { timeoutMs = 60000, stealth = false } = {}
) {
  const session = await openSession({ stealth });
  try {
    await navigate(session, url);
    return await evaluate(session, pageFunction, timeoutMs);
  } finally {
    await session.cleanup();
  }
}

/**
 * Drive one plain headless browser across several pages and keep the JSON the
 * pages fetch for their own display.
 *
 * Some books paint their board from JSON the page requests itself, and that
 * JSON is far more reliable to read than the obfuscated DOM it lands in. This
 * records every response whose URL matches `capture` while `fn` runs.
 *
 * `fn` receives { goto(url), evaluate(src, timeoutMs), settle(), responses },
 * where `responses` is the live array of { url, json } captured so far.
 */
export async function browseSession(fn, { capture } = {}) {
  const session = await openSession();
  const responses = [];
  const wanted = new Map(); // requestId -> url
  const inflight = new Set();

  try {
    await session.send('Network.enable', {
      maxTotalBufferSize: 100_000_000,
      maxResourceBufferSize: 20_000_000,
    });
    session.on('Network.responseReceived', (p) => {
      if (capture?.test(p.response?.url || '')) wanted.set(p.requestId, p.response.url);
    });
    session.on('Network.loadingFinished', (p) => {
      const url = wanted.get(p.requestId);
      if (!url) return;
      wanted.delete(p.requestId);
      const job = session
        .send('Network.getResponseBody', { requestId: p.requestId })
        .then(({ body, base64Encoded }) => {
          const text = base64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body;
          responses.push({ url, json: JSON.parse(text) });
        })
        .catch(() => { /* not JSON, or evicted - nothing to keep */ })
        .finally(() => inflight.delete(job));
      inflight.add(job);
    });

    // Wait until every captured body that has finished loading has been read.
    const settle = async () => {
      await sleep(300);
      while (inflight.size) await Promise.allSettled([...inflight]);
    };

    const value = await fn({
      goto: (url) => navigate(session, url),
      evaluate: (src, timeoutMs = 60000) => evaluate(session, src, timeoutMs),
      settle,
      responses,
    });
    await settle();
    return value;
  } finally {
    await session.cleanup();
  }
}
