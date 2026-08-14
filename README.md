# pandora-sync — share page and relay in one deployment

This repo hosts the share page and the relay backend on one origin. Deploy it once on **Vercel**, **Netlify**, or **Cloudflare Pages**. You do not need a second service.

The launcher uploads a filtered zip with `PUT /p2p/<token>`. This page fetches it with `GET /p2p/<token>` and offers a download. Bundles are stored in the deployment's memory and expire after 30 minutes.

## Layout

```
app.js                    Hono app: /p2p/<token> PUT/GET/DELETE, /health. Also the Vercel entry.
public/index.html         Share page, served at / on every platform.
functions/p2p/[[token]].js  Cloudflare Pages entry for /p2p/*
functions/health.js       Cloudflare Pages entry for /health
netlify/edge-functions/   Netlify edge function (index.js)
netlify.toml              Netlify config: publish dir + edge function paths
package.json              Deploys install hono automatically
scripts/dev.js            Local dev server (npm run dev)
relay-worker/             Cloudflare Worker relay (R2, chunked upload) — PUT/GET /p2p/<token>
  wrangler.toml
  src/index.js
  test.mjs
```

## Local dev

```sh
npm install
npm run dev
```

Open `http://localhost:3000`. The page and the API run on one origin.

## Deploy on Vercel

1. Import this repo in the Vercel dashboard.
2. Vercel detects `app.js` as the Hono app automatically. Static files come from `public/`.
3. Deploy. No config file needed.

## Deploy on Netlify

1. Import this repo in the Netlify dashboard.
2. `netlify.toml` sets `public/` as the publish dir and routes `/p2p/*` and `/health` to the edge function.
3. Deploy. No build command needed.

## Deploy on Cloudflare Pages

1. Create a Pages project in the Cloudflare dashboard and connect this repo.
2. Build command: leave empty. Build output directory: `public`.
3. Deploy. Pages serves `public/index.html` and runs the functions in `functions/`.

### Cloudflare (Pages static + Worker relay)

The `relay-worker/` Worker implements the same API as the Rust relay and the Hono app. The launcher needs no changes.

1. Pages: create a Pages project for this repo. No build command; output dir `.`.
2. Worker: `cd relay-worker && npx wrangler r2 bucket create pandora-relay && npx wrangler deploy`.
3. Point the `p2p-relay` meta tag in `index.html` (and the launcher config) at the Worker URL.
4. Test locally: `node relay-worker/test.mjs`.

Limits: Cloudflare caps request bodies at 100 MB (free) / 500 MB (paid).
`MAX_BYTES` in `wrangler.toml` defaults to 100 MB; larger bundles get a 413.
The free-plan cron trigger runs daily; exact 30-min TTL still holds because
every `GET` checks the age.

## Chunked upload protocol

The Hono app and the `relay-worker/` Worker accept the same optional headers on `PUT /p2p/<token>`:

- `X-Part-Index`: the part number, starts at 0. Default 0.
- `X-Total-Parts`: the total number of parts. Default 1.

Old clients that send no headers still work; a headerless PUT is a single-part
upload. The relay stores part `i` as `<token>.part<i>` and, when the part with
`X-Part-Index == X-Total-Parts - 1` arrives, concatenates all parts into
`<token>`, deletes the parts, and returns 200. The TTL starts when assembly
finishes. `MAX_BYTES` caps each part, so a bundle larger than one request can
be sent as multiple parts.

## Launcher config

Point the launcher at your deployment origin:

```json
{
  "p2p_relay_url": "https://<your-deploy>/",
  "p2p_pages_url": "https://<your-deploy>/"
}
```

A share becomes `https://<your-deploy>/?token=<token>`. The page fetches the bundle from the same origin, so no cross-site config is needed.

## Security and limits

- Token = `Uuid v4` in the path. Possession is the auth. Zip entries are validated by the receiver via `SafePath`.
- Bundles live in memory only. A fresh cold start can lose a bundle, so share links are short-lived by design.
- Default cap: 512 MiB per bundle. Default TTL: 30 minutes. Override with `MAX_BYTES` and `TTL_MINUTES` env vars where your platform exposes them.

## API

```
PUT /p2p/<token>    body=zip -> 200, cap MAX_BYTES
GET /p2p/<token>    -> application/zip or 404 after expiry
DELETE /p2p/<token> -> 204
GET /health         -> {"ok":true}
```
