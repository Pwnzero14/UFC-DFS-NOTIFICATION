// Decides whether a stat is a fantasy-points market, and flags stats we've
// never seen before so a rename on the book's side can't cause a silent miss.

const FANTASY_PATTERNS = [
  /fantasy/i,          // "Fantasy Points", "Fantasy Score", "FANTASY_POINTS"
  /\bf\.?pts?\b/i,     // "FPts", "F. Pts", "FPTS"
  /\bfp\b/i,           // "FP"
  /fantasy_?score/i,
];

// Everything each book is known to offer for UFC that is NOT fantasy.
// Anything outside this list (and not matching a fantasy pattern) is reported
// once as an unrecognized stat, so a new naming convention still reaches you.
const KNOWN_NON_FANTASY = {
  underdog: [
    'significant strikes', 'finishes', 'knockouts', 'submissions',
    'fight time (mins)', 'takedowns', 'fight time', 'round of victory',
    'significant strikes attempted', 'control time', 'knockdowns',
  ],
  prizepicks: [
    'fight time (mins)', 'total rounds', 'significant strikes', 'takedowns',
    'knockdowns', 'submission attempts', 'control time', 'fight time',
    'significant strikes attempted',
  ],
  betr: [
    'sig strikes', 'significant strikes', 'takedowns', 'knockdowns',
    'fight time', 'sig_strikes', 'takedowns_landed', 'control time',
    'fight time (minutes)', '1st rd finish', 'decision win', 'finishes',
    'submissions', 'knockouts', 'round of victory',
  ],
  pick6: [
    'significant strikes', 'knockouts', 'takedowns', 'submissions',
    'fight time', 'fight time (mins)', 'significant strikes attempted',
    'knockdowns', 'control time', 'total rounds', 'finishes',
  ],
};

export function isFantasyStat(...labels) {
  const hay = labels.filter(Boolean).join(' ');
  return FANTASY_PATTERNS.some((re) => re.test(hay));
}

export function isKnownStat(book, label) {
  const known = KNOWN_NON_FANTASY[book] || [];
  const norm = String(label || '').trim().toLowerCase();
  return known.includes(norm);
}

/**
 * Classify a stat label for a book.
 * -> 'fantasy'  : this is the drop you're waiting for
 * -> 'known'    : an ordinary non-fantasy prop, ignore
 * -> 'unknown'  : never seen before; worth a heads-up (safety net)
 */
export function classify(book, ...labels) {
  if (isFantasyStat(...labels)) return 'fantasy';
  const primary = labels.find(Boolean) || '';
  return isKnownStat(book, primary) ? 'known' : 'unknown';
}
