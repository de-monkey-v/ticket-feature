import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { Hono } from 'hono'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createOpenAuthSession } from '../lib/access-policy.js'
import { createAccessAccount, setAccessAccountPassword } from '../lib/access-control.js'
import { requireSharedBearerAuth } from '../lib/auth.js'
import { requireProjectById, toPublicConfig } from '../lib/projects.js'
import { RUNTIME_DATA_DIR_ENV, resolveRuntimeDataPath } from '../lib/runtime-data-paths.js'
import {
  assertApiAuthenticationConfigured,
  isOpenAccessOverrideEnabled,
  listAllowedApiCorsOrigins,
  resolveApiHostname,
} from '../lib/server-security.js'
import type { FlowsConfig } from '../lib/config.js'

const ACCESS_CONTROL_PATH_ENV = 'INTENTLANE_CODEX_ACCESS_CONTROL_PATH'

function createConfig(): FlowsConfig {
  return {
    defaultProjectId: 'intentlane-codex',
    projects: [
      {
        id: 'intentlane-codex',
        label: 'Intentlane',
        path: '/srv/intentlane-codex',
        verificationCommands: [
          {
            id: 'typecheck',
            label: 'Typecheck',
            command: 'pnpm typecheck',
            timeoutMs: 60_000,
            required: true,
          },
        ],
      },
    ],
    flows: {
      explain: {
        promptFile: 'prompts/explain.txt',
        model: 'gpt-5-codex',
        reasoningEffort: 'medium',
        serviceTier: 'fast',
      },
      requests: {
        screening: {
          promptFile: 'prompts/request-screening.txt',
          model: 'gpt-5.3-codex-spark',
          serviceTier: 'fast',
        },
      },
      ticket: {
        coordinator: {
          enabled: true,
          promptFile: 'prompts/ticket-coordinator.txt',
          model: 'gpt-5.4-mini',
          agent: {
            role: 'coordinator',
            displayName: 'Sisyphus',
          },
        },
        categories: [
          {
            id: 'feature',
            label: 'Feature Add',
            description: 'feature flow',
            steps: ['analyze', 'plan', 'approve', 'implement', 'review', 'ready'],
          },
        ],
        steps: [
          {
            id: 'analyze',
            name: 'Analyze',
            agent: {
              role: 'planner',
              displayName: 'Prometheus',
            },
            kind: 'agent',
            runMode: 'manual',
            promptFile: 'prompts/ticket-analyze.txt',
            sandboxMode: 'read-only',
            approvalPolicy: 'never',
            networkAccessEnabled: false,
            requiresApproval: false,
          },
          {
            id: 'plan',
            name: 'Plan',
            agent: {
              role: 'planner',
              displayName: 'Prometheus',
            },
            kind: 'agent',
            runMode: 'manual',
            promptFile: 'prompts/ticket-plan.txt',
            sandboxMode: 'read-only',
            approvalPolicy: 'never',
            networkAccessEnabled: false,
            requiresApproval: true,
          },
          {
            id: 'approve',
            name: 'Approve',
            kind: 'terminal',
            runMode: 'display',
            requiresApproval: true,
          },
          {
            id: 'implement',
            name: 'Implement',
            agent: {
              role: 'builder',
              displayName: 'Hephaestus',
            },
            kind: 'agent',
            runMode: 'manual',
            promptFile: 'prompts/ticket-implement.txt',
            sandboxMode: 'workspace-write',
            approvalPolicy: 'never',
            networkAccessEnabled: false,
            requiresApproval: false,
          },
          {
            id: 'review',
            name: 'Review',
            agent: {
              role: 'reviewer',
              displayName: 'Atlas',
            },
            kind: 'agent',
            runMode: 'automatic',
            promptFile: 'prompts/ticket-review.txt',
            sandboxMode: 'read-only',
            approvalPolicy: 'never',
            networkAccessEnabled: false,
            requiresApproval: false,
          },
          {
            id: 'ready',
            name: 'Ready',
            kind: 'terminal',
            runMode: 'display',
            requiresApproval: false,
          },
        ],
      },
    },
  }
}

test('requireSharedBearerAuth protects API routes and skips health', async () => {
  const originalToken = process.env.APP_SHARED_TOKEN
  process.env.APP_SHARED_TOKEN = 'secret-token'

  try {
    const app = new Hono()
    app.use('/api/*', requireSharedBearerAuth())
    app.get('/api/health', (c) => c.json({ ok: true }))
    app.get('/api/secure', (c) => c.json({ ok: true }))

    const healthResponse = await app.request('http://localhost/api/health')
    assert.equal(healthResponse.status, 200)

    const unauthorizedResponse = await app.request('http://localhost/api/secure')
    assert.equal(unauthorizedResponse.status, 401)

    const authorizedResponse = await app.request('http://localhost/api/secure', {
      headers: {
        Authorization: 'Bearer secret-token',
      },
    })
    assert.equal(authorizedResponse.status, 200)
  } finally {
    if (originalToken === undefined) {
      delete process.env.APP_SHARED_TOKEN
    } else {
      process.env.APP_SHARED_TOKEN = originalToken
    }
  }
})

test('requireSharedBearerAuth allows requests when shared token auth is disabled', async () => {
  const originalToken = process.env.APP_SHARED_TOKEN
  const previousAccessPath = process.env[ACCESS_CONTROL_PATH_ENV]
  const tempDir = mkdtempSync(join(tmpdir(), 'intentlane-codex-security-open-test-'))
  delete process.env.APP_SHARED_TOKEN
  process.env[ACCESS_CONTROL_PATH_ENV] = join(tempDir, 'access-control.json')

  try {
    const app = new Hono()
    app.use('/api/*', requireSharedBearerAuth())
    app.get('/api/secure', (c) => c.json({ ok: true }))

    const response = await app.request('http://localhost/api/secure')
    assert.equal(response.status, 200)
  } finally {
    if (originalToken === undefined) {
      delete process.env.APP_SHARED_TOKEN
    } else {
      process.env.APP_SHARED_TOKEN = originalToken
    }

    if (previousAccessPath === undefined) {
      delete process.env[ACCESS_CONTROL_PATH_ENV]
    } else {
      process.env[ACCESS_CONTROL_PATH_ENV] = previousAccessPath
    }

    rmSync(tempDir, { recursive: true, force: true })
  }
})

test('requireSharedBearerAuth requires login when password-based accounts exist', async () => {
  const previousToken = process.env.APP_SHARED_TOKEN
  const previousAccessPath = process.env[ACCESS_CONTROL_PATH_ENV]
  const tempDir = mkdtempSync(join(tmpdir(), 'intentlane-codex-security-test-'))
  delete process.env.APP_SHARED_TOKEN
  process.env[ACCESS_CONTROL_PATH_ENV] = join(tempDir, 'access-control.json')

  try {
    const account = createAccessAccount({
      name: 'Grace',
      permissions: ['explain'],
      projectIds: ['intentlane-codex'],
    })
    setAccessAccountPassword(account.id, 'grace-pass')

    const app = new Hono()
    app.use('/api/*', requireSharedBearerAuth())
    app.get('/api/secure', (c) => c.json({ ok: true }))

    const response = await app.request('http://localhost/api/secure')
    assert.equal(response.status, 401)
  } finally {
    if (previousToken === undefined) {
      delete process.env.APP_SHARED_TOKEN
    } else {
      process.env.APP_SHARED_TOKEN = previousToken
    }

    if (previousAccessPath === undefined) {
      delete process.env[ACCESS_CONTROL_PATH_ENV]
    } else {
      process.env[ACCESS_CONTROL_PATH_ENV] = previousAccessPath
    }

    rmSync(tempDir, { recursive: true, force: true })
  }
})

test('toPublicConfig hides filesystem paths from the browser', () => {
  const publicConfig = toPublicConfig(createConfig(), createOpenAuthSession())

  assert.deepEqual(publicConfig.allowedProjects, [
    {
      id: 'intentlane-codex',
      label: 'Intentlane',
      deletable: false,
    },
  ])
  assert.equal(publicConfig.defaultProjectId, 'intentlane-codex')
  assert.equal('path' in publicConfig.allowedProjects[0], false)
  assert.equal('verificationCommands' in publicConfig.allowedProjects[0], false)
  assert.equal(publicConfig.flows.ticket.categories[0]?.steps[0]?.runMode, 'manual')
  assert.equal(publicConfig.flows.ticket.categories[0]?.steps[0]?.agent?.displayName, 'Prometheus')
  assert.equal(publicConfig.flows.ticket.categories[0]?.steps[4]?.agent?.displayName, 'Atlas')
  assert.equal(publicConfig.flows.ticket.coordinator?.agent?.displayName, 'Sisyphus')
  assert.equal(publicConfig.flows.ticket.categories[0]?.id, 'feature')
  assert.equal(publicConfig.explain.availableModels.length, 5)
  assert.equal(publicConfig.explain.availableModels[0]?.id, 'gpt-5.4')
  assert.deepEqual(publicConfig.explain.availableModels[0]?.supportedReasoningEfforts, ['low', 'medium', 'high', 'xhigh'])
  assert.equal(publicConfig.explain.selectedModel, 'gpt-5.4')
  assert.equal(publicConfig.explain.selectedReasoningEffort, 'medium')
  assert.equal(publicConfig.requests.screening.availableModels[0]?.id, 'gpt-5.3-codex-spark')
  assert.equal(publicConfig.requests.screening.selectedModel, 'gpt-5.3-codex-spark')
})

test('requireProjectById resolves allowlisted projects only', () => {
  const config = createConfig()

  assert.equal(requireProjectById(config, 'intentlane-codex').path, '/srv/intentlane-codex')
  assert.throws(() => requireProjectById(config, 'unknown-project'), /Unknown project/)
})

test('server startup rejects open API access unless explicitly overridden', () => {
  assert.throws(
    () =>
      assertApiAuthenticationConfigured({
        apiAuthEnabled: false,
        allowOpenAccess: false,
      }),
    /API authentication is not configured/
  )

  assert.doesNotThrow(() =>
    assertApiAuthenticationConfigured({
      apiAuthEnabled: false,
      allowOpenAccess: true,
    })
  )
  assert.doesNotThrow(() =>
    assertApiAuthenticationConfigured({
      apiAuthEnabled: true,
      allowOpenAccess: false,
    })
  )
})

test('server security helpers default to external host binding and explicit origin allowlists', () => {
  assert.equal(resolveApiHostname(undefined), '0.0.0.0')
  assert.equal(isOpenAccessOverrideEnabled('true'), true)
  assert.equal(isOpenAccessOverrideEnabled(undefined), false)
  assert.deepEqual(listAllowedApiCorsOrigins('https://ticket.internal.example/'), [
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    'https://ticket.internal.example',
  ])
  assert.throws(() => listAllowedApiCorsOrigins('*'), /\*"/)
})

test('access control defaults can be isolated under INTENTLANE_CODEX_DATA_DIR', () => {
  const previousDataDir = process.env[RUNTIME_DATA_DIR_ENV]
  const tempDir = mkdtempSync(join(tmpdir(), 'intentlane-codex-runtime-data-test-'))
  process.env[RUNTIME_DATA_DIR_ENV] = tempDir

  try {
    const account = createAccessAccount({
      name: 'isolated-admin',
      isAdmin: true,
    })

    assert.match(account.id, /^acct_/)
    assert.equal(existsSync(resolveRuntimeDataPath('access-control.json')), true)
  } finally {
    if (previousDataDir === undefined) {
      delete process.env[RUNTIME_DATA_DIR_ENV]
    } else {
      process.env[RUNTIME_DATA_DIR_ENV] = previousDataDir
    }

    rmSync(tempDir, { recursive: true, force: true })
  }
})
