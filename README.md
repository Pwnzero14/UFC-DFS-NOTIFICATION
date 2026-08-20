# UFC Fantasy Prop Alerts

Watches **Underdog**, **PrizePicks**, **DraftKings Pick6**, and **Betr** and pings you
the moment UFC **fantasy-point** props go up. Sig strikes, takedowns, total rounds and
the rest are tracked but never alerted on — fantasy only, which is the whole point.

Zero dependencies. Node 18+ (you're on 24).

---

## Quick start

```bash
node src/index.js --status
```

That prints every UFC market currently live on all four books. Then:

```bash
node src/index.js
```

First run records a silent baseline (so you don't get 190 notifications on startup),
then polls forever and alerts on anything new.

---

## Setup

### 1. Discord webhook (optional but recommended)

In your own Discord server: **Server Settings → Integrations → Webhooks → New Webhook**,
pick a channel, **Copy Webhook URL**. Paste it into `config.json`:

```json
{
  "discord": {
    "webhookUrl": "https://discord.com/api/webhooks/...",
    "mention": "@everyone"
  }
}
```

Set `"mention": ""` if you don't want to be pinged.

### 2. Verify the whole notification chain

```bash
node src/index.js --test-notify
```

Sends a fake fantasy drop through console + Windows toast + Discord.

### 3. Running 24/7

```bash
powershell -ExecutionPolicy Bypass -File .\install-task.ps1
```

That tries to register a Scheduled Task first. Registering one needs an elevated
PowerShell on most machines - if it's denied, the installer falls back to a
**Startup-folder shortcut**, which needs no admin rights.

Either way the watcher runs through `start-hidden.vbs`, so there is **no console
window** to close by accident. Everything it prints goes to `watcher.log` instead.
Three layers keep it up:

| Failure | What recovers it |
|---|---|
| Node crashes or exits | the restart loop in `run.bat`, after 30s |
| A book errors or rate-limits | exponential backoff per book, up to 30 min |
| Reboot / logoff | the Startup shortcut, at next logon |

Start, stop and inspect:

```bash
wscript.exe start-hidden.vbs
```
```bash
.\stop.bat
```
```bash
powershell -Command "Get-Content watcher.log -Tail 20 -Wait"
```

Remove autostart with:

```bash
powershell -ExecutionPolicy Bypass -File .\install-task.ps1 -Uninstall
```

**Only one watcher runs at a time.** A second one sees `watcher.lock`, prints which
PID already holds it, and exits - so autostart, `run.bat` and a terminal can't end up
double-posting every alert or racing each other over `state.json`. A stale lock from a
crashed process is reclaimed automatically. `--status`, `--once` and `--simulate` don't
take the lock, so they're safe to run while the watcher is live.

> **Use `stop.bat`, not Task Manager.** The `run.bat` restart loop is node's *parent*,
> so killing only `node.exe` makes the loop start a fresh watcher 30 seconds later.
> `stop.bat` kills the loop first, then node.

#### The one real limit

This runs on your PC, so "24/7" really means "whenever the machine is awake and
you're logged in". **Sleep or hibernate stops it** - it isn't a service and can't
wake the machine. If the PC sleeps overnight you'll get the alert when it wakes,
not when the line dropped.

If you need true round-the-clock coverage, either set Sleep to Never in
**Settings → System → Power** for the days before a card, or run this on something
always-on (a cheap VPS, a Raspberry Pi). It's plain Node with zero dependencies, so
it runs anywhere - only the Windows toast is platform-specific, and that degrades
harmlessly to a no-op with Discord still working.

---

## Commands

| Command | What it does |
|---|---|
| `node src/index.js` | Poll forever and alert (the normal mode) |
| `node src/index.js --once` | One poll, then exit |
| `node src/index.js --status` | Print every UFC market live right now on all four books |
| `node src/index.js --test-notify` | Fire a sample alert through every channel |
| `node src/index.js --reset` | Forget everything seen; next run re-baselines |
| `node src/index.js --simulate` | Inject fantasy props into a *real* poll and fire the genuine alert path |
| `node src/index.js --heartbeat` | Post a status message to Discord now (read-only) |
| `node test/detection.test.js` | Run the detection test suite (no network calls) |

---

## config.json

| Key | Default | Meaning |
|---|---|---|
| `discord.webhookUrl` | `""` | Where to post. Empty = console + toast only |
| `discord.mention` | `"@everyone"` | Prepended to fantasy alerts |
| `windowsToast` | `true` | Native Windows desktop notification |
| `pollSeconds` | `60` | Base poll interval (per-book floors still apply) |
| `alertOnFantasy` | `true` | **The main event.** Alert when a fantasy prop appears |
| `alertOnUnknownStat` | `true` | Safety net — see below |
| `alertOnLineMove` | `true` | Alert when an existing fantasy line moves up or down |
| `lineMoveMinDelta` | `0` | Ignore moves smaller than this. `0` = report every move |
| `discord.mentionOnLineMove` | `true` | Whether line moves ping as well as post |
| `alertOnFirstRun` | `false` | Alert on the initial baseline sweep |
| `books.*` | `true` | Turn individual books off |
| `quietHours` | off | Suppress desktop toasts in a time window (Discord still posts) |
| `heartbeat.enabled` | `true` | Post a periodic "still alive" status to Discord |
| `heartbeat.everyHours` | `12` | How often that status posts |

### Line moves

Once fantasy props are up, every subsequent bump is reported with direction and size:

```
Gregory Rodrigues — Fantasy Points  83.99 → 86.5   🔺 +2.51
Anthony Hernandez — Fantasy Points  89.99 → 88.49  🔻 -1.50
```

**Both drops and moves ping by default.** A drop is obviously worth interrupting you
for. Moves ping too because missing a bump on a line you're already on is just as
costly - and because a quiet move is indistinguishable from no move at all, which
caused real confusion in practice.

The risk is noise: once a board is live, lines move constantly, and a channel that
pings on every half-point wiggle gets muted. Two ways to damp it without going silent:
set `discord.mentionOnLineMove` to `false` so moves post without a mention, or raise
`lineMoveMinDelta` (e.g. `1.0`) so only moves that actually matter are reported at all.
Prefer the threshold - a suppressed ping still hides the event, a threshold is an
explicit decision about what counts.

Only *fantasy* lines are watched for moves. Sig strikes drifting around is ignored.

### Heartbeat

Every 12 hours the watcher posts a quiet status message (no ping) listing each book,
its prop count, whether fantasy is up yet, and how long ago it last polled.

```
💚 Watcher heartbeat — all books healthy
🟢 Underdog — 121 props, no fantasy yet · 11 seconds ago
🟢 PrizePicks — 25 props, no fantasy yet · 2 minutes ago
```

The point is to **make silence meaningful**. Without it, no Discord message in the
morning is ambiguous — it could mean "lines haven't dropped yet" or "the watcher died
at 3am." With it, a missing heartbeat is a clear signal to go and check. A book that
starts erroring flips the message to ⚠️ and marks that book 🔴.

Timing lives in `state.json`, not memory, so a crash-restart loop can't turn a failure
into a stream of status posts. Send one on demand any time with:

```bash
node src/index.js --heartbeat
```

That's read-only — it neither writes state nor resets the 12-hour timer, so it's safe
to run while the watcher is going.

### The `alertOnUnknownStat` safety net

Right now **none of the four books has a fantasy market up for UFC** — verified live
while building this. They post sig strikes / knockouts / takedowns / total rounds first
and add fantasy closer to the event. That means I could never test the matcher against
a real fantasy label, and if a book ships it under a name I didn't predict
(say `FPTS_TOTAL`), a strict matcher would silently miss the drop.

So every stat label each book is *currently known* to offer is listed in
`src/fantasy.js`. Anything outside that list that also doesn't match the fantasy
patterns gets a quieter "new market" alert. You may get the occasional harmless ping
when a book adds a normal new prop — that's the cost of never missing the real one.
Set `alertOnUnknownStat: false` once fantasy has dropped and you've seen it work.

---

## How each book is read

| Book | Source | Auth | Notes |
|---|---|---|---|
| Underdog | `api.underdogfantasy.com/beta/v6/over_under_lines?sport_id=MMA` | none | Clean JSON, ~25KB. Fantasy stat is `fantasy_points` |
| PrizePicks | `partner-api.prizepicks.com/projections?league_id=12` | none | 12 = UFC. Fantasy stat is `Fantasy Score` |
| Betr | `api.fantasy.betr.app/graphql` | none | Two-stage: list UFC events, then projections per event |
| Pick6 | `pick6.draftkings.com/?sport=UFC` | none | No JSON API; the SSR HTML is parsed |

### Things worth knowing

**PrizePicks is rate limited.** `api.prizepicks.com` sits behind DataDome and returns a
captcha to scripts; `partner-api` serves the same data but Cloudflare rate-limits it
(error 1015). This adapter is pinned to a 5-minute floor and the scheduler parks it and
honours `Retry-After` on a 429. Don't lower `pollSeconds` expecting PrizePicks to
follow — it won't, by design.

**Pick6 line values are partial.** DraftKings picks the first stat tab server-side and
the selection isn't URL-addressable, so only the *selected* category's numbers are
readable. Tab *presence* is detected for every category, so a "Fantasy Points" tab
appearing always fires an alert — you just may need to open the app for the numbers.

**PrizePicks alternate lines collapse.** A fighter's demon/goblin variants are tracked
separately, but multiple rungs of the same ladder (Total Rounds 1.5 / 2.5, same odds
type) count as one tracked prop. That's deliberate: you want one alert saying "fantasy
is up for this fighter", not one per rung. In practice fantasy lines are always plain
pick'em anyway, so this never affects them.

**These are scrapes of undocumented endpoints.** They can change without warning. If a
book goes quiet, run `--status` — an adapter that breaks reports an error there rather
than failing silently, and the loop backs off exponentially instead of hammering.

---

## Layout

```
src/
  index.js              scheduler, CLI, alert dispatch
  config.js             config load + quiet hours
  state.js              seen-prop store, diffing, atomic saves
  fantasy.js            fantasy matching + known-stat lists
  notify.js             console / Discord / Windows toast
  adapters/
    underdog.js  prizepicks.js  betr.js  pick6.js
  lock.js               single-instance PID lock
test/detection.test.js  30 tests, no network
start-hidden.vbs        launches the watcher with no console window
run.bat                 restart loop (revives node if it exits)
stop.bat                kills the loop AND the watcher
install-task.ps1        autostart at logon (-Uninstall to remove)
state.json              created on first run
watcher.lock            present only while a watcher is live
watcher.log             everything the hidden watcher prints
```

Each adapter exports `meta` and `fetchProps()` returning a flat list of props, so
adding a fifth book means writing one file and adding it to the `ADAPTERS` array.
