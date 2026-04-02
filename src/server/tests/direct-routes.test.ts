import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { createAccessAccount, createAccessToken } from '../lib/access-control.js'
import { requireSharedBearerAuth } from '../lib/auth.js'
import type { RunCodexTurnOptions } from '../services/codex-sdk.js'
import { directRoutes, resetRunCodexTurnForDirectTesting, setRunCodexTurnForDirectTesting } from '../routes/direct.js'

const RUNTIME_DATA_DIR_ENV = 'INTENTLANE_CODEX_DATA_DIR'

function withRuntimeDataEnv(fn: () => Promise<void> | void) {
  return async () => {
    const previousDataDir = process.env[RUNTIME_DATA_DIR_ENV]
    const tempDir = mkdtempSync(join(tmpdir(), 'intentlane-codex-direct-route-test-'))
    process.env[RUNTIME_DATA_DIR_ENV] = tempDir

    try {
      await fn()
    } finally {
      if (previousDataDir === undefined) {
        delete process.env[RUNTIME_DATA_DIR_ENV]
      } else {
        process.env[RUNTIME_DATA_DIR_ENV] = previousDataDir
      }

      rmSync(tempDir, { recursive: true, force: true })
    }
  }
}

test(
  'direct state is isolated per account while remaining shared across the same account tokens',
  withRuntimeDataEnv(async () => {
    const alice = createAccessAccount({ name: 'Alice', permissions: ['direct'], projectIds: ['intentlane-codex'] })
    const bob = createAccessAccount({ name: 'Bob', permissions: ['direct'], projectIds: ['intentlane-codex'] })

    const alicePrimaryToken = createAccessToken({
      accountId: alice.id,
      label: 'alice-primary',
      permissions: ['direct'],
      projectIds: ['intentlane-codex'],
    }).token
    const aliceSecondaryToken = createAccessToken({
      accountId: alice.id,
      label: 'alice-secondary',
      permissions: ['direct'],
      projectIds: ['intentlane-codex'],
    }).token
    const bobToken = createAccessToken({
      accountId: bob.id,
      label: 'bob-primary',
      permissions: ['direct'],
      projectIds: ['intentlane-codex'],
    }).token

    const app = new Hono()
    app.use('/api/*', requireSharedBearerAuth())
    app.route('/api', directRoutes)

    const saveResponse = await app.request('http://localhost/api/direct/state', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${alicePrimaryToken}`,
      },
      body: JSON.stringify({
        projectId: 'intentlane-codex',
        state: {
          selectedSessionId: 'session-a',
          sessions: [
            {
              id: 'session-a',
              agentRole: 'atlas',
              title: '테스트 복구 세션',
              threadId: 'direct-thread-1',
              messages: [{ id: 'msg-1', role: 'user', content: 'fix the failing test' }],
              createdAt: '2026-03-31T00:00:00.000Z',
              updatedAt: '2026-03-31T00:00:00.000Z',
            },
          ],
        },
      }),
    })

    assert.equal(saveResponse.status, 200)

    const aliceReadResponse = await app.request('http://localhost/api/direct/state?projectId=intentlane-codex', {
      headers: { Authorization: `Bearer ${aliceSecondaryToken}` },
    })
    assert.equal(aliceReadResponse.status, 200)
    const alicePayload = await aliceReadResponse.json()
    assert.equal(alicePayload.persisted, true)
    assert.equal(alicePayload.state.selectedSessionId, 'session-a')
    assert.equal(alicePayload.state.sessions[0]?.agentRole, 'plain')
    assert.equal(alicePayload.state.sessions[0]?.title, '테스트 복구 세션')
    assert.equal(alicePayload.state.sessions[0]?.threadId, 'direct-thread-1')
    assert.equal(alicePayload.state.sessions[0]?.messages[0]?.content, 'fix the failing test')

    const bobReadResponse = await app.request('http://localhost/api/direct/state?projectId=intentlane-codex', {
      headers: { Authorization: `Bearer ${bobToken}` },
    })
    assert.equal(bobReadResponse.status, 200)
    const bobPayload = await bobReadResponse.json()
    assert.equal(bobPayload.persisted, false)
    assert.equal(bobPayload.state.selectedSessionId, 'session-initial')
    assert.equal(bobPayload.state.sessions[0]?.agentRole, 'plain')
    assert.equal(bobPayload.state.sessions[0]?.threadId, undefined)
    assert.equal(bobPayload.state.sessions[0]?.messages.length, 0)
  })
)

test(
  'direct state migrates legacy single-session payloads on save and read',
  withRuntimeDataEnv(async () => {
    const alice = createAccessAccount({ name: 'Alice', permissions: ['direct'], projectIds: ['intentlane-codex'] })
    const token = createAccessToken({
      accountId: alice.id,
      label: 'alice-primary',
      permissions: ['direct'],
      projectIds: ['intentlane-codex'],
    }).token

    const app = new Hono()
    app.use('/api/*', requireSharedBearerAuth())
    app.route('/api', directRoutes)

    const saveResponse = await app.request('http://localhost/api/direct/state', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        projectId: 'intentlane-codex',
        state: {
          threadId: 'legacy-thread',
          messages: [{ id: 'msg-1', role: 'user', content: 'legacy direct session' }],
          updatedAt: '2026-03-31T00:00:00.000Z',
        },
      }),
    })

    assert.equal(saveResponse.status, 200)
    const savedState = await saveResponse.json()
    assert.equal(savedState.selectedSessionId, 'session-initial')
    assert.equal(savedState.sessions[0]?.agentRole, 'plain')
    assert.equal(savedState.sessions[0]?.threadId, 'legacy-thread')

    const readResponse = await app.request('http://localhost/api/direct/state?projectId=intentlane-codex', {
      headers: { Authorization: `Bearer ${token}` },
    })

    assert.equal(readResponse.status, 200)
    const readPayload = await readResponse.json()
    assert.equal(readPayload.persisted, true)
    assert.equal(readPayload.state.selectedSessionId, 'session-initial')
    assert.equal(readPayload.state.sessions.length, 1)
    assert.equal(readPayload.state.sessions[0]?.messages[0]?.content, 'legacy direct session')
  })
)

test(
  'direct routes reject tokens without direct permission even when ticket permission exists',
  withRuntimeDataEnv(async () => {
    const account = createAccessAccount({ name: 'Carol', permissions: ['tickets'], projectIds: ['intentlane-codex'] })
    const token = createAccessToken({
      accountId: account.id,
      label: 'ticket-only',
      permissions: ['tickets'],
      projectIds: ['intentlane-codex'],
    }).token

    const app = new Hono()
    app.use('/api/*', requireSharedBearerAuth())
    app.route('/api', directRoutes)

    const response = await app.request('http://localhost/api/direct/state?projectId=intentlane-codex', {
      headers: { Authorization: `Bearer ${token}` },
    })

    assert.equal(response.status, 403)
    const payload = await response.json()
    assert.equal(payload.code, 'FEATURE_FORBIDDEN')
    assert.match(payload.error, /This token cannot use direct/)
  })
)

test('direct chat route uses plain prompt and workspace-write sandbox settings', async () => {
  const previousToken = process.env.APP_SHARED_TOKEN
  let capturedOptions: RunCodexTurnOptions | undefined

  setRunCodexTurnForDirectTesting(async (opts) => {
    capturedOptions = opts
    return {
      threadId: 'direct-thread',
      finalResponse: '',
    }
  })

  process.env.APP_SHARED_TOKEN = 'shared-admin'

  try {
    const app = new Hono()
    app.use('/api/*', requireSharedBearerAuth())
    app.route('/api', directRoutes)

    const response = await app.request('http://localhost/api/direct/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer shared-admin',
      },
      body: JSON.stringify({
        message: '로그인 버그를 수정해줘',
        projectId: 'intentlane-codex',
        agentRole: 'plain',
      }),
    })

    assert.equal(response.status, 200)
    await response.text()
    assert.ok(capturedOptions)
    assert.equal(capturedOptions.sandboxMode, 'workspace-write')
    assert.equal(capturedOptions.approvalPolicy, 'never')
    assert.equal(capturedOptions.promptFile, 'prompts/direct-plain.txt')
    assert.equal(capturedOptions.networkAccessEnabled, false)
    assert.equal(capturedOptions.prompt, '로그인 버그를 수정해줘')
  } finally {
    resetRunCodexTurnForDirectTesting()

    if (previousToken === undefined) {
      delete process.env.APP_SHARED_TOKEN
    } else {
      process.env.APP_SHARED_TOKEN = previousToken
    }
  }
})

test('direct chat route defaults invalid or missing roles to plain', async () => {
  const previousToken = process.env.APP_SHARED_TOKEN
  const capturedPromptFiles: string[] = []

  setRunCodexTurnForDirectTesting(async (opts) => {
    capturedPromptFiles.push(opts.promptFile)
    return {
      threadId: 'direct-thread',
      finalResponse: '',
    }
  })

  process.env.APP_SHARED_TOKEN = 'shared-admin'

  try {
    const app = new Hono()
    app.use('/api/*', requireSharedBearerAuth())
    app.route('/api', directRoutes)

    const missingRoleResponse = await app.request('http://localhost/api/direct/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer shared-admin',
      },
      body: JSON.stringify({
        message: '구현해줘',
        projectId: 'intentlane-codex',
      }),
    })

    assert.equal(missingRoleResponse.status, 200)
    await missingRoleResponse.text()

    const invalidRoleResponse = await app.request('http://localhost/api/direct/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer shared-admin',
      },
      body: JSON.stringify({
        message: '다시 구현해줘',
        projectId: 'intentlane-codex',
        agentRole: 'invalid-role',
      }),
    })

    assert.equal(invalidRoleResponse.status, 200)
    await invalidRoleResponse.text()
    assert.deepEqual(capturedPromptFiles, ['prompts/direct-plain.txt', 'prompts/direct-plain.txt'])
  } finally {
    resetRunCodexTurnForDirectTesting()

    if (previousToken === undefined) {
      delete process.env.APP_SHARED_TOKEN
    } else {
      process.env.APP_SHARED_TOKEN = previousToken
    }
  }
})

test('direct chat route includes finalResponse in done event when Codex completes without delta events', async () => {
  const previousToken = process.env.APP_SHARED_TOKEN

  setRunCodexTurnForDirectTesting(async () => ({
    threadId: 'direct-thread-final-only',
    finalResponse: '수정을 마쳤고 테스트도 통과했습니다.',
  }))

  process.env.APP_SHARED_TOKEN = 'shared-admin'

  try {
    const app = new Hono()
    app.use('/api/*', requireSharedBearerAuth())
    app.route('/api', directRoutes)

    const response = await app.request('http://localhost/api/direct/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer shared-admin',
      },
      body: JSON.stringify({
        message: '작업해줘',
        projectId: 'intentlane-codex',
      }),
    })

    assert.equal(response.status, 200)
    const body = await response.text()
    assert.match(body, /event: done/)
    assert.match(body, /"finalResponse":"수정을 마쳤고 테스트도 통과했습니다\./)
    assert.match(body, /"hadAssistantDelta":false/)
  } finally {
    resetRunCodexTurnForDirectTesting()

    if (previousToken === undefined) {
      delete process.env.APP_SHARED_TOKEN
    } else {
      process.env.APP_SHARED_TOKEN = previousToken
    }
  }
})

test('direct chat route emits recovery state and restart notice after resume fallback succeeds', async () => {
  const previousToken = process.env.APP_SHARED_TOKEN
  const capturedPrompts: string[] = []
  let callCount = 0

  setRunCodexTurnForDirectTesting(async (opts) => {
    capturedPrompts.push(opts.prompt)
    callCount += 1

    if (callCount === 1) {
      assert.equal(opts.threadId, 'stale-direct-thread')
      return {
        threadId: 'stale-direct-thread',
        finalResponse: '',
      }
    }

    assert.equal(opts.threadId, undefined)
    await opts.onEvent?.({
      type: 'init',
      data: { threadId: 'fresh-direct-thread' },
    })
    await opts.onEvent?.({
      type: 'delta',
      data: { text: '이전 direct 문맥을 이어서 수정하겠습니다.' },
    })

    return {
      threadId: 'fresh-direct-thread',
      finalResponse: '이전 direct 문맥을 이어서 수정하겠습니다.',
    }
  })

  process.env.APP_SHARED_TOKEN = 'shared-admin'

  try {
    const app = new Hono()
    app.use('/api/*', requireSharedBearerAuth())
    app.route('/api', directRoutes)

    const response = await app.request('http://localhost/api/direct/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer shared-admin',
      },
      body: JSON.stringify({
        message: '이거 이어서 수정해줘',
        threadId: 'stale-direct-thread',
        projectId: 'intentlane-codex',
        agentRole: 'plain',
        sessionMessages: [
          { id: 'msg-1', role: 'user', content: '로그인 실패 케이스를 고쳐줘' },
          { id: 'msg-2', role: 'assistant', content: '폼 검증 흐름을 보고 있습니다.' },
          { id: 'msg-3', role: 'user', content: '이거 이어서 수정해줘' },
        ],
      }),
    })

    assert.equal(response.status, 200)
    const body = await response.text()
    assert.equal(callCount, 2)
    assert.match(capturedPrompts[1] ?? '', /Current direct session context:/)
    assert.match(body, /event: state/)
    assert.match(body, /"label":"새 세션에서 이어가는 중"/)
    assert.match(body, /"threadId":"fresh-direct-thread"/)
    assert.match(body, /"recoveryMode":"rehydrated"/)
    assert.match(body, /새 세션에서 이어갔습니다/)
  } finally {
    resetRunCodexTurnForDirectTesting()

    if (previousToken === undefined) {
      delete process.env.APP_SHARED_TOKEN
    } else {
      process.env.APP_SHARED_TOKEN = previousToken
    }
  }
})

test('sisyphus direct chat orchestrates prometheus and hephaestus in parallel before synthesis', async () => {
  const previousToken = process.env.APP_SHARED_TOKEN
  const promptFiles: string[] = []

  setRunCodexTurnForDirectTesting(async (opts) => {
    promptFiles.push(opts.promptFile)

    if (opts.promptFile === 'prompts/direct-prometheus.txt') {
      assert.match(opts.prompt, /Current direct session context:/)
      assert.match(opts.prompt, /Assistant: 계획 초안은 이미 있습니다\./)
      return {
        threadId: 'prometheus-thread',
        finalResponse: '계획을 먼저 정리해야 합니다.',
      }
    }

    if (opts.promptFile === 'prompts/direct-hephaestus.txt') {
      assert.match(opts.prompt, /Current direct session context:/)
      assert.match(opts.prompt, /User: 먼저 계획부터 잡아줘/)
      return {
        threadId: 'hephaestus-thread',
        finalResponse: '깊게 분석할 핵심 구현 경로를 확인했습니다.',
      }
    }

    if (opts.promptFile === 'prompts/direct-sisyphus.txt') {
      assert.match(opts.prompt, /Parallel subagent results:/)
      assert.match(opts.prompt, /Prometheus/)
      assert.match(opts.prompt, /Hephaestus/)
      assert.match(opts.prompt, /Assistant: 계획 초안은 이미 있습니다\./)
      await opts.onEvent?.({ type: 'init', data: { threadId: 'sisyphus-thread' } })
      await opts.onEvent?.({ type: 'delta', data: { text: '병렬 결과를 정리했습니다.' } })
      return {
        threadId: 'sisyphus-thread',
        finalResponse: '병렬 결과를 정리했습니다.',
      }
    }

    throw new Error(`Unexpected prompt file: ${opts.promptFile}`)
  })

  process.env.APP_SHARED_TOKEN = 'shared-admin'

  try {
    const app = new Hono()
    app.use('/api/*', requireSharedBearerAuth())
    app.route('/api', directRoutes)

    const response = await app.request('http://localhost/api/direct/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer shared-admin',
      },
      body: JSON.stringify({
        message: '이 작업을 어떻게 진행해야 하는지 조율해줘',
        projectId: 'intentlane-codex',
        agentRole: 'sisyphus',
        sessionMessages: [
          { id: 'msg-1', role: 'user', content: '먼저 계획부터 잡아줘' },
          { id: 'msg-2', role: 'assistant', content: '계획 초안은 이미 있습니다.' },
        ],
      }),
    })

    assert.equal(response.status, 200)
    const body = await response.text()
    assert.deepEqual(promptFiles.sort(), ['prompts/direct-hephaestus.txt', 'prompts/direct-prometheus.txt', 'prompts/direct-sisyphus.txt'].sort())
    assert.match(body, /event: state/)
    assert.match(body, /병렬 subagent 실행 완료/)
    assert.match(body, /event: done/)
    assert.match(body, /"threadId":"sisyphus-thread"/)
    assert.match(body, /"subagentResults":\[/)
  } finally {
    resetRunCodexTurnForDirectTesting()

    if (previousToken === undefined) {
      delete process.env.APP_SHARED_TOKEN
    } else {
      process.env.APP_SHARED_TOKEN = previousToken
    }
  }
})

test('sisyphus orchestration still completes when one subagent fails', async () => {
  const previousToken = process.env.APP_SHARED_TOKEN

  setRunCodexTurnForDirectTesting(async (opts) => {
    if (opts.promptFile === 'prompts/direct-prometheus.txt') {
      throw new Error('planner failed')
    }

    if (opts.promptFile === 'prompts/direct-hephaestus.txt') {
      return {
        threadId: 'hephaestus-thread',
        finalResponse: '구현 검토는 완료되었습니다.',
      }
    }

    if (opts.promptFile === 'prompts/direct-sisyphus.txt') {
      assert.match(opts.prompt, /Status: failed/)
      assert.match(opts.prompt, /planner failed/)
      return {
        threadId: 'sisyphus-thread',
        finalResponse: '일부 실패가 있었지만 계속 진행할 수 있습니다.',
      }
    }

    throw new Error(`Unexpected prompt file: ${opts.promptFile}`)
  })

  process.env.APP_SHARED_TOKEN = 'shared-admin'

  try {
    const app = new Hono()
    app.use('/api/*', requireSharedBearerAuth())
    app.route('/api', directRoutes)

    const response = await app.request('http://localhost/api/direct/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer shared-admin',
      },
      body: JSON.stringify({
        message: '병렬로 검토해줘',
        projectId: 'intentlane-codex',
        agentRole: 'sisyphus',
      }),
    })

    assert.equal(response.status, 200)
    const body = await response.text()
    assert.match(body, /event: done/)
    assert.match(body, /일부 실패가 있었지만 계속 진행할 수 있습니다/)
    assert.match(body, /"status":"failed"/)
    assert.match(body, /"status":"completed"/)
  } finally {
    resetRunCodexTurnForDirectTesting()

    if (previousToken === undefined) {
      delete process.env.APP_SHARED_TOKEN
    } else {
      process.env.APP_SHARED_TOKEN = previousToken
    }
  }
})
