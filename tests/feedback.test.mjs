import test from "node:test";
import assert from "node:assert/strict";

import { handler, setStore } from "../functions/api/feedback.js";

/** The two KV calls the handler makes, with the options it passed recorded. */
function fakeKv() {
  const values = new Map();
  const puts = [];
  return {
    values,
    puts,
    async get(key) {
      return values.has(key) ? values.get(key) : null;
    },
    async put(key, value, options) {
      values.set(key, value);
      puts.push({ key, value, options });
    },
  };
}

const post = (body, headers = {}) => ({
  httpMethod: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: typeof body === "string" ? body : JSON.stringify(body),
});

const ok = { suggestion: "The timeline needs a year switch." };

test("rejects anything but POST", async () => {
  const response = await handler({ httpMethod: "GET", headers: {} });
  assert.equal(response.statusCode, 405);
  assert.equal(response.headers.Allow, "POST");
});

test("a filled honeypot looks accepted and writes nothing", async () => {
  const kv = fakeKv();
  setStore(kv);
  const response = await handler(post({ ...ok, "bot-field": "http://spam.example" }));
  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), { ok: true });
  assert.equal(kv.puts.length, 0);
});

test("rejects an empty or one-word suggestion", async () => {
  setStore(fakeKv());
  const response = await handler(post({ suggestion: "  ok " }));
  assert.equal(response.statusCode, 400);
});

test("rejects a malformed email but allows none", async () => {
  setStore(fakeKv());
  const bad = await handler(post({ ...ok, email: "not-an-address" }));
  assert.equal(bad.statusCode, 400);
  const fine = await handler(post({ ...ok, email: "" }));
  assert.equal(fine.statusCode, 200);
});

test("rejects a body that claims to be JSON and is not", async () => {
  setStore(fakeKv());
  const response = await handler(post("{not json"));
  assert.equal(response.statusCode, 400);
});

test("says so when the namespace is not bound", async () => {
  setStore(null);
  const response = await handler(post(ok));
  assert.equal(response.statusCode, 503);
  assert.match(JSON.parse(response.body).error, /not configured/i);
});

test("stores one record with a 90-day expiry and no address", async () => {
  const kv = fakeKv();
  setStore(kv);
  const response = await handler(
    post({ name: "Parth", email: "p@example.com", suggestion: "  Add a genre filter to Random Pick.  ", page: "#suggestions" }, { "cf-connecting-ip": "203.0.113.9" })
  );
  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body);
  assert.equal(body.ok, true);
  assert.ok(body.id);

  const record = kv.puts.find((entry) => entry.key.startsWith("feedback:content-tracker:"));
  assert.ok(record, "a feedback record was written");
  assert.equal(record.options.expirationTtl, 90 * 24 * 60 * 60);
  assert.equal(JSON.parse(record.value).suggestion, "Add a genre filter to Random Pick.");
  assert.equal(JSON.parse(record.value).site, "content-tracker");
  assert.ok(!record.value.includes("203.0.113.9"), "the caller's address is not stored");

  const throttle = kv.puts.find((entry) => entry.key.startsWith("throttle:"));
  assert.ok(throttle, "a throttle key was written");
  assert.equal(throttle.options.expirationTtl, 10 * 60);
});

test("throttles a second submission from the same address", async () => {
  const kv = fakeKv();
  setStore(kv);
  const headers = { "x-forwarded-for": "198.51.100.4, 10.0.0.1" };
  assert.equal((await handler(post(ok, headers))).statusCode, 200);
  const second = await handler(post(ok, headers));
  assert.equal(second.statusCode, 429);
  assert.equal(kv.puts.filter((entry) => entry.key.startsWith("feedback:")).length, 1);
});

test("accepts a form-encoded body, which is what the no-JS path sends", async () => {
  const kv = fakeKv();
  setStore(kv);
  const response = await handler({
    httpMethod: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ suggestion: "Posters sometimes load late on the Data page.", kind: "bug" }).toString(),
  });
  assert.equal(response.statusCode, 200);
  const record = kv.puts.find((entry) => entry.key.startsWith("feedback:"));
  assert.equal(JSON.parse(record.value).kind, "bug");
});

test("a failing store answers 502 instead of claiming success", async () => {
  setStore({
    async get() {
      return null;
    },
    async put() {
      throw new Error("KV is down");
    },
  });
  const response = await handler(post(ok));
  assert.equal(response.statusCode, 502);
});
