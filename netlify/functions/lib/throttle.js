// A best-effort brute-force damper for the password-checking functions.
//
// In-memory, so it is per function instance and resets on a cold start — that is
// the honest ceiling of what a Netlify function can do without a shared store.
// It exists to make guessing slow and noisy rather than to be a wall; the wall
// is the password's entropy plus FAILURE_DELAY_MS, which every failed attempt
// pays whether or not the window has filled up.
//
// Same approach as Expense-Tracker's lib/auth.mjs (createFailureThrottle), kept
// in CommonJS because these functions are CommonJS.
const WINDOW_MS = 5 * 60 * 1000; // sliding window: five minutes
const MAX_FAILURES = 10; // per client IP per window
const FAILURE_DELAY_MS = 400; // cost of every failed attempt
const MAX_TRACKED_IPS = 5000; // bound the map on a long-lived instance

const failures = new Map(); // ip -> [failure timestamps]

// Netlify sets x-nf-client-connection-ip itself; x-forwarded-for is the fallback
// for `netlify dev` and any other proxy in front.
function clientIp(event) {
  const headers = (event && event.headers) || {};
  const direct =
    headers['x-nf-client-connection-ip'] || headers['X-Nf-Client-Connection-Ip'];
  if (direct) return direct;
  const forwarded =
    headers['x-forwarded-for'] || headers['X-Forwarded-For'] || '';
  const first = forwarded.split(',')[0].trim();
  return first || 'unknown';
}

function recentFailures(ip, now = Date.now()) {
  const kept = (failures.get(ip) || []).filter((stamp) => now - stamp < WINDOW_MS);
  if (kept.length) failures.set(ip, kept);
  else failures.delete(ip);
  return kept;
}

// Ask before checking the password: is this IP already over the limit?
function failureState(ip) {
  const stamps = recentFailures(ip);
  if (stamps.length < MAX_FAILURES) return { blocked: false, retryAfter: 0 };
  const age = Date.now() - stamps[0];
  return {
    blocked: true,
    retryAfter: Math.max(1, Math.ceil((WINDOW_MS - age) / 1000)),
  };
}

function recordFailure(ip) {
  const stamps = recentFailures(ip);
  stamps.push(Date.now());
  failures.set(ip, stamps);
  if (failures.size > MAX_TRACKED_IPS) {
    // Drop the oldest entries rather than grow the map without bound.
    for (const key of failures.keys()) {
      if (failures.size <= MAX_TRACKED_IPS) break;
      failures.delete(key);
    }
  }
  return stamps.length;
}

function clearFailures(ip) {
  failures.delete(ip);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

module.exports = {
  clientIp,
  failureState,
  recordFailure,
  clearFailures,
  sleep,
  FAILURE_DELAY_MS,
};
