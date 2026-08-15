import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import app from './app.js'

const server = new Hono()
server.route('/', app)
server.get('/', serveStatic({ path: './public/index.html' }))

const port = Number(process.env.PORT || 8080)
serve({ fetch: server.fetch, port })
console.log(`pandora-sync server: http://localhost:${port}`)