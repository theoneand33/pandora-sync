# relay — Coolify service

Implements:

```
PUT /p2p/<token>   body=chunk, headers X-Part-Index/X-Total-Parts → /data/<token>
GET /p2p/<token>   → application/zip or 404
DELETE /p2p/<token> → 204
GET /health        → ok
```

Env: `DATA_DIR`, `PORT`, `TTL_MINUTES`, `MAX_BYTES`. Token sanitized `[A-Za-z0-9_-]` 8..128. TTL enforced by background sweeper.

## Chunked upload

`PUT /p2p/<token>` accepts two optional headers:

- `X-Part-Index`: the part number, starts at 0. Default 0.
- `X-Total-Parts`: the total number of parts. Default 1.

A PUT with no headers is the old single-shot upload and still works.
The relay stores part `i` as `/data/<token>.part<i>`. When the last part
(`X-Part-Index == X-Total-Parts - 1`) arrives, it concatenates the parts into
`/data/<token>`, deletes the parts, and returns 200. The TTL starts when the
bundle is assembled. `MAX_BYTES` caps each part. Stale parts are reclaimed by
the TTL sweeper.

Test with `cargo test` (part header parsing + assembly).

Deploy via Coolify raw compose using `relay/docker-compose.yml`.
