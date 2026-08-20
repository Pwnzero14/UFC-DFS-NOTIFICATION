// Single-instance guard.
//
// The watcher can be started three ways (run.bat, the Startup shortcut, or a
// terminal), and two live instances would double-post every alert and race each
// other writing state.json. A PID lockfile keeps exactly one alive.

import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';

function pidAlive(pid) {
  try {
    // Signal 0 performs the permission/existence check without killing.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to someone else.
    return err.code === 'EPERM';
  }
}

/**
 * Returns { ok: true } if this process now holds the lock, or
 * { ok: false, pid } if another live instance already does.
 */
export function acquire(lockPath) {
  if (existsSync(lockPath)) {
    let stale = true;
    let otherPid = null;
    try {
      otherPid = Number(readFileSync(lockPath, 'utf8').trim());
      if (Number.isInteger(otherPid) && otherPid > 0 && otherPid !== process.pid) {
        stale = !pidAlive(otherPid);
      }
    } catch {
      stale = true; // unreadable lock is treated as abandoned
    }
    if (!stale) return { ok: false, pid: otherPid };
  }

  writeFileSync(lockPath, String(process.pid), 'utf8');

  const release = () => {
    try {
      // Only remove the lock if it is still ours.
      if (existsSync(lockPath) && readFileSync(lockPath, 'utf8').trim() === String(process.pid)) {
        unlinkSync(lockPath);
      }
    } catch {
      /* best effort */
    }
  };

  process.on('exit', release);
  return { ok: true, release };
}
