// Detecting stretches where the watcher was not polling.
//
// Sleeping the machine suspends this process rather than killing it, so the
// most common blackout leaves no trace anywhere: same pid, same lock, the log
// simply skips eleven hours and carries on. Over four days in August 2026 that
// cost about 45% of uptime.
//
// Alerts are not lost across a gap - the next poll still diffs against the
// stored values and fires - so the damage is staleness, not silence. A drop
// that landed while the machine slept arrives on wake looking exactly like one
// that just happened. Naming the gap is what tells them apart.

// A cycle takes seconds and the loop ticks every 5s, so a gap far past that
// means the watcher was not running. Ten minutes clears the slowest honest
// cycle by a wide margin - Pick6's browser trip plus the DK Sportsbook page -
// so this cannot fire for a merely slow poll.
export const BLACKOUT_MS = 10 * 60_000;

/**
 * @param {number|null} lastCycleAt  wall clock at the top of the previous cycle,
 *   held in memory. This is the one that catches sleep, since the process lives
 *   through it. Null before the first cycle of a run.
 * @param {string|null} lastRun  persisted end-of-cycle timestamp. Covers the
 *   cases memory cannot - restart, crash, reboot - and is all there is at
 *   startup.
 * @param {number} now
 * @returns {{from:number,to:number,ms:number}|null}
 */
export function blackoutSince(lastCycleAt, lastRun, now = Date.now()) {
  // Memory first: after a sleep it is both more recent and more accurate than
  // the persisted stamp, which was written before the machine went under.
  let last = lastCycleAt;
  if (last == null && lastRun) {
    const parsed = Date.parse(lastRun);
    last = Number.isNaN(parsed) ? null : parsed;
  }
  // No last cycle at all means the very first run - nothing was missed.
  if (last == null) return null;

  const ms = now - last;
  // A clock that went backwards (DST, an NTP correction) is not a blackout.
  if (ms < BLACKOUT_MS) return null;
  return { from: last, to: now, ms };
}
