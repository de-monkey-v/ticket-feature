import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { Hono } from 'hono'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createAccessAccount,
  createAccessToken,
} from '../lib/access-control.js'
import { allAccessPermissions, type AuthSession } from '../lib/access-policy.js'
import { requireSharedBearerAuth } from '../lib/auth.js'
import { readBackgroundRunEventJournal } from '../services/background-runs.js'
import type { RunCodexTurnOptions } from '../services/codex-sdk.js'
import { loadExplainState, saveExplainState } from '../services/explain-state.js'
import {
  resetRunCodexTurnForRequestDraftTesting,
  REQUEST_DRAFT_TOOL_NAME,
  setRunCodexTurnForRequestDraftTesting,
} from '../services/request-draft-tool.js'
import {
  chatRoutes,
  resetRunCodexTurnForChatTesting,
  setRunCodexTurnForChatTesting,
} from '../routes/chat.js'

const ACCESS_CONTROL_PATH_ENV = 'INTENTLANE_CODEX_ACCESS_CONTROL_PATH'
const sharedAdminSession: AuthSession = {
  kind: 'shared_admin',
  label: 'Shared admin',
  isAdmin: true,
  permissions: allAccessPermissions(),
  projectIds: null,
  mustChangePassword: false,
}

function withAccessControlEnv(fn: () => Promise<void> | void) {
  return async () => {
    const previousAccessPath = process.env[ACCESS_CONTROL_PATH_ENV]
    const tempDir = mkdtempSync(join(tmpdir(), 'intentlane-codex-chat-route-test-'))
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

test('chat route injects access control tools for admin explain sessions', async () => {
  const previousToken = process.env.APP_SHARED_TOKEN
  let capturedOptions: RunCodexTurnOptions | undefined

  setRunCodexTurnForChatTesting(async (opts) => {
    capturedOptions = opts
    return {
      threadId: 'thread_admin',
      finalResponse: '',
    }
  })

  process.env.APP_SHARED_TOKEN = 'shared-admin'

  try {
    const app = new Hono()
    app.use('/api/*', requireSharedBearerAuth())
    app.route('/api', chatRoutes)

    const response = await app.request('http://localhost/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer shared-admin',
      },
      body: JSON.stringify({
        message: 'Alice 계정에 explain 권한을 줘',
        projectId: 'intentlane-codex',
      }),
    })

    assert.equal(response.status, 200)
    await response.text()
    assert.ok(capturedOptions)
    const mcpServers = (capturedOptions.codexConfig?.mcp_servers ?? {}) as Record<string, unknown>
    assert.ok(mcpServers.access_control)
    assert.match(capturedOptions.prompt, /Access control tool context:/)
    assert.match(capturedOptions.prompt, /list_access_control/)
    assert.match(capturedOptions.prompt, /do NOT manage passwords/i)
  } finally {
    resetRunCodexTurnForChatTesting()

    if (previousToken === undefined) {
      delete process.env.APP_SHARED_TOKEN
    } else {
      process.env.APP_SHARED_TOKEN = previousToken
    }
  }
})

test(
  'chat route keeps access control tools hidden for scoped non-admin sessions',
  withAccessControlEnv(async () => {
    const previousToken = process.env.APP_SHARED_TOKEN
    let capturedOptions: RunCodexTurnOptions | undefined

    delete process.env.APP_SHARED_TOKEN
    setRunCodexTurnForChatTesting(async (opts) => {
      capturedOptions = opts
      return {
        threadId: 'thread_scoped',
        finalResponse: '',
      }
    })

    try {
      const account = createAccessAccount({
        name: 'Grace',
        permissions: ['explain'],
        projectIds: ['intentlane-codex'],
      })
      const created = createAccessToken({
        accountId: account.id,
        label: 'grace-explain',
        permissions: ['explain'],
        projectIds: ['intentlane-codex'],
      })

      const app = new Hono()
      app.use('/api/*', requireSharedBearerAuth())
      app.route('/api', chatRoutes)

      const response = await app.request('http://localhost/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${created.token}`,
        },
        body: JSON.stringify({
          message: '현재 explain 권한 상태를 알려줘',
          projectId: 'intentlane-codex',
        }),
      })

      assert.equal(response.status, 200)
      await response.text()
      assert.ok(capturedOptions)
      const mcpServers = (capturedOptions.codexConfig?.mcp_servers ?? {}) as Record<string, unknown>
      assert.equal(mcpServers.access_control, undefined)
      assert.doesNotMatch(capturedOptions.prompt, /Access control tool context:/)
    } finally {
      resetRunCodexTurnForChatTesting()

      if (previousToken === undefined) {
        delete process.env.APP_SHARED_TOKEN
      } else {
        process.env.APP_SHARED_TOKEN = previousToken
      }
    }
  })
)

test(
  'chat request-draft route includes existing draft context when refining a chat draft',
  withAccessControlEnv(async () => {
    let capturedPrompt = ''

    setRunCodexTurnForRequestDraftTesting(async (opts) => {
      capturedPrompt = opts.prompt
      await opts.onEvent?.({
        type: 'tool_result',
        data: {
          id: 'tool-1',
          server: 'request_intake',
          tool: REQUEST_DRAFT_TOOL_NAME,
          input: { title: 'Draft' },
          result: {
            title: 'Refined request draft',
            categoryId: 'feature',
            template: {
              problem: '보완된 문제 설명',
              desiredOutcome: '보완된 기대 결과',
              userScenarios: '보완된 사용자 시나리오',
              constraints: '읽기 전용 Explain 유지',
            },
            rationale: '기존 초안과 최신 대화를 함께 반영',
          },
        },
      })

      return { threadId: null, finalResponse: '' }
    })

    try {
      const account = createAccessAccount({
        name: 'Hana',
        permissions: ['explain', 'requests'],
        projectIds: ['intentlane-codex'],
      })
      const created = createAccessToken({
        accountId: account.id,
        label: 'hana-chat-request-draft',
        permissions: ['explain', 'requests'],
        projectIds: ['intentlane-codex'],
      })

      const app = new Hono()
      app.use('/api/*', requireSharedBearerAuth())
      app.route('/api', chatRoutes)

      const response = await app.request('http://localhost/api/chat/request-draft', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${created.token}`,
        },
        body: JSON.stringify({
          projectId: 'intentlane-codex',
          messages: [
            { role: 'user', content: '이 초안에 제약 조건도 반영해줘' },
            { role: 'assistant', content: '좋아요. 최신 대화 기준으로 다시 정리할게요.' },
          ],
          existingDraft: {
            title: 'Original draft',
            categoryId: 'feature',
            template: {
              problem: '기존 문제 설명',
              desiredOutcome: '기존 기대 결과',
              userScenarios: '기존 사용자 시나리오',
              constraints: '기존 제약 조건',
            },
            rationale: '초기 초안',
          },
        }),
      })

      assert.equal(response.status, 200)
      const payload = await response.json()
      assert.equal(payload.title, 'Refined request draft')
      assert.match(capturedPrompt, /Current request draft to refine:/)
      assert.match(capturedPrompt, /Title: Original draft/)
      assert.match(capturedPrompt, /Constraints:\n기존 제약 조건/)
      assert.match(capturedPrompt, /이 초안에 제약 조건도 반영해줘/)
    } finally {
      resetRunCodexTurnForRequestDraftTesting()
    }
  })
)

test('chat route includes finalResponse in done event when Codex completes without delta events', async () => {
  const previousToken = process.env.APP_SHARED_TOKEN

  setRunCodexTurnForChatTesting(async () => ({
    threadId: 'thread-final-only',
    finalResponse: '안녕하세요. 무엇을 도와드릴까요?',
  }))

  process.env.APP_SHARED_TOKEN = 'shared-admin'

  try {
    const app = new Hono()
    app.use('/api/*', requireSharedBearerAuth())
    app.route('/api', chatRoutes)

    const response = await app.request('http://localhost/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer shared-admin',
      },
      body: JSON.stringify({
        message: '안녕',
        projectId: 'intentlane-codex',
      }),
    })

    assert.equal(response.status, 200)
    const body = await response.text()
    assert.match(body, /event: done/)
    assert.match(body, /"finalResponse":"안녕하세요\. 무엇을 도와드릴까요\?"/)
    assert.match(body, /"hadAssistantDelta":false/)
  } finally {
    resetRunCodexTurnForChatTesting()

    if (previousToken === undefined) {
      delete process.env.APP_SHARED_TOKEN
    } else {
      process.env.APP_SHARED_TOKEN = previousToken
    }
  }
})

test('chat route emits done only once after resume fallback succeeds', async () => {
  const previousToken = process.env.APP_SHARED_TOKEN
  let callCount = 0

  setRunCodexTurnForChatTesting(async (opts) => {
    callCount += 1

    if (callCount === 1) {
      assert.equal(opts.threadId, 'stale-thread')
      return {
        threadId: 'stale-thread',
        finalResponse: '',
      }
    }

    assert.equal(opts.threadId, undefined)
    await opts.onEvent?.({
      type: 'init',
      data: { threadId: 'fresh-thread' },
    })
    await opts.onEvent?.({
      type: 'delta',
      data: { text: '새 스레드에서 답변을 이어갑니다.' },
    })

    return {
      threadId: 'fresh-thread',
      finalResponse: '새 스레드에서 답변을 이어갑니다.',
    }
  })

  process.env.APP_SHARED_TOKEN = 'shared-admin'

  try {
    const app = new Hono()
    app.use('/api/*', requireSharedBearerAuth())
    app.route('/api', chatRoutes)

    const response = await app.request('http://localhost/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer shared-admin',
      },
      body: JSON.stringify({
        message: '안녕',
        threadId: 'stale-thread',
        projectId: 'intentlane-codex',
      }),
    })

    assert.equal(response.status, 200)
    const body = await response.text()
    assert.match(body, /event: state/)
    assert.match(body, /"label":"새 세션에서 이어가는 중"/)
    assert.equal((body.match(/event: done/g) ?? []).length, 1)
    assert.match(body, /"threadId":"fresh-thread"/)
    assert.match(body, /"hadAssistantDelta":true/)
    assert.match(body, /"finalResponse":"새 스레드에서 답변을 이어갑니다\./)
    assert.match(body, /이전 Codex 세션을 복구하지 못해 현재 대화 기록을 바탕으로 새 세션에서 이어갔습니다/)
  } finally {
    resetRunCodexTurnForChatTesting()

    if (previousToken === undefined) {
      delete process.env.APP_SHARED_TOKEN
    } else {
      process.env.APP_SHARED_TOKEN = previousToken
    }
  }
})

test('chat runs route rehydrates explain transcript when resume fallback starts a fresh thread', async () => {
  const previousToken = process.env.APP_SHARED_TOKEN
  const capturedPrompts: string[] = []
  let callCount = 0
  const now = '2026-04-02T00:00:00.000Z'

  setRunCodexTurnForChatTesting(async (opts) => {
    capturedPrompts.push(opts.prompt)
    callCount += 1

    if (callCount === 1) {
      assert.equal(opts.threadId, 'stale-thread')
      return {
        threadId: 'stale-thread',
        finalResponse: '',
      }
    }

    assert.equal(opts.threadId, undefined)
    await opts.onEvent?.({
      type: 'init',
      data: { threadId: 'fresh-thread' },
    })
    await opts.onEvent?.({
      type: 'delta',
      data: { text: '이전 대화 문맥으로 답변합니다.' },
    })

    return {
      threadId: 'fresh-thread',
      finalResponse: '이전 대화 문맥으로 답변합니다.',
    }
  })

  process.env.APP_SHARED_TOKEN = 'shared-admin'

  try {
    saveExplainState(sharedAdminSession, 'intentlane-codex', {
      selectedThreadId: 'thread-1',
      textEffect: 'smooth-type',
      threads: [
        {
          id: 'thread-1',
          threadId: 'stale-thread',
          messages: [
            { id: 'msg-1', role: 'user', content: '로그인 가드 흐름을 설명해줘' },
            { id: 'msg-2', role: 'assistant', content: '라우트 진입 전에 권한을 확인합니다.' },
            { id: 'msg-3', role: 'user', content: '그럼 이거는 어디서 막아?' },
            { id: 'msg-4', role: 'assistant', content: '' },
          ],
          drafts: [],
          createdAt: now,
          sortUpdatedAt: now,
          updatedAt: now,
        },
      ],
    })

    const app = new Hono()
    app.use('/api/*', requireSharedBearerAuth())
    app.route('/api', chatRoutes)

    const response = await app.request('http://localhost/api/chat/runs', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer shared-admin',
      },
      body: JSON.stringify({
        message: '그럼 이거는 어디서 막아?',
        threadId: 'stale-thread',
        threadKey: 'thread-1',
        projectId: 'intentlane-codex',
        scopeLabel: 'Explain thread',
        messages: [
          { id: 'msg-1', role: 'user', content: '로그인 가드 흐름을 설명해줘' },
          { id: 'msg-2', role: 'assistant', content: '라우트 진입 전에 권한을 확인합니다.' },
          { id: 'msg-3', role: 'user', content: '그럼 이거는 어디서 막아?' },
          { id: 'msg-4', role: 'assistant', content: '' },
        ],
        drafts: [],
      }),
    })

    assert.equal(response.status, 202)
    const started = await response.json() as {
      run: {
        id: string
      }
    }

    for (let index = 0; index < 20; index += 1) {
      const journal = readBackgroundRunEventJournal(started.run.id)
      if (capturedPrompts.length >= 2 && journal.some((event) => event.type === 'done')) {
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 0))
    }

    assert.equal(callCount, 2)
    assert.equal(capturedPrompts.length, 2)
    const journal = readBackgroundRunEventJournal(started.run.id)
    assert.ok(
      journal.some(
        (event) =>
          event.type === 'state' &&
          event.data.label === '새 세션에서 이어가는 중' &&
          event.data.detail ===
            '이전 Codex 세션을 복구하지 못해 현재 대화 기록을 바탕으로 이어가고 있습니다.'
      )
    )
    assert.match(capturedPrompts[1]!, /This Explain conversation is resuming in a fresh Codex thread\./)
    assert.match(capturedPrompts[1]!, /Latest user message:\n그럼 이거는 어디서 막아\?/)
    assert.match(capturedPrompts[1]!, /\[1\] 사용자\n로그인 가드 흐름을 설명해줘/)
    assert.match(capturedPrompts[1]!, /\[2\] Codex\n라우트 진입 전에 권한을 확인합니다\./)
    assert.match(capturedPrompts[1]!, /\[3\] 사용자\n그럼 이거는 어디서 막아\?/)
    assert.doesNotMatch(capturedPrompts[1]!, /\[4\]/)
    const savedThread = loadExplainState(sharedAdminSession, 'intentlane-codex').state.threads.find(
      (thread) => thread.id === 'thread-1'
    )
    assert.ok(savedThread)
    assert.equal(savedThread.threadId, 'fresh-thread')
    assert.match(
      savedThread.messages.at(-1)?.content ?? '',
      /이전 Codex 세션을 복구하지 못해 현재 대화 기록을 바탕으로 새 세션에서 이어갔습니다/
    )
  } finally {
    resetRunCodexTurnForChatTesting()

    if (previousToken === undefined) {
      delete process.env.APP_SHARED_TOKEN
    } else {
      process.env.APP_SHARED_TOKEN = previousToken
    }
  }
})

test('saveExplainState reconciles stale explain runs with completed background replies', async () => {
  const previousToken = process.env.APP_SHARED_TOKEN

  setRunCodexTurnForChatTesting(async (opts) => {
    await opts.onEvent?.({
      type: 'init',
      data: { threadId: 'thread-complete' },
    })
    await opts.onEvent?.({
      type: 'delta',
      data: { text: '안녕하세요. 무엇을 도와드릴까요?' },
    })

    return {
      threadId: 'thread-complete',
      finalResponse: '안녕하세요. 무엇을 도와드릴까요?',
    }
  })

  process.env.APP_SHARED_TOKEN = 'shared-admin'

  try {
    const app = new Hono()
    app.use('/api/*', requireSharedBearerAuth())
    app.route('/api', chatRoutes)

    const response = await app.request('http://localhost/api/chat/runs', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer shared-admin',
      },
      body: JSON.stringify({
        message: '안녕',
        threadKey: 'thread-stale-run',
        projectId: 'intentlane-codex',
        scopeLabel: 'Explain thread',
        messages: [
          { id: 'msg-1', role: 'user', content: '안녕' },
          { id: 'msg-2', role: 'assistant', content: '' },
        ],
        drafts: [],
      }),
    })

    assert.equal(response.status, 202)
    const started = await response.json() as {
      run: {
        id: string
      }
    }

    for (let index = 0; index < 20; index += 1) {
      const journal = readBackgroundRunEventJournal(started.run.id)
      if (journal.some((event) => event.type === 'done')) {
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 0))
    }

    saveExplainState(sharedAdminSession, 'intentlane-codex', {
      selectedThreadId: 'thread-stale-run',
      textEffect: 'smooth-type',
      threads: [
        {
          id: 'thread-stale-run',
          threadId: 'thread-complete',
          activeRunId: started.run.id,
          messages: [
            { id: 'msg-1', role: 'user', content: '안녕' },
            { id: 'msg-2', role: 'assistant', content: '' },
          ],
          drafts: [],
          createdAt: '2026-04-02T00:00:00.000Z',
          sortUpdatedAt: '2026-04-02T00:00:00.000Z',
          updatedAt: '2026-04-02T00:00:00.000Z',
        },
      ],
    })

    const savedThread = loadExplainState(sharedAdminSession, 'intentlane-codex').state.threads.find(
      (thread) => thread.id === 'thread-stale-run'
    )

    assert.ok(savedThread)
    assert.equal(savedThread.activeRunId, undefined)
    assert.equal(savedThread.threadId, 'thread-complete')
    assert.equal(savedThread.messages.at(-1)?.content, '안녕하세요. 무엇을 도와드릴까요?')
  } finally {
    resetRunCodexTurnForChatTesting()

    if (previousToken === undefined) {
      delete process.env.APP_SHARED_TOKEN
    } else {
      process.env.APP_SHARED_TOKEN = previousToken
    }
  }
})
