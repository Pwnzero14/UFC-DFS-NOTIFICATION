// Keeps the latest copy of each FanDuel odds response from your open tabs and
// posts the set to the watcher's receiver on 127.0.0.1. Optionally reloads open
// FanDuel UFC tabs on a timer so new props show up while you are away.

const DEFAULTS = { port: 47823, refreshMinutes: 5 };
const MAX_AGE_MS = 20 * 60_000; // a closed tab's odds age out of the board

const latest = new Map(); // url (minus cache-busters) -> { url, page, json, at }
let timer = null;

const settings = async () => ({ ...DEFAULTS, ...(await chrome.storage.local.get(DEFAULTS)) });

function keyFor(url) {
  try {
    const u = new URL(url);
    for (const p of ['_', '_ak', 'timezone']) u.searchParams.delete(p);
    return u.toString();
  } catch {
    return url;
  }
}

async function post() {
  timer = null;
  const now = Date.now();
  for (const [k, v] of latest) if (now - v.at > MAX_AGE_MS) latest.delete(k);

  const entries = [...latest.values()];
  const responses = entries.map(({ url, json }) => ({ url, json }));
  const fights = [...new Set(entries.map((v) => v.page.split(/[?#]/)[0]))].filter((u) => /-\d{6,}$/.test(u));
  const { port } = await settings();

  let lastPost;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/fanduel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ capturedAt: new Date().toISOString(), responses, fights }),
    });
    lastPost = { at: now, ok: res.ok, error: res.ok ? null : `watcher answered HTTP ${res.status}`, count: responses.length, fights: fights.length };
  } catch {
    lastPost = { at: now, ok: false, error: 'watcher not reachable - is it running?', count: responses.length, fights: fights.length };
  }
  await chrome.storage.local.set({ lastPost });
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type !== 'fanduel-response' || !msg.json) return;
  latest.set(keyFor(msg.url), { url: msg.url, page: msg.page || '', json: msg.json, at: Date.now() });
  // A page load fires several requests at once; send them as one batch.
  if (!timer) timer = setTimeout(post, 2000);
});

async function scheduleRefresh() {
  const { refreshMinutes } = await settings();
  await chrome.alarms.clear('refresh');
  if (refreshMinutes > 0) chrome.alarms.create('refresh', { periodInMinutes: Math.max(1, refreshMinutes) });
}

chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name !== 'refresh') return;
  const tabs = await chrome.tabs.query({
    url: ['https://sportsbook.fanduel.com/mma/*', 'https://sportsbook.fanduel.com/navigation/ufc*'],
  });
  for (const t of tabs) chrome.tabs.reload(t.id).catch(() => {});
});

chrome.storage.onChanged.addListener((c) => { if (c.refreshMinutes) scheduleRefresh(); });
chrome.runtime.onInstalled.addListener(scheduleRefresh);
chrome.runtime.onStartup.addListener(scheduleRefresh);
