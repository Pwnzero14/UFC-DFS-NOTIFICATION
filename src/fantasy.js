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
    // 'significant strikes' and 'takedowns' deliberately NOT listed here - both
    // are watched markets now, and a watched match is checked before this list
    // anyway. Leaving them out means a renamed variant surfaces as an unknown
    // stat rather than going quietly known, which is the point of the net.
    // 'significant strikes attempted' stays: it is a different market.
    'finishes', 'knockouts', 'submissions',
    'fight time (mins)', 'fight time', 'round of victory',
    'significant strikes attempted', 'control time', 'knockdowns',
    // Round-finish markets: 82 props across five variants, none of them asked
    // for. Identified by the unknown-stat safety net, which is what it is for -
    // it surfaces a new market once, then it gets classified and goes quiet.
    '1st round finish', '2nd round finish', '3rd round finish',
    '4th round finish', '5th round finish',
  ],
  prizepicks: [
    // 'knockdowns', 'significant strikes' and 'takedowns' deliberately NOT
    // listed - all three are watched markets now, and a watched match is
    // checked before this list anyway. Leaving them out means a renamed
    // variant surfaces as an unknown stat rather than going quietly known.
    // 'significant strikes attempted' stays: it is a different market.
    'fight time (mins)', 'total rounds',
    'submission attempts', 'control time', 'fight time',
    'significant strikes attempted',
  ],
  betr: [
    // The strike and takedown spellings are gone from this list for the usual
    // reason - they are watched now, so a rename should surface as an unknown
    // stat rather than going quietly known.
    // No 'attempted' variants listed: unlike the other books, Betr has never
    // been seen posting one, and inventing a spelling for a market I have not
    // observed is exactly what the unknown-stat net is meant to catch. If Betr
    // posts one it surfaces once as a notice, then gets classified for real.
    'knockdowns', 'fight time', 'control time',
    'fight time (minutes)', '1st rd finish', 'decision win', 'finishes',
    'submissions', 'knockouts', 'round of victory',
  ],
  pick6: [
    // 'significant strikes' NOT listed - it is watched now, so a rename should
    // surface as an unknown stat rather than going quietly known. 'takedowns'
    // DOES stay: it is watched via the adapter's explicit kind, not from here,
    // and its tab-only placeholder is meant to classify known and stay quiet.
    'knockouts', 'takedowns', 'submissions',
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

// "Knockdown" is a distinct word from "Knockout", so this cannot collide with
// the knockout markets every book also offers.
const KNOCKDOWNS = [/knockdowns?\b/i, /knockdowns?_/i];

// Underdog's full-fight Significant Strikes and Takedowns, watched alongside
// fantasy points and the round 1 strikes market.
//
// Anchored to the whole market name, because the markets next to these are
// supersets of their words: "Significant Strikes Attempted" is a different line
// from "Significant Strikes", and every board offers both. A loose /sig
// strikes/ would quietly promote the attempted market too. Round 1 Significant
// Strikes is unaffected - it does not match these, and ROUND1_SIG_STRIKES still
// picks it up.
//
// Both the display name and the underscored stat key are covered, since either
// may be the one that arrives: Underdog sends "Significant Strikes" with
// significant_strikes, and "Takedowns" with takedowns.
const FULL_FIGHT_SIG_STRIKES = [/^sig(?:nificant)?[\W_]*strikes$/i];
// "Takedowns" on Underdog and Pick6. Betr's own board was dark when this was
// written and had no takedown market up when it came back, so its spelling is
// unobserved - its known list carries both 'takedowns' and 'takedowns_landed',
// and DK words the same market "Takedowns Landed", so accept either. Still
// anchored, so a Takedowns Attempted market stays out.
const FULL_FIGHT_TAKEDOWNS = [/^takedowns$/i, /^takedowns[\W_]*landed$/i];

// Pick6 gets strikes but deliberately NOT takedowns, even though both are
// watched there. Its takedown props are built by the adapter with an explicit
// kind:'tracked' and never consult this file - but the tab-only placeholder,
// emitted when a tab is on the board and its values could not be read, does.
// That placeholder carries a different prop key, so a watched one would read as
// a brand new prop and fire a drop alert for what is really a degraded read.
// Left unwatched here, it stays quiet and the real prop is still tracked.
const WATCHED_PATTERNS = {
  underdog: [...ROUND1_SIG_STRIKES, ...FULL_FIGHT_SIG_STRIKES, ...FULL_FIGHT_TAKEDOWNS],
  prizepicks: [
    ...ROUND1_SIG_STRIKES,
    ...KNOCKDOWNS,
    ...FULL_FIGHT_SIG_STRIKES,
    ...FULL_FIGHT_TAKEDOWNS,
  ],
  pick6: [...FULL_FIGHT_SIG_STRIKES],
  betr: [...FULL_FIGHT_SIG_STRIKES, ...FULL_FIGHT_TAKEDOWNS],
};

/**
 * Each label is tested on its own rather than as one joined string.
 *
 * Joining them made anchoring impossible: "Significant Strikes" arrives as the
 * display name alongside the stat key significant_strikes, so a pattern that
 * pins to the whole market name could never match the pair, and a loose one
 * would also swallow Significant Strikes Attempted - a different line that
 * every board offers. Per-label, `^significant strikes$` means what it says.
 */
export function isWatchedStat(book, ...labels) {
  const patterns = WATCHED_PATTERNS[book] || [];
  return labels.filter(Boolean).some((l) => patterns.some((re) => re.test(l)));
}

export function isFantasyStat(...labels) {
  const hay = labels.filter(Boolean).join(' ');
  return FANTASY_PATTERNS.some((re) => re.test(hay));
}

// Underdog keeps opening round-scoped finish markets - Round Finish, then
// Round 1 Knockout, with Round N Submission and friends presumably to come.
// Each one arrives as an unknown-market notice nobody wants, so match the
// family by shape rather than adding them one at a time as they appear.
//
// This is only consulted AFTER the watched check, so Round 1 Significant
// Strikes stays tracked - and none of these patterns mention strikes anyway.
const KNOWN_PATTERNS = {
  underdog: [
    /^(?:round|rd)\s*\d+\s+(?:knockout|ko|submission|sub|finish|decision)/i,
    /^\d(?:st|nd|rd|th)\s+round\s+(?:knockout|ko|submission|sub|finish|decision)/i,
  ],
};

export function isKnownStat(book, label) {
  const norm = String(label || '').trim().toLowerCase();
  if ((KNOWN_NON_FANTASY[book] || []).includes(norm)) return true;
  return (KNOWN_PATTERNS[book] || []).some((re) => re.test(norm));
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
