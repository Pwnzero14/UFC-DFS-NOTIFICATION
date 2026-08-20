// Delivery: console, Discord webhook, Windows toast.

import { execFile } from 'node:child_process';
import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { request } from './http.js';

const fmt = (v) => (v == null ? '—' : String(v));

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

/** "+2.51" / "-1.00" with a direction arrow. */
export function moveDelta(from, to) {
  const d = Number(to) - Number(from);
  const arrow = d > 0 ? '🔺' : '🔻';
  const sign = d > 0 ? '+' : '';
  return `${arrow} ${sign}${d.toFixed(2)}`;
}

export function buildDiscordPayload(alert, cfg) {
  const { bookMeta, kind, props } = alert;
  const isFantasy = kind === 'fantasy';
  const isMove = kind === 'move';

  const title = isFantasy
    ? `🚨 ${bookMeta.name} — UFC FANTASY PROPS ARE UP`
    : isMove
      ? `📈 ${bookMeta.name} — fantasy line ${props.length === 1 ? 'move' : 'moves'}`
      : `👀 ${bookMeta.name} — new UFC market: ${props[0]?.statLabel}`;

  const groups = groupByEvent(props);

  // Discord hard-caps a message at 10 embeds. A big drop (Pick6 posts 26
  // fighters at once) would silently lose everything past the tenth, so when
  // there are too many events, list them flat instead of one embed per fight.
  if (groups.size > 10) {
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
              ? `${who} \`${fmt(p.previousValue)}\` → \`${fmt(p.value)}\` ${moveDelta(p.previousValue, p.value)}`
              : `${who} — \`${fmt(p.value)}\``;
          })
          .join('\n'),
        color: bookMeta.color,
        url: bookMeta.boardUrl,
        footer: { text: `${bookMeta.name} • ${props[0]?.statLabel || ''}` },
        timestamp: new Date().toISOString(),
      });
    }
    const mention = cfg.discord?.mention || '';
    const ping = isFantasy || (isMove && cfg.discord?.mentionOnLineMove === true);
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
        return `${who} — ${p.statLabel} \`${fmt(p.previousValue)}\` → \`${fmt(p.value)}\` ${moveDelta(p.previousValue, p.value)}`;
      }
      return `${who} — ${p.statLabel} \`${fmt(p.value)}\``;
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
    isFantasy || (isMove && cfg.discord?.mentionOnLineMove === true);

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
