import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import app from '../app.js'

const dev = new Hono()
dev.route('/', app)
dev.get('/', serveStatic({ path: './public/index.html' }))

const port = Number(process.env.PORT || 3000)
serve({ fetch: dev.fetch, port })
console.log(`pandora-sync dev server: http://localhost:${port}`)