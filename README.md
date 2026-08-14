# Pandora sync - instance sharing for Pandora launcher enhanced

This repository hosts the share page and the relay backend on one origin.
Deploy it once on Vercel, Netlify, or Cloudflare Pages.
You do not need a second service.

The launcher uploads a filtered zip with `PUT /p2p/<token>`.
The share page fetches the zip with `GET /p2p/<token>` and offers a download.
The page and the API share the same origin, so no cross-site setup is required.

## Layout

```
app.js                          Hono app: PUT/GET/DELETE /p2p/:token, GET /health. Vercel entry point.
public/index.html               Share page. The deployment serves it at /.
functions/p2p/[[token]].js      Cloudflare Pages function for /p2p/*. Wraps app.js.
functions/health.js             Cloudflare Pages function for /health. Wraps app.js.
netlify/edge-functions/index.js Netlify edge function. Wraps app.js via hono/netlify.
netlify.toml                    Netlify configuration: publish = "public", edge routes for /p2p/* and /health.
package.json                    Runtime dependency is hono. Dev dependency is @hono/node-server.
scripts/dev.js                  Local dev server: mounts app.js at / and serves public/index.html at /.
relay-worker/                   Optional Cloudflare Worker relay with R2 persistence.
  wrangler.toml                 Worker config: R2 bucket pandora-relay, vars, cron.
  src/index.js                  Worker implementation: same API with R2 and chunked assembly.
  test.mjs                      Worker self-test with fake R2 bucket.
```

`app.js:10` reads `TTL_MINUTES` and `MAX_BYTES` from the platform env or `process.env`.
`public/index.html:49` uses `location.origin` by default and allows override via `<meta name="p2p-relay">` or `?relay=`.

## Deploy on Netlify - Recommended

`netlify.toml:1` already sets the publish directory and the edge routes, so you only import the repo and deploy.

[![Deploy to Netlify](https://www.netlify.com/img/deploy/button.svg)](https://app.netlify.com/start/deploy?repository=https://github.com/theoneand33/pandora-sync)

Netlify serves `public/` and routes API calls to the edge function that wraps `app.js:46`.

1. Import this repository in the Netlify dashboard.
2. Leave the build command empty.
3. Confirm that `netlify.toml:1` sets `publish = "public"`.
4. Confirm that `netlify.toml:4` routes `/p2p/*` and `/health` to edge function `index`.
5. Deploy the project.
6. Test the deployment at `https://<your-deploy>/health`.

`netlify.toml` already contains the publish directory and the edge routes.
Set `TTL_MINUTES` and `MAX_BYTES` in the Netlify dashboard to override defaults.
The free tier covers this workload. The store is in-memory per isolate. A cold start can delete bundles.

## Deploy on Vercel

Vercel runs `app.js:133` as a serverless function and serves `public/` as static files.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/theoneand33/pandora-sync)

1. Import this repository in the Vercel dashboard.
2. Leave the build command empty.
3. Confirm that the framework preset is Other and the entry point is `app.js`.
4. Confirm that the output directory is `public`.
5. Deploy the project.
6. Test the deployment at `https://<your-deploy>/health`.

No configuration file is required.
Set `TTL_MINUTES` and `MAX_BYTES` in the Vercel dashboard if you need non-default limits.
The default cap is 512 MiB per bundle. The default TTL is 30 minutes.

## Deploy on Cloudflare Pages

Cloudflare Pages serves `public/` and runs the functions in `functions/` that wrap `app.js:1`.

1. Create a Pages project in the Cloudflare dashboard.
2. Connect this repository to the project.
3. Leave the build command empty.
4. Set the build output directory to `public`.
5. Deploy the project.
6. Test the deployment at `https://<your-deploy>/health`.

`functions/p2p/[[token]].js:1` and `functions/health.js:1` import `handle` from `hono/cloudflare-pages`.
Set `TTL_MINUTES` and `MAX_BYTES` in the Pages dashboard to override defaults.
The store is in-memory per isolate and expires after 30 minutes. `app.js:120` also sweeps expired entries every 60 seconds.

## Deploy on Cloudflare Pages with Worker relay

Use this option when you need persistence beyond memory or a separate R2 bucket.
The Worker in `relay-worker/src/index.js:59` implements the same API as `app.js:46`.
The launcher requires no code change.

1. Create a Pages project for this repository. Leave the build command empty and set the output directory to `public`.
2. Create an R2 bucket with `npx wrangler r2 bucket create pandora-relay`.
3. Edit `relay-worker/wrangler.toml:5` to set `TTL_MINUTES` and `MAX_BYTES` if needed.
4. Deploy the Worker with `npx wrangler deploy` inside `relay-worker/`.
5. Set the `p2p-relay` meta tag in `public/index.html:50` to the Worker URL.
6. Point `p2p_relay_url` in the launcher config to the same Worker URL.
7. Test the Worker locally with `node relay-worker/test.mjs`.

Notes for the Worker:

- `relay-worker/wrangler.toml:7` sets `MAX_BYTES = "104857600"` (100 MB). `app.js:5` defaults to 512 MiB. Adjust per plan.
- Cloudflare caps request bodies at 100 MB on the free plan and 500 MB on paid plans. The Worker returns 413 when a body exceeds `MAX_BYTES`.
- `relay-worker/wrangler.toml:14` sets a cron of `0 */6 * * *` (every 6 hours). The cron only reclaims R2 storage. Every `GET` in `relay-worker/src/index.js:106` also checks TTL and returns 404 after expiry, so the 30-minute TTL holds even between crons.
- The Worker returns permissive CORS headers at `relay-worker/src/index.js:5` and handles `OPTIONS` with 204.

## Local development

1. Install dependencies with `npm install`.
2. Start the server with `npm run dev`.
3. Open `http://localhost:3000`.

`scripts/dev.js:7` mounts the Hono app at `/` and serves `public/index.html` at `/`.
The page and the API run on one origin.

## Chunked upload protocol

Both `app.js:36` and `relay-worker/src/index.js:16` accept the same optional headers on `PUT /p2p/<token>`:

- `X-Part-Index`: zero-based part number. Default is 0.
- `X-Total-Parts`: total number of parts. Default is 1.

Rules:

1. Send no headers to do a single-part upload.
2. Send both headers to do a chunked upload.
3. The server validates that both headers are integers with `0 <= X-Part-Index < X-Total-Parts`.
4. The server stores each part separately. `app.js:75` stores it in memory. `relay-worker/src/index.js:93` stores it as `p2p/<token>/part<i>` in R2.
5. The server assembles only when it receives the last index `X-Part-Index == X-Total-Parts - 1` and the final object does not yet exist.
6. If any part is missing at assembly time, the server returns 500 `missing part`.
7. If `X-Total-Parts` differs between parts for the same token, the server returns 400 `bad part headers`.
8. Assembly concatenates parts in order, stores the final zip at `p2p/<token>`, deletes the part objects, and returns 200.
9. The TTL starts when assembly completes. `MAX_BYTES` limits each part, so a large bundle can travel as many parts.

## Launcher configuration

Point the launcher at your deployment origin:

```json
{
  "p2p_relay_url": "https://<your-deploy>/",
  "p2p_pages_url": "https://<your-deploy>/"
}
```

If you use the Worker relay, set both URLs to the Worker URL and set the meta tag in `public/index.html:50` to the same URL.
A share link has one of these forms:

- `https://<your-deploy>/?token=<token>`
- `https://<your-deploy>/p2p/<token>`

`public/index.html:57` accepts a bare token, `?token=`, `?url=`, `?relay=`, or a full `http` link.

## Security and limits

- Token format is `app.js:31` and `relay-worker/src/index.js:3`: 8 to 128 characters, `A-Z a-z 0-9 _ -`. Possession of the token grants access.
- The receiver validates every zip entry path with `SafePath`.
- The Hono app (`app.js:7`) stores bundles in memory only. The Worker (`relay-worker/src/index.js:48`) stores bundles in R2 with `customMetadata.uploadedAt`.
- Memory bundles disappear on cold start or isolate recycle. Share links are short-lived by design.
- Default caps: 512 MiB and 30 minutes for `app.js:5`, 100 MB and 30 minutes for `relay-worker/wrangler.toml:5`. Override with `MAX_BYTES` and `TTL_MINUTES` in the platform env or `wrangler.toml` vars.
- `public/index.html:36` shows that bundles are ephemeral and that the token is the only auth.

## API

```
PUT    /p2p/<token>    Body is application/zip. Returns 200 ok, or 400 bad token, 400 bad part headers, 413 too large, 500 missing part.
GET    /p2p/<token>    Returns 200 application/zip with Content-Disposition attachment, or 400 bad token, 404 not found after expiry.
DELETE /p2p/<token>    Returns 204 and deletes the bundle and any parts, or 400 bad token.
GET    /health         Hono app returns 200 {"ok":true}. Worker returns 200 ok. Both allow health checks.
OPTIONS /p2p/<token>   Worker returns 204 with CORS headers. Hono app handles CORS via hono/cors.
GET    /               Share page at public/index.html. Worker also returns 200 pandora relay ok.
```

CORS for `/p2p/*` is enabled. `app.js:48` uses `hono/cors`. `relay-worker/src/index.js:5` returns `Access-Control-Allow-Origin: *`.
