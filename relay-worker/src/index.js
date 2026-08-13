// Cloudflare Worker mirror of relay/src/main.rs — same API so the launcher
// needs no changes: PUT/GET/DELETE /p2p/<token>, CORS permissive, TTL.
const TOKEN_RE = /^[A-Za-z0-9_-]{8,128}$/;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

const envDefaults = (env) => ({
  ttl: Number(env.TTL_MINUTES ?? 30) * 60_000,
  maxBytes: Number(env.MAX_BYTES ?? 100 * 1024 * 1024),
});

const parseParts = (headers) => {
  const partIndex = Number(headers.get("X-Part-Index") ?? 0);
  const totalParts = Number(headers.get("X-Total-Parts") ?? 1);
  if (!Number.isInteger(partIndex) || !Number.isInteger(totalParts)) return null;
  if (partIndex < 0 || totalParts < 1 || partIndex >= totalParts) return null;
  return { partIndex, totalParts };
};

const assemble = async (env, token, n) => {
  const keys = [];
  for (let i = 0; i < n; i++) keys.push(`p2p/${token}/part${i}`);
  async function* source() {
    for (const pk of keys) {
      const obj = await env.BUCKET.get(pk);
      if (!obj) throw new Error("missing " + pk);
      const reader = obj.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        yield value;
      }
    }
  }
  const iter = source();
  const stream = ReadableStream.from(iter);
  await env.BUCKET.put("p2p/" + token, stream, {
    httpMetadata: { contentType: "application/zip" },
    customMetadata: { uploadedAt: String(Date.now()) },
  });
  await env.BUCKET.delete(keys);
};

const deleteParts = async (env, token) => {
  const keys = [];
  let cursor;
  do {
    const page = await env.BUCKET.list({ prefix: `p2p/${token}/`, cursor });
    for (const obj of page.objects) keys.push(obj.key);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  if (keys.length) await env.BUCKET.delete(keys);
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { ttl, maxBytes } = envDefaults(env);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (request.method === "GET" && url.pathname === "/health") return new Response("ok", { headers: CORS });
    if (request.method === "GET" && url.pathname === "/") return new Response("pandora relay ok", { headers: CORS });

    const m = url.pathname.match(/^\/p2p\/([^/]+)$/);
    if (!m) return new Response("not found", { status: 404, headers: CORS });
    const token = m[1];
    if (!TOKEN_RE.test(token)) return new Response("bad token", { status: 400, headers: CORS });

    const key = "p2p/" + token;

    if (request.method === "PUT") {
      const declared = Number(request.headers.get("Content-Length") ?? 0);
      if (declared > maxBytes) return new Response("too large", { status: 413, headers: CORS });
      const body = await request.arrayBuffer();
      if (body.byteLength > maxBytes) return new Response("too large", { status: 413, headers: CORS });

      const part = parseParts(request.headers);
      if (!part) return new Response("bad part headers", { status: 400, headers: CORS });
      const { partIndex, totalParts } = part;

      if (totalParts === 1) {
        await env.BUCKET.put(key, body, {
          httpMetadata: { contentType: "application/zip" },
          customMetadata: { uploadedAt: String(Date.now()) },
        });
        return new Response("ok", { status: 200, headers: CORS });
      }

      await env.BUCKET.put(`p2p/${token}/part${partIndex}`, body, {
        customMetadata: { uploadedAt: String(Date.now()) },
      });
      if (partIndex === totalParts - 1 && !(await env.BUCKET.get(key))) {
        await assemble(env, token, totalParts);
      }
      return new Response("ok", { status: 200, headers: CORS });
    }

    if (request.method === "GET") {
      const obj = await env.BUCKET.get(key);
      if (!obj) return new Response("not found", { status: 404, headers: CORS });
      const age = Date.now() - Number(obj.customMetadata?.uploadedAt ?? 0);
      if (age > ttl) {
        await env.BUCKET.delete(key);
        return new Response("not found", { status: 404, headers: CORS });
      }
      return new Response(obj.body, {
        headers: {
          ...CORS,
          "Content-Type": "application/zip",
          "Content-Disposition": 'attachment; filename="share.zip"',
        },
      });
    }

    if (request.method === "DELETE") {
      await env.BUCKET.delete(key);
      await deleteParts(env, token);
      return new Response(null, { status: 204, headers: CORS });
    }

    return new Response("method not allowed", { status: 405, headers: CORS });
  },

  // ponytail: exact TTL is enforced lazily on GET; this sweep only reclaims
  // R2 storage. Free-plan cron runs daily; paid can go tighter if it matters.
  async scheduled(_event, env) {
    const { ttl } = envDefaults(env);
    const expired = Date.now() - ttl;
    const keys = [];
    let cursor;
    do {
      const page = await env.BUCKET.list({ prefix: "p2p/", cursor });
      for (const obj of page.objects) {
        const uploadedAt = Number(obj.customMetadata?.uploadedAt ?? 0);
        if (uploadedAt && uploadedAt < expired) keys.push(obj.key);
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    if (keys.length) await env.BUCKET.delete(keys);
  },
};
