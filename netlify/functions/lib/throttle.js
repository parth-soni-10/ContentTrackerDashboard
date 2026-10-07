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

// A write limiter for the endpoints anyone can reach without a password.
//
// Same in-memory, per-instance caveat as the failure window above: this raises
// the cost of a scripted sweep, it is not a wall. It differs from the login
// damper in one way that matters — a *successful* call counts too. The login
// window limits guessing, so only failures matter; here the write itself is the
// thing being limited, so counting only failures would let a script that always
// succeeds through at full speed.
const WRITE_WINDOW_MS = 10 * 60 * 1000; // ten minutes
const MAX_WRITES = 8; // per client IP per window

const writes = new Map(); // ip -> [write timestamps]

function recentWrites(ip, now = Date.now()) {
  const kept = (writes.get(ip) || []).filter((stamp) => now - stamp < WRITE_WINDOW_MS);
  if (kept.length) writes.set(ip, kept);
  else writes.delete(ip);
  return kept;
}

// Ask before doing the work: is this IP already at the limit?
function writeState(ip) {
  const stamps = recentWrites(ip);
  if (stamps.length < MAX_WRITES) return { limited: false, retryAfter: 0 };
  const age = Date.now() - stamps[0];
  return {
    limited: true,
    retryAfter: Math.max(1, Math.ceil((WRITE_WINDOW_MS - age) / 1000)),
  };
}

function recordWrite(ip) {
  const stamps = recentWrites(ip);
  stamps.push(Date.now());
  writes.set(ip, stamps);
  if (writes.size > MAX_TRACKED_IPS) {
    for (const key of writes.keys()) {
      if (writes.size <= MAX_TRACKED_IPS) break;
      writes.delete(key);
    }
  }
  return stamps.length;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

module.exports = {
  clientIp,
  failureState,
  recordFailure,
  clearFailures,
  writeState,
  recordWrite,
  sleep,
  FAILURE_DELAY_MS,
  MAX_WRITES,
};
