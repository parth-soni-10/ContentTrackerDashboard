/**
 * POST /api/feedback — the site's own feedback box, stored in the shared
 * `site-feedback` KV namespace.
 *
 * This is deliberately separate from `/.netlify/functions/suggestions`: that
 * endpoint adds a title to the wishlist, this one is the visitor telling the
 * owner something about the dashboard. Feedback used to have no destination at
 * all, which is why the page had nothing to offer beyond a suggestion form.
 *
 * The endpoint is same-origin (the CSP's `connect-src 'self'` already covers
 * it), anonymous, and stored only in KV with a 90-day expiry. No accounts, no
 * email, no IP in the record: the caller's address is used for the throttle
 * bucket key and then forgotten.
 *
 * Three deliberate behaviours:
 *
 *   honeypot    a hidden `bot-field` arrives filled by bots and empty by
 *               people. A filled one gets the same `{ ok: true }` a real
 *               submission gets, so a bot cannot tell it was dropped, and
 *               nothing is written.
 *   throttle    one submission per address per ten minutes. Without it the
 *               namespace is a free append target.
 *   unbound     if `SITE_FEEDBACK` is not bound the route answers 503 and says
 *               so. It does not pretend to accept feedback it cannot store.
 *
 * The handler keeps the shape the other functions in this directory use
 * (`{ statusCode, headers, body }`) so `functions/_router.js` treats it like
 * every other endpoint.
 */

/** Per-field ceilings, so one request cannot write an unbounded record. */
const LIMITS = { name: 80, email: 254, suggestion: 2000, page: 120, kind: 24 };
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SITE = "content-tracker";
const TTL_SECONDS = 90 * 24 * 60 * 60;
const THROTTLE_SECONDS = 10 * 60;

/** The KV handle, handed over by the router once per request. */
let store = null;

export function setStore(kv) {
  store = kv || null;
}

function json(status, payload, extraHeaders = {}) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extraHeaders },
    body: JSON.stringify(payload),
  };
}

/** Trimmed, length-capped, control characters removed. */
function text(value, limit) {
  if (typeof value !== "string") return "";
  const clean = value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .trim();
  return clean.length > limit ? clean.slice(0, limit) : clean;
}

function badRequest(message) {
  return json(400, { error: message });
}

/** Accepts a JSON body or a plain form post, so the form works without JS. */
function parseBody(event) {
  const raw = typeof event.body === "string" ? event.body : "";
  if (!raw) return {};
  const type = String((event.headers && (event.headers["content-type"] || event.headers["Content-Type"])) || "");
  if (type.includes("application/json")) {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return null;
    }
  }
  const out = {};
  for (const [key, value] of new URLSearchParams(raw)) out[key] = value;
  return out;
}

/** CF-Connecting-IP is copied onto Netlify's header name by the router. */
function clientAddress(event) {
  const headers = event.headers || {};
  const direct = headers["x-nf-client-connection-ip"] || headers["cf-connecting-ip"];
  if (direct) return String(direct).trim();
  const forwarded = headers["x-forwarded-for"];
  if (forwarded) return String(forwarded).split(",")[0].trim();
  return "";
}

export const handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return json(405, { error: "Use POST" }, { Allow: "POST" });
  }

  const body = parseBody(event);
  if (body === null) return badRequest("Send JSON or a form-encoded body.");

  // The honeypot is read before validation on purpose: a bot that fills every
  // field it can see should not be told which check it failed.
  const trap = text(body["bot-field"] || body.botField || body.company, 100);
  if (trap) return json(200, { ok: true });

  const suggestion = text(body.suggestion || body.message, LIMITS.suggestion);
  if (suggestion.length < 3) return badRequest("Tell me what to fix or add (at least a few words).");

  const email = text(body.email, LIMITS.email);
  if (email && !EMAIL.test(email)) return badRequest("That email address does not look right.");

  const name = text(body.name, LIMITS.name);
  const page = text(body.page, LIMITS.page);
  const kind = text(body.kind || body.type, LIMITS.kind);

  if (!store) {
    return json(503, { error: "Feedback storage is not configured on this deployment yet." });
  }

  const address = clientAddress(event);
  if (address) {
    try {
      const seen = await store.get(`throttle:${SITE}:${address}`);
      if (seen) return json(429, { error: "That is one feedback a while, thanks. Try again in a few minutes." });
    } catch {
      // A KV read that fails the throttle must not swallow a real submission.
    }
  }

  const id = `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
  const record = {
    site: SITE,
    id,
    createdAt: new Date().toISOString(),
    name,
    email,
    kind,
    page,
    suggestion,
    userAgent: text((event.headers && event.headers["user-agent"]) || "", 300),
  };

  try {
    await store.put(`feedback:${SITE}:${id}`, JSON.stringify(record), { expirationTtl: TTL_SECONDS });
    if (address) {
      await store.put(`throttle:${SITE}:${address}`, "1", { expirationTtl: THROTTLE_SECONDS });
    }
  } catch (error) {
    console.error("feedback store failed:", (error && error.stack) || error);
    return json(502, { error: "Could not save that just now. Nothing was lost on this device — try again shortly." });
  }

  return json(200, { ok: true, id });
};

export default { handler, setStore };
