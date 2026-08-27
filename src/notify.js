// Delivery: console, Discord webhook, Windows toast.

import { execFile } from 'node:child_process';
import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { request } from './http.js';

const fmt = (v) => (v == null ? '—' : String(v));

/** Control Time is stored as seconds so moves can be compared; show it back
 *  as mm:ss, which is how the book displays it. */
const asClock = (secs) => {
  const n = Math.round(Number(secs));
  if (!Number.isFinite(n)) return fmt(secs);
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`;
};

const shown = (p, v) => (p?.unit === 'time' ? asClock(v) : fmt(v));

function fightTime(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? null
    : `<t:${Math.floor(d.getTime() / 1000)}:F>`;
}

/** Group props by event so one embed covers one fight card. */
function groupByEvent(props) {
  const map = new Map();
  for (const p of props) {
    const k = p.event || 'Upcoming';
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(p);
  }
  return map;
}

/** "+2.51" / "-1.00" with a direction arrow. Time markets read in seconds. */
export function moveDelta(from, to, unit) {
  const d = Number(to) - Number(from);
  const arrow = d > 0 ? '🔺' : '🔻';
  const sign = d > 0 ? '+' : '';
  return unit === 'time'
    ? `${arrow} ${sign}${Math.round(d)}s`
    : `${arrow} ${sign}${d.toFixed(2)}`;
}

export function buildDiscordPayload(alert, cfg) {
  const { bookMeta, kind, props } = alert;
  // A market opening is a drop whether it is fantasy or one of the markets we
  // asked to watch. Both are worth the same siren and the same mention; they
  // differ only in what they get called.
  const isDrop = kind === 'fantasy' || kind === 'tracked';
  const isMove = kind === 'move';

  // Name the actual market: "FANTASY PROPS" is wrong for a sportsbook O/U, and
  // wrong for a takedown line. Alerts arrive split by market family, so these
  // describe what is genuinely in this batch rather than guessing at whichever
  // family happened to come first.
  const stats = [...new Set(props.map((p) => p.statLabel).filter(Boolean))];
  const anyFantasy = stats.some((s) => /fantasy/i.test(s));
  const marketName = anyFantasy
    ? 'FANTASY PROPS'
    : stats.length === 1
      ? stats[0].toUpperCase()
      : stats.length === 2
        ? stats.map((s) => s.toUpperCase()).join(' & ')
        : 'PROPS';
  // "FANTASY PROPS line moves" reads badly, and so does shouting mid-sentence.
  const movedMarket = anyFantasy
    ? 'fantasy'
    : stats.length && stats.length <= 2
      ? stats.join(' & ').toLowerCase()
      : '';

  const title = isDrop
    ? `🚨 ${bookMeta.name} — UFC ${marketName} ARE UP`
    : isMove
      ? `📈 ${bookMeta.name} — ${movedMarket ? `${movedMarket} ` : ''}line ${props.length === 1 ? 'move' : 'moves'}`
      : `👀 ${bookMeta.name} — new UFC market: ${props[0]?.statLabel}`;

  const groups = groupByEvent(props);

  // Two reasons to render a flat list instead of one embed per fight:
  //   - Discord hard-caps a message at 10 embeds, so more than that silently
  //     loses lines (a 26-fighter fantasy drop would lose 16).
  //   - Even under the cap, one embed per fight is unreadable when most fights
  //     contribute a single line. Ten Control Time props became nine stacked
  //     embeds, and only the first was visible without scrolling.
  // An embed per fight only earns its space when fights actually group.
  const mostlySingletons = groups.size >= 4 && props.length / groups.size < 1.5;
  if (groups.size > 10 || mostlySingletons) {
    const flat = [...props].sort((a, b) => (Number(b.value) || 0) - (Number(a.value) || 0));
    const embeds = [];
    for (let i = 0; i < flat.length; i += 24) {
      const slice = flat.slice(i, i + 24);
      embeds.push({
        title: i === 0 ? `${props.length} lines` : `…continued`,
        description: slice
          .map((p) => {
            const who = p.fighter ? `**${p.fighter}**` : '*(market)*';
            return p.previousValue != null && p.value != null
              ? `${who} \`${shown(p, p.previousValue)}\` → \`${shown(p, p.value)}\` ${moveDelta(p.previousValue, p.value, p.unit)}`
              : `${who} — \`${shown(p, p.value)}\``;
          })
          .join('\n'),
        color: bookMeta.color,
        url: bookMeta.boardUrl,
        footer: { text: `${bookMeta.name} • ${props[0]?.statLabel || ''}` },
        timestamp: new Date().toISOString(),
      });
    }
    const mention = cfg.discord?.mention || '';
    const ping = isDrop || (isMove && cfg.discord?.mentionOnLineMove === true);
    return {
      username: cfg.discord?.username || 'UFC Fantasy Alerts',
      content: ping && mention ? `${mention} ${title}`.trim() : title,
      embeds: embeds.slice(0, 10),
      allowed_mentions: { parse: ['everyone', 'roles', 'users'] },
    };
  }

  const embeds = [];
  for (const [event, list] of groups) {
    const lines = list.slice(0, 24).map((p) => {
      // A market we can see is open but whose numbers the book won't serve.
      if (p.note) return `**${p.statLabel}** — ${p.note}`;

      const who = p.fighter ? `**${p.fighter}**` : '*(market opened)*';
      if (p.previousValue != null && p.value != null) {
        return `${who} — ${p.statLabel} \`${shown(p, p.previousValue)}\` → \`${shown(p, p.value)}\` ${moveDelta(p.previousValue, p.value, p.unit)}`;
      }
      return `${who} — ${p.statLabel} \`${shown(p, p.value)}\``;
    });

    const when = fightTime(list[0]?.startsAt);
    embeds.push({
      title: event,
      description: lines.join('\n') || '_no readable lines yet_',
      color: bookMeta.color,
      url: bookMeta.boardUrl,
      fields: when ? [{ name: 'Starts', value: when, inline: true }] : [],
      footer: { text: `${bookMeta.name} • ${list.length} prop(s)` },
      timestamp: new Date().toISOString(),
    });
  }

  // The drop is the thing worth waking you up for. Line moves are frequent once
  // a board is live, so they post without a mention unless you ask for one -
  // an @everyone on every half-point wiggle just gets the channel muted.
  const mention = cfg.discord?.mention || '';
  const shouldPing =
    isDrop || (isMove && cfg.discord?.mentionOnLineMove === true);

  return {
    username: cfg.discord?.username || 'UFC Fantasy Alerts',
    content: shouldPing && mention ? `${mention} ${title}`.trim() : title,
    embeds: embeds.slice(0, 10), // Discord caps embeds per message
    allowed_mentions: { parse: ['everyone', 'roles', 'users'] },
  };
}

/**
 * "Still alive" status post. The point is to make silence meaningful: if these
 * stop arriving, the watcher is down, rather than you assuming the lines just
 * haven't posted yet. Never pings.
 */
export function buildHeartbeatPayload(state, cfg, books, uptimeMs) {
  const rows = [];
  let anyUnhealthy = false;

  for (const meta of books) {
    const entry = state.books?.[meta.key];
    if (!entry) {
      rows.push(`⚪ **${meta.name}** — no data yet`);
      anyUnhealthy = true;
      continue;
    }
    const props = Object.values(entry.props || {});
    const fantasy = props.filter((p) => p.kind === 'fantasy').length;
    const ok = entry.healthy !== false;
    if (!ok) anyUnhealthy = true;

    const age = entry.updatedAt
      ? `<t:${Math.floor(new Date(entry.updatedAt).getTime() / 1000)}:R>`
      : 'unknown';

    rows.push(
      `${ok ? '🟢' : '🔴'} **${meta.name}** — ${props.length} props, ` +
        (fantasy ? `**${fantasy} FANTASY**` : 'no fantasy yet') +
        ` · ${age}`
    );
  }

  // A manual `--heartbeat` runs in its own short-lived process, so its uptime
  // is meaningless - pass null rather than reporting a bogus "up 0h 0m".
  const uptime =
    uptimeMs == null
      ? 'manual check'
      : `up ${Math.floor(uptimeMs / 3_600_000)}h ${Math.floor((uptimeMs % 3_600_000) / 60_000)}m`;

  return {
    username: cfg.discord?.username || 'UFC Fantasy Alerts',
    content: anyUnhealthy
      ? '⚠️ Watcher heartbeat — a book is unhealthy'
      : '💚 Watcher heartbeat — all books healthy',
    embeds: [
      {
        title: 'Still watching for UFC fantasy props',
        description: rows.join('\n'),
        color: anyUnhealthy ? 0xe67e22 : 0x2ecc71,
        footer: { text: `${uptime} · alerts fire within ~60s of a drop` },
        timestamp: new Date().toISOString(),
      },
    ],
    // A status ping is never worth an @everyone.
    allowed_mentions: { parse: [] },
  };
}

/** "10h 51m", "43m", "12m" - no bogus "0h" on a short gap. */
export function humanDuration(ms) {
  const mins = Math.round(ms / 60_000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h ? `${h}h ${m}m` : `${m}m`;
}

/**
 * "The watcher was not running for a while" notice.
 *
 * Alerts are not lost across a blackout - on the next poll the diff still sees
 * the change and fires - so the damage is not silence, it is staleness. A drop
 * that happened while the machine slept arrives whenever it wakes, looking
 * exactly like a drop that just happened. This posts first so the catch-up
 * alerts behind it have context: the line has been live a while, and the number
 * may well have moved again since.
 *
 * Never pings, same as the heartbeat - by the time this can be read the machine
 * is awake and its owner is in front of it.
 */
export function buildBlackoutPayload(cfg, { from, to, ms }) {
  const stamp = (t) => `<t:${Math.floor(t / 1000)}:t>`;
  return {
    username: cfg.discord?.username || 'UFC Fantasy Alerts',
    content: `🌙 Watcher was dark for ${humanDuration(ms)}`,
    embeds: [
      {
        title: 'Anything below may be late',
        description:
          `No polling between ${stamp(from)} and ${stamp(to)}.\n` +
          'Lines that moved in that window are detected on the next poll, so ' +
          'any alert that follows this is real but may be stale - check the ' +
          'board before acting on it.',
        color: 0x9b59b6,
        footer: { text: 'usually means the machine slept - locking is fine, sleeping is not' },
        timestamp: new Date().toISOString(),
      },
    ],
    allowed_mentions: { parse: [] },
  };
}

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Post to Discord, honouring its rate limit.
 *
 * Discord allows roughly 5 requests per 2s per webhook and answers 429 with a
 * Retry-After. The shared HTTP layer deliberately does NOT retry 429s - that is
 * right for the books, where backing off is the correct response, but for
 * Discord it means silently dropping an alert. So retry here instead.
 */
export async function sendDiscord(webhookUrl, payload, { attempts = 4 } = {}) {
  if (!webhookUrl) return { skipped: 'no webhook configured' };

  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await request(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        retries: 1,
      });
      return { status: res.status };
    } catch (err) {
      lastErr = err;
      if (err.status === 429) {
        // Retry-After is seconds; give it a beat more than asked for.
        await sleepMs((err.retryAfterMs || 2000) + 250);
        continue;
      }
      if (err.status >= 500 || !err.status) {
        await sleepMs(1000 * (i + 1));
        continue;
      }
      throw err; // 4xx that isn't 429 will not fix itself
    }
  }
  throw lastErr;
}

/** Native Windows 10/11 toast. Best-effort: never throws into the poll loop. */
export async function sendWindowsToast(title, message) {
  if (process.platform !== 'win32') return { skipped: 'not windows' };
  const esc = (s) =>
    String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .slice(0, 250);

  const script = `
$ErrorActionPreference = 'Stop'
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType=WindowsRuntime] | Out-Null
$xml = @"
<toast activationType="protocol" launch="${esc('https://underdogfantasy.com')}">
  <visual><binding template="ToastGeneric">
    <text>${esc(title)}</text>
    <text>${esc(message)}</text>
  </binding></visual>
  <audio src="ms-winsoundevent:Notification.Looping.Alarm2"/>
</toast>
"@
$doc = New-Object Windows.Data.Xml.Dom.XmlDocument
$doc.LoadXml($xml)
$toast = New-Object Windows.UI.Notifications.ToastNotification $doc
# Windows only renders toasts for a registered AppUserModelID. PowerShell's own
# shortcut ID is always present on Win10/11, so borrow it rather than shipping
# an installer just to register our own.
$appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}' + [char]92 + 'WindowsPowerShell' + [char]92 + 'v1.0' + [char]92 + 'powershell.exe'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)
`;

  const file = join(tmpdir(), `ufc-toast-${randomUUID()}.ps1`);
  try {
    await writeFile(file, script, 'utf8');
    await new Promise((resolve, reject) => {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file],
        { timeout: 15000 },
        (err, _out, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve())
      );
    });
    return { ok: true };
  } catch (err) {
    return { error: err.message.split('\n')[0] };
  } finally {
    unlink(file).catch(() => {});
  }
}

const TAGS = {
  fantasy: '\x1b[42m\x1b[30m FANTASY \x1b[0m',
  // A watched market opening is a drop too, just not the one being waited for.
  tracked: '\x1b[45m\x1b[30m MARKET  \x1b[0m',
  move: '\x1b[46m\x1b[30m  MOVE   \x1b[0m',
  unknown: '\x1b[43m\x1b[30m NEW STAT \x1b[0m',
};

export function logAlert(alert) {
  const tag = TAGS[alert.kind] || TAGS.unknown;
  console.log(`\n${tag} ${alert.bookMeta.name} — ${alert.props.length} prop(s)`);
  for (const p of alert.props.slice(0, 15)) {
    const moved = p.previousValue != null && p.value != null;
    const detail = moved
      ? `${fmt(p.previousValue)} -> ${fmt(p.value)}  (${Number(p.value) > Number(p.previousValue) ? '+' : ''}${(Number(p.value) - Number(p.previousValue)).toFixed(2)})`
      : fmt(p.value);
    console.log(
      `   ${(p.fighter || '(market)').padEnd(24)} ${p.statLabel.padEnd(22)} ${detail}`
    );
  }
  if (alert.props.length > 15) console.log(`   …and ${alert.props.length - 15} more`);
  process.stdout.write('\x07'); // terminal bell
}
