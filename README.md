# pandora-sync - separate website for P2P instance sync

Standalone repo for the launcher's sync link site. Deploy to **GitHub Pages** or **Cloudflare Pages** (static) plus **Coolify** or **Cloudflare Workers** (relay).

Original launcher stays offline and vendored. This repo holds only the domain website.

## Layout

```
index.html          static GH Pages page (fetch from relay)
README.md           this file
relay/              tiny relay for Coolify — PUT/GET /p2p/<token>
  Cargo.toml
  src/main.rs
  Dockerfile
  docker-compose.yml
relay-worker/       same relay API as a Cloudflare Worker — PUT/GET /p2p/<token>
  wrangler.toml
  src/index.js
  test.mjs
.github/workflows/pages.yml  deploy to Pages on push
```

## How it connects to the launcher

`crates/backend/src/p2p_sync.rs` checks `BackendConfig.p2p_relay_url` + `p2p_pages_url`:

- empty → LAN direct `http://<lan-ip>:<port>/p2p/<token>` (ephemeral server, keep launcher open)
- set → `PUT https://relay.theoneand33.dev/p2p/<token>` then share `https://relay.theoneand33.dev/p2p/<token>` and `https://theoneand33.github.io/pandora-sync/?token=<token>`

Peer's launcher `GET`s the relay, or a browser hits the Pages site which `fetch()`es the relay and offers a zip download.

## Deploy

### GitHub Pages
1. Push this repo to `user/pandora-sync`.
2. Settings → Pages → Source: GitHub Actions.
3. `<meta name="p2p-relay" content="https://relay.theoneand33.dev">` is already set in `index.html`.
4. Push — workflow deploys to `https://theoneand33.github.io/pandora-sync/`.

### Coolify (relay + optional static)
Coolify → New Service → From Git → pick this repo → set:
- Build pack: Dockerfile (`relay/Dockerfile`)
- Port: 8080
- Volume: `relay_data:/data`
- Env: `TTL_MINUTES=30`, `MAX_BYTES=2147483648`

Or `docker compose -f relay/docker-compose.yml up -d`.

See `relay/README.md` for API.

### Cloudflare (Pages static + Worker relay)

The `relay-worker/` Worker implements the same API as the Rust relay. The launcher
needs no changes.

1. Pages: create a Pages project for this repo. No build command; output dir `.`.
2. Worker: `cd relay-worker && npx wrangler r2 bucket create pandora-relay && npx wrangler deploy`.
3. Point the `p2p-relay` meta tag in `index.html` (and the launcher config) at the Worker URL.
4. Test locally: `node relay-worker/test.mjs`.

Limits: Cloudflare caps request bodies at 100 MB (free) / 500 MB (paid).
`MAX_BYTES` in `wrangler.toml` defaults to 100 MB; larger bundles get a 413.
The free-plan cron trigger runs daily; exact 30-min TTL still holds because
every `GET` checks the age.

## Chunked upload protocol

Both relays accept the same optional headers on `PUT /p2p/<token>`:

- `X-Part-Index`: the part number, starts at 0. Default 0.
- `X-Total-Parts`: the total number of parts. Default 1.

Old clients that send no headers still work; a headerless PUT is a single-part
upload. The relay stores part `i` as `<token>.part<i>` and, when the part with
`X-Part-Index == X-Total-Parts - 1` arrives, concatenates all parts into
`<token>`, deletes the parts, and returns 200. The TTL starts when assembly
finishes. `MAX_BYTES` caps each part, so a bundle larger than one request can
be sent as multiple parts.

## Launcher config

`config.json` (or Settings → Network → P2P):
```json
{ "p2p_relay_url": "https://relay.theoneand33.dev", "p2p_pages_url": "https://theoneand33.github.io/pandora-sync/" }
```

## Security

Token = `Uuid v4` in path. Possession = auth. Zip entries validated via `SafePath`. 2 GiB cap. Relay TTL 30 min. No logs of full token.
