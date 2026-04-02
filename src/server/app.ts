import { existsSync } from 'node:fs'
import { extname, resolve } from 'node:path'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { requireSharedBearerAuth } from './lib/auth.js'
import { buildApiCorsOptions } from './lib/server-security.js'
import { accessRoutes } from './routes/access.js'
import { chatRoutes } from './routes/chat.js'
import { ticketRoutes } from './routes/tickets.js'
import { configRoutes } from './routes/config.js'
import { clientRequestRoutes } from './routes/client-requests.js'
import { incidentRoutes } from './routes/incidents.js'
import { explainRoutes } from './routes/explain.js'
import { directRoutes } from './routes/direct.js'
import { backgroundRunRoutes } from './routes/background-runs.js'

const DEFAULT_STATIC_ROOT = 'dist/web'
const WEB_ASSETS_MISSING_MESSAGE = 'Web assets not found. Run pnpm build first.'

export interface CreateAppOptions {
  staticRoot?: string
}

function isApiRequest(path: string) {
  return path === '/api' || path.startsWith('/api/')
}

function shouldServeStaticRequest(method: string, path: string) {
  return !isApiRequest(path) && (method === 'GET' || method === 'HEAD')
}

function shouldServeSpaFallback(path: string) {
  return path === '/' || extname(path) === ''
}

function hasBuiltWebAssets(staticRoot: string) {
  return existsSync(resolve(process.cwd(), staticRoot, 'index.html'))
}

export function createApp(options: CreateAppOptions = {}) {
  const app = new Hono()
  const staticRoot = options.staticRoot?.trim() || DEFAULT_STATIC_ROOT
  const builtWebAvailable = hasBuiltWebAssets(staticRoot)
  const serveWebAsset = serveStatic({ root: staticRoot })
  const serveIndexHtml = serveStatic({ root: staticRoot, path: 'index.html' })

  app.use('/api/*', cors(buildApiCorsOptions()))
  app.use('/api/*', requireSharedBearerAuth())

  app.get('/api/health', (c) => c.json({ status: 'ok' }))

  app.route('/api', chatRoutes)
  app.route('/api', ticketRoutes)
  app.route('/api', configRoutes)
  app.route('/api', clientRequestRoutes)
  app.route('/api', incidentRoutes)
  app.route('/api', accessRoutes)
  app.route('/api', explainRoutes)
  app.route('/api', directRoutes)
  app.route('/api', backgroundRunRoutes)

  if (!builtWebAvailable) {
    app.get('*', (c, next) => {
      if (isApiRequest(c.req.path)) {
        return next()
      }

      return c.text(WEB_ASSETS_MISSING_MESSAGE, 503)
    })

    app.on('HEAD', '*', (c, next) => {
      if (isApiRequest(c.req.path)) {
        return next()
      }

      return c.body(null, 503)
    })

    return app
  }

  app.use('*', async (c, next) => {
    if (!shouldServeStaticRequest(c.req.method, c.req.path)) {
      return next()
    }

    return serveWebAsset(c, next)
  })

  app.get('*', (c, next) => {
    if (isApiRequest(c.req.path) || !shouldServeSpaFallback(c.req.path)) {
      return next()
    }

    return serveIndexHtml(c, next)
  })

  app.on('HEAD', '*', (c, next) => {
    if (isApiRequest(c.req.path) || !shouldServeSpaFallback(c.req.path)) {
      return next()
    }

    return serveIndexHtml(c, next)
  })

  return app
}
