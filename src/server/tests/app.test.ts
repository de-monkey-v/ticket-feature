import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { createApp } from '../app.js'

function createStaticFixture() {
  const distDir = join(process.cwd(), 'dist')
  mkdirSync(distDir, { recursive: true })

  const staticDir = mkdtempSync(join(distDir, 'app-test-static-'))
  const assetsDir = join(staticDir, 'assets')
  mkdirSync(assetsDir, { recursive: true })

  writeFileSync(
    join(staticDir, 'index.html'),
    '<!doctype html><html><head><title>Test App</title></head><body>Test App</body></html>',
    'utf8'
  )
  writeFileSync(join(assetsDir, 'app.js'), 'console.log("test app")\n', 'utf8')

  return {
    staticRoot: relative(process.cwd(), staticDir),
    cleanup() {
      rmSync(staticDir, { recursive: true, force: true })
    },
  }
}

test('createApp serves built web assets and SPA fallback routes', async () => {
  const fixture = createStaticFixture()

  try {
    const app = createApp({ staticRoot: fixture.staticRoot })

    const rootResponse = await app.request('http://localhost/')
    assert.equal(rootResponse.status, 200)
    assert.match(rootResponse.headers.get('content-type') || '', /text\/html/)
    assert.match(await rootResponse.text(), /Test App/)

    const assetResponse = await app.request('http://localhost/assets/app.js')
    assert.equal(assetResponse.status, 200)
    assert.match(assetResponse.headers.get('content-type') || '', /javascript|text\/plain/)
    assert.match(await assetResponse.text(), /console\.log/)

    const fallbackResponse = await app.request('http://localhost/settings')
    assert.equal(fallbackResponse.status, 200)
    assert.match(fallbackResponse.headers.get('content-type') || '', /text\/html/)
    assert.match(await fallbackResponse.text(), /Test App/)

    const missingAssetResponse = await app.request('http://localhost/assets/missing.js')
    assert.equal(missingAssetResponse.status, 404)
  } finally {
    fixture.cleanup()
  }
})

test('createApp keeps shared bearer auth on /api routes only', async () => {
  const previousToken = process.env.APP_SHARED_TOKEN
  process.env.APP_SHARED_TOKEN = 'secret-token'
  const fixture = createStaticFixture()

  try {
    const app = createApp({ staticRoot: fixture.staticRoot })

    const rootResponse = await app.request('http://localhost/')
    assert.equal(rootResponse.status, 200)

    const healthResponse = await app.request('http://localhost/api/health')
    assert.equal(healthResponse.status, 200)

    const unauthorizedResponse = await app.request('http://localhost/api/config')
    assert.equal(unauthorizedResponse.status, 401)

    const authorizedResponse = await app.request('http://localhost/api/config', {
      headers: {
        Authorization: 'Bearer secret-token',
      },
    })
    assert.equal(authorizedResponse.status, 200)
  } finally {
    fixture.cleanup()

    if (previousToken === undefined) {
      delete process.env.APP_SHARED_TOKEN
    } else {
      process.env.APP_SHARED_TOKEN = previousToken
    }
  }
})

test('createApp limits API CORS to allowlisted origins', async () => {
  const previousOrigins = process.env.APP_ALLOWED_ORIGINS
  process.env.APP_ALLOWED_ORIGINS = 'https://ticket.internal.example'
  const fixture = createStaticFixture()

  try {
    const app = createApp({ staticRoot: fixture.staticRoot })

    const devOriginResponse = await app.request('http://localhost/api/health', {
      headers: {
        Origin: 'http://localhost:5173',
      },
    })
    assert.equal(devOriginResponse.headers.get('access-control-allow-origin'), 'http://localhost:5173')

    const configuredOriginResponse = await app.request('http://localhost/api/health', {
      headers: {
        Origin: 'https://ticket.internal.example',
      },
    })
    assert.equal(
      configuredOriginResponse.headers.get('access-control-allow-origin'),
      'https://ticket.internal.example'
    )

    const deniedOriginResponse = await app.request('http://localhost/api/health', {
      headers: {
        Origin: 'https://malicious.example',
      },
    })
    assert.equal(deniedOriginResponse.headers.get('access-control-allow-origin'), null)
  } finally {
    fixture.cleanup()

    if (previousOrigins === undefined) {
      delete process.env.APP_ALLOWED_ORIGINS
    } else {
      process.env.APP_ALLOWED_ORIGINS = previousOrigins
    }
  }
})
