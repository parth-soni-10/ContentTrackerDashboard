// The one place the media APIs are asked "which of these results is the title
// the caller meant?".
//
// It lives in a lib file because two functions ask it — the poster/rating
// lookup (tmdb-search.js) and the calendar's own searches (calendar.js) — and
// two copies of a matcher is how they drift apart.
//
// The rule, in one place: an exact name outranks popularity, and a known kind
// outranks a popular wrong kind. Only when neither says anything does
// popularity decide. That is what stops "You" from matching "Because I Want
// You" (a popular near-miss) and a series from matching a same-named film.
const TMDB_BASE = 'https://api.themoviedb.org/3';

// A title reduced to its letters and digits: "You, Me, Us" and "You Me Us"
// are one title, and a punctuation difference never hides a match.
const normTitle = value => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// `type` is the caller's own kind: 'movie', 'tv', or '' when it is unknown.
function pickMatch(candidates, title, type) {
  const want = normTitle(title);
  const media = /movie/i.test(type || '') ? 'movie' : /tv|series|show/i.test(type || '') ? 'tv' : '';
  const ranked = list => list.slice().sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
  const pool = media ? candidates.filter(item => item.media_type === media) : candidates;
  const exact = (pool.length ? pool : candidates).filter(item => normTitle(item.title || item.name) === want && want);
  if (exact.length) return ranked(exact)[0];
  if (pool.length) return ranked(pool)[0];
  return ranked(candidates)[0] || null;
}

module.exports = { TMDB_BASE, normTitle, pickMatch };
