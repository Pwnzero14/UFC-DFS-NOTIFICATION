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
    // Round-finish markets: 82 props across five variants, none of them asked
    // for. Identified by the unknown-stat safety net, which is what it is for -
    // it surfaces a new market once, then it gets classified and goes quiet.
    '1st round finish', '2nd round finish', '3rd round finish',
    '4th round finish', '5th round finish',
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

// Non-fantasy markets we want treated as first-class: they ping on a drop and
// on a line move, exactly like fantasy points, rather than falling through to
// the quiet "new market" notice.
//
// The DK Sportsbook adapter sets kind:'tracked' itself because every market it
// reports is one we asked for. The DFS books report their whole board, so they
// need this list to say which of it matters.
// Round 1 significant strikes, spelled however a book decides to spell it.
//
// Neither book has posted this market yet, so the wording is guesswork and the
// patterns are deliberately tolerant: "Round 1" / "Rd 1" / "1st Round", "Sig"
// or "Significant", and underscored stat keys like round_1_significant_strikes
// - note [\W_] rather than \W, since underscore counts as a WORD character and
// \W would not match it. (?!\d) keeps "Round 10" out.
//
// Both orders matter: Underdog would likely lead with the round, while
// PrizePicks parenthesises qualifiers ("Fight Time (Mins)"), so
// "Significant Strikes (Round 1)" is just as likely.
const ROUND1_SIG_STRIKES = [
  /(?:round|rd)[\W_]*1(?!\d)[\s\S]{0,14}sig(?:nificant)?[\W_]*strikes/i,
  /1st[\W_]*(?:round|rd)[\W_][\s\S]{0,14}sig(?:nificant)?[\W_]*strikes/i,
  /sig(?:nificant)?[\W_]*strikes[\s\S]{0,14}(?:round|rd)[\W_]*1(?!\d)/i,
  /sig(?:nificant)?[\W_]*strikes[\s\S]{0,14}1st[\W_]*(?:round|rd)/i,
];

const WATCHED_PATTERNS = {
  underdog: ROUND1_SIG_STRIKES,
  prizepicks: ROUND1_SIG_STRIKES,
};

export function isWatchedStat(book, ...labels) {
  const hay = labels.filter(Boolean).join(' ');
  return (WATCHED_PATTERNS[book] || []).some((re) => re.test(hay));
}

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
 * -> 'tracked'  : another market we explicitly watch; alerts like fantasy does
 * -> 'known'    : an ordinary non-fantasy prop, ignore
 * -> 'unknown'  : never seen before; worth a heads-up (safety net)
 */
export function classify(book, ...labels) {
  if (isFantasyStat(...labels)) return 'fantasy';
  if (isWatchedStat(book, ...labels)) return 'tracked';
  const primary = labels.find(Boolean) || '';
  return isKnownStat(book, primary) ? 'known' : 'unknown';
}
