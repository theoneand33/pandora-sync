import { handle } from 'hono/cloudflare-pages'
import app from '../../app.js'

export const onRequest = handle(app)