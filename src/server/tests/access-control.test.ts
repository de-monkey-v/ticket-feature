import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import {
  authenticateAccessToken,
  authenticateAccountSession,
  createAccessAccount,
  createAccessToken,
  createAccountSession,
  loadAccessControl,
  revokeAccessToken,
  setAccessAccountPassword,
} from '../lib/access-control.js'
import { getAuthSession, requireSharedBearerAuth } from '../lib/auth.js'
import type { FlowsConfig } from '../lib/config.js'
import { toPublicConfig } from '../lib/projects.js'
import { accessRoutes } from '../routes/access.js'
import { ticketRoutes } from '../routes/tickets.js'

const ACCESS_CONTROL_PATH_ENV = 'INTENTLANE_CODEX_ACCESS_CONTROL_PATH'
const BOOTSTRAP_ROOT_ENABLED_ENV = 'INTENTLANE_CODEX_BOOTSTRAP_ROOT_ENABLED'

function createConfig(): FlowsConfig {
  return {
    defaultProjectId: 'backend',
    projects: [
      {
        id: 'frontend',
        label: 'Frontend',
        path: '/srv/frontend',
        verificationCommands: [
          {
            id: 'typecheck',
            label: 'Typecheck',
            command: 'pnpm typecheck',
          },
        ],
      },
      {
        id: 'backend',
        label: 'Backend',
        path: '/srv/backend',
        verificationCommands: [
          {
            id: 'test',
            label: 'Test',
            command: 'pnpm test',
          },
        ],
      },
    ],
    flows: {
      explain: {
        promptFile: 'prompts/explain.txt',
        model: 'gpt-5.4',
        reasoningEffort: 'medium',
      },
      requests: {
        screening: {
          promptFile: 'prompts/request-screening.txt',
          model: 'gpt-5.3-codex-spark',
        },
      },
      ticket: {
        categories: [
          {
            id: 'feature',
            label: 'Feature',
            description: 'feature flow',
            steps: ['analyze', 'plan', 'implement', 'review', 'ready'],
          },
        ],
        steps: [
          {
            id: 'analyze',
            name: 'Analyze',
            kind: 'agent',
            runMode: 'manual',
            requiresApproval: false,
            agent: { role: 'planner', displayName: 'Prometheus' },
          },
          {
            id: 'plan',
            name: 'Plan',
            kind: 'agent',
            runMode: 'manual',
            requiresApproval: false,
            agent: { role: 'planner', displayName: 'Prometheus' },
          },
          {
            id: 'implement',
            name: 'Implement',
            kind: 'agent',
            runMode: 'manual',
            requiresApproval: false,
            agent: { role: 'builder', displayName: 'Hephaestus' },
          },
          {
            id: 'review',
            name: 'Review',
            kind: 'agent',
            runMode: 'automatic',
            requiresApproval: false,
            agent: { role: 'reviewer', displayName: 'Atlas' },
          },
          { id: 'ready', name: 'Ready', kind: 'terminal', runMode: 'display', requiresApproval: false },
        ],
      },
    },
  }
}

function withAccessControlEnv(fn: () => Promise<void> | void) {
  return async () => {
    const previousAccessPath = process.env[ACCESS_CONTROL_PATH_ENV]
    const tempDir = mkdtempSync(join(tmpdir(), 'intentlane-codex-access-control-test-'))
    process.env[ACCESS_CONTROL_PATH_ENV] = join(tempDir, 'access-control.json')

    try {
      await fn()
    } finally {
      if (previousAccessPath === undefined) {
        delete process.env[ACCESS_CONTROL_PATH_ENV]
      } else {
        process.env[ACCESS_CONTROL_PATH_ENV] = previousAccessPath
      }
      rmSync(tempDir, { recursive: true, force: true })
    }
  }
}

test(
  'managed access tokens authenticate scoped sessions and filter public config',
  withAccessControlEnv(() => {
    const account = createAccessAccount({ name: 'Alice' })
    const created = createAccessToken({
      accountId: account.id,
      label: 'frontend-explain',
      permissions: ['explain'],
      projectIds: ['frontend'],
    })

    const session = authenticateAccessToken(created.token)
    assert.ok(session)
    assert.equal(session?.accountName, 'Alice')
    assert.deepEqual(session?.permissions, ['explain'])
    assert.deepEqual(session?.projectIds, ['frontend'])

    const publicConfig = toPublicConfig(createConfig(), session!)
    assert.equal(publicConfig.defaultProjectId, 'frontend')
    assert.deepEqual(
      publicConfig.allowedProjects.map((project) => project.id),
      ['frontend']
    )
    assert.equal(publicConfig.auth.session.accountName, 'Alice')
    assert.deepEqual(publicConfig.auth.session.permissions, ['explain'])
    assert.equal(publicConfig.flows.ticket.categories[0]?.steps[0]?.agent?.displayName, 'Prometheus')
  })
)

test(
  'bootstrap root account is created when enabled and access control is empty',
  withAccessControlEnv(() => {
    const previousSharedToken = process.env.APP_SHARED_TOKEN
    const previousBootstrap = process.env[BOOTSTRAP_ROOT_ENABLED_ENV]
    process.env.APP_SHARED_TOKEN = 'bootstrap-secret'
    process.env[BOOTSTRAP_ROOT_ENABLED_ENV] = 'true'

    try {
      const data = loadAccessControl()
      assert.equal(data.accounts.length, 1)
      assert.equal(data.accounts[0]?.name, 'root')
      assert.equal(data.accounts[0]?.isAdmin, true)
      assert.equal(data.accounts[0]?.mustChangePassword, true)

      const session = createAccountSession({
        name: 'root',
        password: 'bootstrap-secret',
      })
      assert.equal(typeof session.token, 'string')

      const authenticated = authenticateAccountSession(session.token)
      assert.equal(authenticated?.mustChangePassword, true)
    } finally {
      if (previousSharedToken === undefined) {
        delete process.env.APP_SHARED_TOKEN
      } else {
        process.env.APP_SHARED_TOKEN = previousSharedToken
      }

      if (previousBootstrap === undefined) {
        delete process.env[BOOTSTRAP_ROOT_ENABLED_ENV]
      } else {
        process.env[BOOTSTRAP_ROOT_ENABLED_ENV] = previousBootstrap
      }
    }
  })
)

test(
  'requireSharedBearerAuth accepts managed tokens and rejects revoked tokens',
  withAccessControlEnv(async () => {
    const account = createAccessAccount({ name: 'Bob' })
    const created = createAccessToken({
      accountId: account.id,
      label: 'frontend-reader',
      permissions: ['explain'],
      projectIds: ['intentlane-codex'],
    })

    const app = new Hono()
    app.use('/api/*', requireSharedBearerAuth())
    app.get('/api/secure', (c) => c.json({ ok: true }))

    const allowed = await app.request('http://localhost/api/secure', {
      headers: {
        Authorization: `Bearer ${created.token}`,
      },
    })
    assert.equal(allowed.status, 200)

    revokeAccessToken(created.record.id)

    const denied = await app.request('http://localhost/api/secure', {
      headers: {
        Authorization: `Bearer ${created.token}`,
      },
    })
    assert.equal(denied.status, 401)
  })
)

test(
  'account password login creates scoped sessions and public config respects account access',
  withAccessControlEnv(() => {
    const account = createAccessAccount({
      name: 'Eve',
      permissions: ['requests'],
      projectIds: ['backend'],
    })
    setAccessAccountPassword(account.id, 'super-secret')

    const created = createAccountSession({
      name: 'Eve',
      password: 'super-secret',
    })

    const session = authenticateAccountSession(created.token)
    assert.ok(session)
    assert.equal(session?.kind, 'account_session')
    assert.equal(session?.accountName, 'Eve')
    assert.deepEqual(session?.permissions, ['requests'])
    assert.deepEqual(session?.projectIds, ['backend'])

    const publicConfig = toPublicConfig(createConfig(), session!)
    assert.equal(publicConfig.defaultProjectId, 'backend')
    assert.deepEqual(
      publicConfig.allowedProjects.map((project) => project.id),
      ['backend']
    )
    assert.equal(publicConfig.auth.session.mustChangePassword, false)
  })
)

test(
  'must-change-password sessions can only use config and self-service password update until changed',
  withAccessControlEnv(async () => {
    const account = createAccessAccount({
      name: 'Heidi',
      permissions: ['tickets'],
      projectIds: ['backend'],
    })
    setAccessAccountPassword(account.id, 'initial-pass', { requirePasswordChange: true })

    const created = createAccountSession({
      name: 'Heidi',
      password: 'initial-pass',
    })

    const app = new Hono()
    app.use('/api/*', requireSharedBearerAuth())
    app.get('/api/config', (c) => c.json(toPublicConfig(createConfig(), getAuthSession(c))))
    app.get('/api/secure', (c) => c.json({ ok: true }))
    app.route('/api', accessRoutes)

    const configResponse = await app.request('http://localhost/api/config', {
      headers: {
        Authorization: `Bearer ${created.token}`,
      },
    })
    assert.equal(configResponse.status, 200)
    const configPayload = await configResponse.json()
    assert.equal(configPayload.auth.session.mustChangePassword, true)

    const blockedResponse = await app.request('http://localhost/api/secure', {
      headers: {
        Authorization: `Bearer ${created.token}`,
      },
    })
    assert.equal(blockedResponse.status, 403)
    const blockedPayload = await blockedResponse.json()
    assert.equal(blockedPayload.code, 'PASSWORD_CHANGE_REQUIRED')

    const changePasswordResponse = await app.request('http://localhost/api/access/me/password', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${created.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        currentPassword: 'initial-pass',
        newPassword: 'updated-pass',
      }),
    })
    assert.equal(changePasswordResponse.status, 200)

    const updatedSession = authenticateAccountSession(created.token)
    assert.equal(updatedSession?.mustChangePassword, false)

    const allowedResponse = await app.request('http://localhost/api/secure', {
      headers: {
        Authorization: `Bearer ${created.token}`,
      },
    })
    assert.equal(allowedResponse.status, 200)
  })
)

test(
  'ticket routes reject tokens without ticket permission',
  withAccessControlEnv(async () => {
    const account = createAccessAccount({ name: 'Carol' })
    const created = createAccessToken({
      accountId: account.id,
      label: 'explain-only',
      permissions: ['explain'],
      projectIds: ['intentlane-codex'],
    })

    const app = new Hono()
    app.use('/api/*', requireSharedBearerAuth())
    app.route('/api', ticketRoutes)

    const response = await app.request('http://localhost/api/tickets?projectId=intentlane-codex', {
      headers: {
        Authorization: `Bearer ${created.token}`,
      },
    })

    assert.equal(response.status, 403)
    const payload = await response.json()
    assert.equal(payload.code, 'FEATURE_FORBIDDEN')
  })
)

test(
  'login route is reachable without bearer token and returns a session token',
  withAccessControlEnv(async () => {
    const account = createAccessAccount({
      name: 'Frank',
      permissions: ['tickets'],
      projectIds: ['intentlane-codex'],
    })
    setAccessAccountPassword(account.id, 'account-pass')

    const app = new Hono()
    app.use('/api/*', requireSharedBearerAuth())
    app.route('/api', accessRoutes)

    const response = await app.request('http://localhost/api/access/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'Frank',
        password: 'account-pass',
      }),
    })

    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.equal(typeof payload.token, 'string')
    assert.equal(payload.session.accountName, 'Frank')
    assert.equal(payload.session.status, 'active')
  })
)

test(
  'logout route revokes account sessions and returns ok',
  withAccessControlEnv(async () => {
    const account = createAccessAccount({
      name: 'Grace',
      permissions: ['explain'],
      projectIds: ['frontend'],
    })
    setAccessAccountPassword(account.id, 'logout-pass')

    const created = createAccountSession({
      name: 'Grace',
      password: 'logout-pass',
    })

    const app = new Hono()
    app.use('/api/*', requireSharedBearerAuth())
    app.route('/api', accessRoutes)

    const response = await app.request('http://localhost/api/access/logout', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${created.token}`,
      },
    })

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { ok: true })
    assert.equal(authenticateAccountSession(created.token), null)
  })
)

test('access routes require admin and shared token can create accounts', async () => {
  const previousSharedToken = process.env.APP_SHARED_TOKEN
  const previousAccessPath = process.env[ACCESS_CONTROL_PATH_ENV]
  const tempDir = mkdtempSync(join(tmpdir(), 'intentlane-codex-access-route-test-'))
  process.env.APP_SHARED_TOKEN = 'shared-admin'
  process.env[ACCESS_CONTROL_PATH_ENV] = join(tempDir, 'access-control.json')

  try {
    const app = new Hono()
    app.use('/api/*', requireSharedBearerAuth())
    app.route('/api', accessRoutes)

    const unauthorized = await app.request('http://localhost/api/access')
    assert.equal(unauthorized.status, 401)

    const createResponse = await app.request('http://localhost/api/access/accounts', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer shared-admin',
      },
      body: JSON.stringify({ name: 'Dana' }),
    })

    assert.equal(createResponse.status, 200)
    const created = await createResponse.json()
    assert.equal(created.name, 'Dana')
  } finally {
    if (previousSharedToken === undefined) {
      delete process.env.APP_SHARED_TOKEN
    } else {
      process.env.APP_SHARED_TOKEN = previousSharedToken
    }

    if (previousAccessPath === undefined) {
      delete process.env[ACCESS_CONTROL_PATH_ENV]
    } else {
      process.env[ACCESS_CONTROL_PATH_ENV] = previousAccessPath
    }

    rmSync(tempDir, { recursive: true, force: true })
  }
})
