# relay — Coolify service

Implements:

```
PUT /p2p/<token>   body=zip, cap 2 GiB → /data/<token>
GET /p2p/<token>   → application/zip or 404
DELETE /p2p/<token> → 204
GET /health        → ok
```

Env: `DATA_DIR`, `PORT`, `TTL_MINUTES`, `MAX_BYTES`. Token sanitized `[A-Za-z0-9_-]` 8..128. TTL enforced by background sweeper.

Deploy via Coolify raw compose using `relay/docker-compose.yml`.
