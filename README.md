# Pandora sync - instance sharing for Pandora launcher enhanced

This repository hosts the share page and the relay backend on one origin.
Deploy it once on Deno Deploy, Netlify, Cloudflare Pages, or Google Cloud Run.
You do not need a second service.

The launcher uploads a filtered zip with `PUT /p2p/<token>`.
The share page fetches the zip with `GET /p2p/<token>` and offers a download.
The page and the API share the same origin, so no cross-site setup is required.

## Deploy on Deno Deploy — Recommended

Deno Deploy is the recommended free option. `main.ts:7` serves `public/index.html` at `/` and `main.ts:6` mounts `app.js:46`, so one project hosts the page and the API. The free tier gives you 1M requests, 20 GB of egress, and 15 hours of CPU per month. It has no small request-body cap like serverless function platforms, so the full 512 MiB default works.

[![Deploy on Deno](https://deno.com/button)](https://console.deno.com/new?clone=https://github.com/theoneand33/pandora-sync)

1. Click the button and connect your GitHub account.
2. Let the flow clone this repository and create a project.
3. Confirm that the entry point is `main.ts`.
4. Deploy the project.
5. Test the deployment at `https://<your-deploy>/health`.

`main.ts:9` passes `Deno.env` as the Hono env, so `app.js:10` reads `TTL_MINUTES` and `MAX_BYTES` from the Deno Deploy dashboard.
`deno.json` maps the bare `hono` imports in `app.js:1` to `npm:hono`.
The store is in-memory per isolate. A cold start can delete bundles.

## Deploy on Netlify

Netlify is an easy free option. `netlify.toml:1` already sets the publish directory and the edge routes, so you only import the repo and deploy.

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

## Deploy on Google Cloud Run

Google Cloud Run runs `server.js:11` as a long-lived Node.js service and `server.js:8` serves `public/index.html` at `/`. `Dockerfile` and `app.json` are already present, so the button builds and deploys the container.

[![Run on Google Cloud](https://deploy.cloud.run/button.svg)](https://deploy.cloud.run/?git_repo=https://github.com/theoneand33/pandora-sync.git)

1. Click the button and sign in to Google Cloud.
2. Confirm the values that `app.json` sets: env vars, memory, HTTP/2, and one instance.
3. Let the button build `Dockerfile:1` and deploy the service.
4. Test the deployment at `https://<your-deploy>/health`.

`app.json:4` sets `TTL_MINUTES` and `app.json:9` sets `MAX_BYTES`. `app.json:20` enables HTTP/2 end-to-end, which removes the 32 MiB HTTP/1 request cap that Cloud Run applies.
`app.json:22` sets one instance, so the in-memory store in `app.js:7` is not split across instances. A cold start or instance recycle can delete bundles.
The always-free tier includes 2M requests and 360K GB-seconds a month, but only 1 GB of egress. A large share consumes egress fast, so Cloud Run free suits small bundles better than Deno Deploy does.

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
