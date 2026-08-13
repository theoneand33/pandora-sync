# pandora-sync - separate website for P2P instance sync

Standalone repo for the launcher's sync link site. Deploy to **GitHub Pages** (static) or **Coolify** (relay + static).

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
.github/workflows/pages.yml  deploy to Pages on push
```

## How it connects to the launcher

`crates/backend/src/p2p_sync.rs` checks `BackendConfig.p2p_relay_url` + `p2p_pages_url`:

- empty → LAN direct `http://<lan-ip>:<port>/p2p/<token>` (ephemeral server, keep launcher open)
- set → `PUT https://relay.example.com/p2p/<token>` then share `https://relay.../p2p/<token>` and `https://pages.../?token=<token>`

Peer's launcher `GET`s the relay, or a browser hits the Pages site which `fetch()`es the relay and offers a zip download.

## Deploy

### GitHub Pages
1. Push this repo to `user/pandora-sync`.
2. Settings → Pages → Source: GitHub Actions.
3. Edit `<meta name="p2p-relay" content="https://relay.example.com">` in `index.html` to your Coolify URL.
4. Push — workflow deploys.

### Coolify (relay + optional static)
Coolify → New Service → From Git → pick this repo → set:
- Build pack: Dockerfile (`relay/Dockerfile`)
- Port: 8080
- Volume: `relay_data:/data`
- Env: `TTL_MINUTES=30`, `MAX_BYTES=2147483648`

Or `docker compose -f relay/docker-compose.yml up -d`.

See `relay/README.md` for API.

## Launcher config

`config.json`:
```json
{ "p2p_relay_url": "https://relay.example.com", "p2p_pages_url": "https://user.github.io/pandora-sync" }
```

## Security

Token = `Uuid v4` in path. Possession = auth. Zip entries validated via `SafePath`. 2 GiB cap. Relay TTL 30 min. No logs of full token.
