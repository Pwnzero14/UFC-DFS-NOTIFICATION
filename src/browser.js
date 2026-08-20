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

  return { send, once };
}

/**
 * Load `url` in headless Chrome, run `pageFunction` (an IIFE source string that
 * may await), and return its value. Always tears the browser down.
 */
const REAL_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export async function evaluateOnPage(
  url,
  pageFunction,
  { timeoutMs = 60000, stealth = false } = {}
) {
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

    const { send, once } = makeClient(ws);
    await send('Page.enable');
    await send('Runtime.enable');

    if (stealth) {
      // navigator.webdriver is the first thing bot checks look at.
      await send('Page.addScriptToEvaluateOnNewDocument', {
        source: `
          Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
          Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
          Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
          window.chrome = window.chrome || { runtime: {} };
        `,
      }).catch(() => {});
    }

    const loaded = once('Page.loadEventFired', 45000);
    await send('Page.navigate', { url });
    await loaded.catch(() => {}); // proceed on timeout; the script polls anyway
    await sleep(1200); // let the SPA hydrate before touching the DOM

    const result = await send(
      'Runtime.evaluate',
      { expression: pageFunction, awaitPromise: true, returnByValue: true },
      timeoutMs
    );

    if (result.exceptionDetails) {
      throw new Error(
        `page script threw: ${result.exceptionDetails.exception?.description || 'unknown'}`
      );
    }
    return result.result?.value;
  } finally {
    await cleanup();
  }
}
