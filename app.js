import { Hono } from 'hono'
import { cors } from 'hono/cors'

const DEFAULT_TTL_MINUTES = 30
const DEFAULT_MAX_BYTES = 512 * 1024 * 1024

const store = new Map()
const parts = new Map()

function env(c, key, fallback) {
  const fromContext = c?.env?.[key]
  if (fromContext !== undefined) return fromContext
  if (typeof process !== 'undefined') {
    const fromNode = process.env[key]
    if (fromNode !== undefined) return fromNode
  }
  return fallback
}

function ttlMs(c) {
  const minutes = parseInt(env(c, 'TTL_MINUTES', String(DEFAULT_TTL_MINUTES)), 10)
  return (Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_TTL_MINUTES) * 60 * 1000
}

function maxBytes(c) {
  const bytes = parseInt(env(c, 'MAX_BYTES', String(DEFAULT_MAX_BYTES)), 10)
  return Number.isFinite(bytes) && bytes > 0 ? bytes : DEFAULT_MAX_BYTES
}

function sanitize(token) {
  if (typeof token !== 'string' || token.length < 8 || token.length > 128) return null
  if (!/^[A-Za-z0-9_-]+$/.test(token)) return null
  return token
}

function parsePartHeaders(c) {
  const idxRaw = c.req.header('x-part-index')
  const totalRaw = c.req.header('x-total-parts')
  const idx = idxRaw === undefined ? 0 : Number(idxRaw)
  const total = totalRaw === undefined ? 1 : Number(totalRaw)
  if (!Number.isInteger(idx) || !Number.isInteger(total)) return null
  if (total < 1 || idx < 0 || idx >= total) return null
  return { idx, total }
}

const app = new Hono()

app.use('/p2p/*', cors())

app.get('/health', (c) => c.json({ ok: true }))

app.put('/p2p/:token', async (c) => {
  const token = sanitize(c.req.param('token'))
  if (!token) return c.text('bad token', 400)
  const body = await c.req.arrayBuffer()
  if (body.byteLength > maxBytes(c)) return c.text('too large', 413)
  const part = parsePartHeaders(c)
  if (!part) return c.text('bad part headers', 400)
  const { idx, total } = part

  if (total === 1) {
    parts.delete(token)
    store.set(token, { body, expiresAt: Date.now() + ttlMs(c) })
    return c.text('ok')
  }

  let entry = parts.get(token)
  if (!entry) {
    entry = { total, createdAt: Date.now(), map: new Map() }
    parts.set(token, entry)
  } else if (entry.total !== total) {
    return c.text('bad part headers', 400)
  }

  entry.map.set(idx, new Uint8Array(body))

  if (idx + 1 === total && !store.has(token)) {
    for (let i = 0; i < total; i++) {
      if (!entry.map.has(i)) return c.text('missing part', 500)
    }
    let totalLen = 0
    for (let i = 0; i < total; i++) totalLen += entry.map.get(i).byteLength
    const out = new Uint8Array(totalLen)
    let offset = 0
    for (let i = 0; i < total; i++) {
      const p = entry.map.get(i)
      out.set(p, offset)
      offset += p.byteLength
    }
    store.set(token, { body: out.buffer, expiresAt: Date.now() + ttlMs(c) })
    parts.delete(token)
  }

  return c.text('ok')
})

app.get('/p2p/:token', (c) => {
  const token = sanitize(c.req.param('token'))
  if (!token) return c.text('bad token', 400)
  const item = store.get(token)
  if (!item) return c.text('not found', 404)
  if (Date.now() > item.expiresAt) {
    store.delete(token)
    return c.text('not found', 404)
  }
  return c.body(item.body, 200, {
    'Content-Type': 'application/zip',
    'Content-Disposition': 'attachment; filename="share.zip"',
  })
})

app.delete('/p2p/:token', (c) => {
  const token = sanitize(c.req.param('token'))
  if (!token) return c.text('bad token', 400)
  store.delete(token)
  parts.delete(token)
  return new Response(null, { status: 204 })
})

if (typeof setInterval === 'function') {
  setInterval(() => {
    const now = Date.now()
    for (const [key, item] of store) {
      if (now > item.expiresAt) store.delete(key)
    }
    for (const [key, entry] of parts) {
      const ttl = DEFAULT_TTL_MINUTES * 60 * 1000
      if (now - entry.createdAt > ttl) parts.delete(key)
    }
  }, 60 * 1000)
}

export default app
