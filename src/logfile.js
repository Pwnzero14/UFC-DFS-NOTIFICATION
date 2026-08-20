// Writes console output to watcher.log from inside the process.
//
// The Scheduled Task runs `node src/index.js` directly, with no shell to
// redirect stdout - so relying on `>> watcher.log` in run.bat only worked for
// the old launcher and left the task with no log at all. Doing it here means
// the log exists no matter how the watcher was started.

import { appendFileSync, statSync, renameSync, existsSync } from 'node:fs';

const MAX_BYTES = 5 * 1024 * 1024; // rotate at 5MB, keep one previous file

function rotateIfBig(path) {
  try {
    if (existsSync(path) && statSync(path).size > MAX_BYTES) {
      renameSync(path, `${path}.1`); // overwrites any existing .1
    }
  } catch {
    /* rotation is best-effort; never block logging */
  }
}

/**
 * Tee console.log/warn/error into `path`. Returns a restore function.
 * Console output still goes to stdout, so an interactive run is unchanged.
 */
export function teeConsoleTo(path) {
  const original = { log: console.log, warn: console.warn, error: console.error };
  let checked = 0;

  const write = (level, args) => {
    // Only stat occasionally - this runs on every log line.
    if (++checked % 200 === 0) rotateIfBig(path);
    try {
      const text = args
        .map((a) => (typeof a === 'string' ? a : String(a)))
        .join(' ')
        // Strip ANSI colour codes; they are noise in a file.
        .replace(/\x1b\[[0-9;]*m/g, '');
      appendFileSync(path, text + '\n', 'utf8');
    } catch {
      /* a failed log write must never take the watcher down */
    }
  };

  console.log = (...a) => { original.log(...a); write('log', a); };
  console.warn = (...a) => { original.warn(...a); write('warn', a); };
  console.error = (...a) => { original.error(...a); write('error', a); };

  return () => Object.assign(console, original);
}
