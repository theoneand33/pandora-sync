import { Hono } from 'hono'
import { serveStatic } from 'hono/deno'
import app from './app.js'

const server = new Hono()
server.route('/', app)
server.get('/', serveStatic({ path: './public/index.html' }))

Deno.serve((req, info) => server.fetch(req, Deno.env.toObject(), info))