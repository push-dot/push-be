import assert from "node:assert/strict";
import { test } from "node:test";

import { ReadCache, READ_CACHE_MAX_ENTRIES, READ_CACHE_TTL_MS } from "../src/read-cache.ts";

test("a hit inside the TTL skips the loader and a read at the TTL loads again", async () => {
  const cache = new ReadCache();
  let loads = 0;
  const load = async () => ({ n: ++loads });
  assert.deepEqual(await cache.get("k", 0, load), { n: 1 });
  assert.deepEqual(await cache.get("k", READ_CACHE_TTL_MS - 1, load), { n: 1 });
  assert.deepEqual(await cache.get("k", READ_CACHE_TTL_MS, load), { n: 2 });
  assert.equal(loads, 2);
});

test("the TTL is 60 seconds", () => {
  assert.equal(READ_CACHE_TTL_MS, 60_000);
});

test("a failed load is not stored, so the next read tries again", async () => {
  const cache = new ReadCache();
  let loads = 0;
  await assert.rejects(cache.get("k", 0, async () => { loads += 1; throw new Error("boom"); }), /boom/);
  assert.equal(await cache.get("k", 1, async () => { loads += 1; return "ok"; }), "ok");
  assert.equal(loads, 2);
});

test("keys do not share values", async () => {
  const cache = new ReadCache();
  assert.equal(await cache.get("a", 0, async () => 1), 1);
  assert.equal(await cache.get("b", 0, async () => 2), 2);
  assert.equal(await cache.get("a", 0, async () => 3), 1);
});

test("clear drops every entry", async () => {
  const cache = new ReadCache();
  await cache.get("a", 0, async () => 1);
  cache.clear();
  assert.equal(await cache.get("a", 0, async () => 2), 2);
});

test("many distinct keys stay under the entry cap and the oldest goes first", async () => {
  const cache = new ReadCache();
  for (let i = 0; i < READ_CACHE_MAX_ENTRIES + 50; i += 1) {await cache.get(`k${i}`, 0, async () => i);}
  assert.equal(cache.size, READ_CACHE_MAX_ENTRIES);
  assert.equal(await cache.get("k0", 0, async () => "reloaded"), "reloaded");
  const newest = READ_CACHE_MAX_ENTRIES + 49;
  assert.equal(await cache.get(`k${newest}`, 0, async () => "reloaded"), newest);
});

test("a key longer than the cap is never stored", async () => {
  const cache = new ReadCache();
  const key = "x".repeat(4097);
  assert.equal(await cache.get(key, 0, async () => 1), 1);
  assert.equal(await cache.get(key, 0, async () => 2), 2);
  assert.equal(cache.size, 0);
});

test("expired entries are swept before a live one is evicted", async () => {
  const cache = new ReadCache();
  for (let i = 0; i < READ_CACHE_MAX_ENTRIES; i += 1) {await cache.get(`old${i}`, 0, async () => i);}
  await cache.get("fresh", READ_CACHE_TTL_MS + 1, async () => "f");
  assert.equal(cache.size, 1);
});
