// Self-check for relay-worker. Run: node test.mjs
import assert from "node:assert/strict";
import worker from "./src/index.js";

const buf = (s) => new TextEncoder().encode(s);

function fakeBucket() {
  const store = new Map();
  return {
    store,
    async put(key, body, opts) {
      if (body instanceof ReadableStream) body = Buffer.from(await new Response(body).arrayBuffer());
      store.set(key, { body: Buffer.from(body), customMetadata: opts?.customMetadata ?? {} });
    },
    async get(key) {
      const v = store.get(key);
      if (!v) return null;
      return {
        body: new ReadableStream({
          start(c) { c.enqueue(new Uint8Array(v.body)); c.close(); },
        }),
        customMetadata: v.customMetadata,
      };
    },
    async delete(key) {
      if (Array.isArray(key)) for (const k of key) store.delete(k);
      else store.delete(key);
    },
    async list({ prefix }) {
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
      return {
        objects: keys.map((k) => ({ key: k, customMetadata: store.get(k).customMetadata })),
        truncated: false,
      };
    },
  };
}

const realNow = Date.now;
let now = 1_700_000_000_000;
Date.now = () => now;

const env = { BUCKET: fakeBucket(), TTL_MINUTES: "30", MAX_BYTES: "10" };
const req = (url, init) => worker.fetch(new Request(url, init), env);
const body = (r) => r.text();

const r = await req("http://x/p2p/abcdefgh", { method: "PUT", body: buf("zip") });
assert.equal(r.status, 200);
assert.equal(await body(r), "ok");

const g = await req("http://x/p2p/abcdefgh");
assert.equal(g.status, 200);
assert.equal(g.headers.get("content-type"), "application/zip");
assert.equal(g.headers.get("access-control-allow-origin"), "*");

assert.equal((await req("http://x/p2p/short")).status, 400);
assert.equal((await req("http://x/p2p/abcdefgh", { method: "DELETE" })).status, 204);
assert.equal((await req("http://x/p2p/abcdefgh")).status, 404);
assert.equal((await req("http://x/p2p/abcdefgh", { method: "PUT", body: buf("way too large body") })).status, 413);
assert.equal((await req("http://x/health")).status, 200);
assert.equal((await req("http://x/p2p/abcdefgh", { method: "OPTIONS" })).status, 204);

now += 31 * 60_000;
assert.equal((await req("http://x/p2p/abcdefgh", { method: "PUT", body: buf("zip") })).status, 200);
assert.equal((await req("http://x/p2p/abcdefgh")).status, 200, "fresh upload is readable");
now += 31 * 60_000;
assert.equal((await req("http://x/p2p/abcdefgh")).status, 404, "GET after TTL expires");

await worker.scheduled({}, env);
assert.equal(env.BUCKET.store.size, 0, "sweeper reclaims expired objects");

const putPart = (t, i, n, data) => req(`http://x/p2p/${t}`, {
  method: "PUT",
  headers: { "X-Part-Index": String(i), "X-Total-Parts": String(n) },
  body: buf(data),
});

const tok = "efghijkl";
assert.equal((await putPart(tok, 0, 3, "aa")).status, 200);
assert.equal((await putPart(tok, 1, 3, "bbb")).status, 200);
assert.equal((await putPart(tok, 2, 3, "c")).status, 200);
assert.equal(env.BUCKET.store.has(`p2p/${tok}`), true, "last part assembles final object");
assert.equal(env.BUCKET.store.has(`p2p/${tok}/part0`), false, "parts deleted after assembly");
const g3 = await req(`http://x/p2p/${tok}`);
assert.equal(g3.status, 200);
assert.equal(await g3.text(), "aabbbc", "assembled body matches parts");

const tok2 = "ijklmnop";
assert.equal((await putPart(tok2, 0, 3, "aa")).status, 200);
assert.equal((await putPart(tok2, 1, 3, "bb")).status, 200);
await req(`http://x/p2p/${tok2}`, { method: "DELETE" });
assert.equal(env.BUCKET.store.has(`p2p/${tok2}/part0`), false, "DELETE removes parts");
assert.equal(env.BUCKET.store.has(`p2p/${tok2}/part1`), false);

assert.equal((await req("http://x/p2p/abcdefgh", { method: "PUT", headers: { "X-Part-Index": "3", "X-Total-Parts": "2" }, body: buf("x") })).status, 400, "bad part index rejected");
assert.equal((await req("http://x/p2p/abcdefgh", { method: "PUT", headers: { "X-Total-Parts": "0" }, body: buf("x") })).status, 400, "zero total rejected");

Date.now = realNow;
console.log("relay-worker: all checks passed");
