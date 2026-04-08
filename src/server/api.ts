import { serve } from '@hono/node-server'
import { createApp } from './app.js'
import { bootstrapApiProcess } from './bootstrap.js'
import { isApiAuthEnabled } from './lib/auth.js'
import { loadAppEnvFile } from './lib/env.js'
import {
  assertApiAuthenticationConfigured,
  isOpenAccessOverrideEnabled,
  resolveApiHostname,
} from './lib/server-security.js'

loadAppEnvFile()

bootstrapApiProcess()

const app = createApp()

const port = Number(process.env.PORT?.trim() || '4000')
const hostname = resolveApiHostname()

assertApiAuthenticationConfigured({
  apiAuthEnabled: isApiAuthEnabled(),
  allowOpenAccess: isOpenAccessOverrideEnabled(),
})

const displayHost = hostname === '0.0.0.0' ? 'localhost' : hostname

console.log(`API server running at http://${displayHost}:${port}`)

serve({ fetch: app.fetch, port, hostname })
