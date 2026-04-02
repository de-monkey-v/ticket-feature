import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { createAccessAccount, createAccessToken } from '../lib/access-control.js'
import { requireSharedBearerAuth } from '../lib/auth.js'
import { explainRoutes } from '../routes/explain.js'

const RUNTIME_DATA_DIR_ENV = 'INTENTLANE_CODEX_DATA_DIR'

function withRuntimeDataEnv(fn: () => Promise<void> | void) {
  return async () => {
    const previousDataDir = process.env[RUNTIME_DATA_DIR_ENV]
    const tempDir = mkdtempSync(join(tmpdir(), 'intentlane-codex-explain-route-test-'))
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
  'explain state is isolated per account while remaining shared across the same account tokens',
  withRuntimeDataEnv(async () => {
    const alice = createAccessAccount({
      name: 'Alice',
      permissions: ['explain'],
      projectIds: ['intentlane-codex'],
    })
    const bob = createAccessAccount({
      name: 'Bob',
      permissions: ['explain'],
      projectIds: ['intentlane-codex'],
    })

    const alicePrimaryToken = createAccessToken({
      accountId: alice.id,
      label: 'alice-primary',
      permissions: ['explain'],
      projectIds: ['intentlane-codex'],
    }).token
    const aliceSecondaryToken = createAccessToken({
      accountId: alice.id,
      label: 'alice-secondary',
      permissions: ['explain'],
      projectIds: ['intentlane-codex'],
    }).token
    const bobToken = createAccessToken({
      accountId: bob.id,
      label: 'bob-primary',
      permissions: ['explain'],
      projectIds: ['intentlane-codex'],
    }).token

    const app = new Hono()
    app.use('/api/*', requireSharedBearerAuth())
    app.route('/api', explainRoutes)

    const saveResponse = await app.request('http://localhost/api/explain/state', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${alicePrimaryToken}`,
      },
      body: JSON.stringify({
        projectId: 'intentlane-codex',
        state: {
          selectedThreadId: 'alice-thread',
          textEffect: 'plain',
          threads: [
            {
              id: 'alice-thread',
              title: '로그인 흐름 분석',
              threadId: 'codex-thread-1',
              composerDraft: '이 질문 이어서 적는 중',
              messages: [
                {
                  id: 'msg-1',
                  role: 'user',
                  content: 'hello from alice',
                },
              ],
              drafts: [],
              createdAt: '2026-03-31T00:00:00.000Z',
              updatedAt: '2026-03-31T00:00:00.000Z',
            },
          ],
        },
      }),
    })

    assert.equal(saveResponse.status, 200)

    const aliceReadResponse = await app.request('http://localhost/api/explain/state?projectId=intentlane-codex', {
      headers: {
        Authorization: `Bearer ${aliceSecondaryToken}`,
      },
    })
    assert.equal(aliceReadResponse.status, 200)
    const alicePayload = await aliceReadResponse.json()
    assert.equal(alicePayload.persisted, true)
    assert.equal(alicePayload.state.selectedThreadId, 'alice-thread')
    assert.equal(alicePayload.state.threads[0]?.title, '로그인 흐름 분석')
    assert.equal(alicePayload.state.threads[0]?.composerDraft, '이 질문 이어서 적는 중')
    assert.equal(alicePayload.state.threads[0]?.messages[0]?.content, 'hello from alice')

    const bobReadResponse = await app.request('http://localhost/api/explain/state?projectId=intentlane-codex', {
      headers: {
        Authorization: `Bearer ${bobToken}`,
      },
    })
    assert.equal(bobReadResponse.status, 200)
    const bobPayload = await bobReadResponse.json()
    assert.equal(bobPayload.persisted, false)
    assert.equal(bobPayload.state.selectedThreadId, 'thread-initial')
    assert.equal(bobPayload.state.threads[0]?.messages.length, 0)
  })
)

test(
  'explain state persists an empty thread list without recreating a default thread',
  withRuntimeDataEnv(async () => {
    const account = createAccessAccount({
      name: 'Charlie',
      permissions: ['explain'],
      projectIds: ['intentlane-codex'],
    })

    const token = createAccessToken({
      accountId: account.id,
      label: 'charlie-primary',
      permissions: ['explain'],
      projectIds: ['intentlane-codex'],
    }).token

    const app = new Hono()
    app.use('/api/*', requireSharedBearerAuth())
    app.route('/api', explainRoutes)

    const saveResponse = await app.request('http://localhost/api/explain/state', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        projectId: 'intentlane-codex',
        state: {
          selectedThreadId: '',
          textEffect: 'plain',
          threads: [],
        },
      }),
    })

    assert.equal(saveResponse.status, 200)

    const readResponse = await app.request('http://localhost/api/explain/state?projectId=intentlane-codex', {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    })

    assert.equal(readResponse.status, 200)
    const payload = await readResponse.json()
    assert.equal(payload.persisted, true)
    assert.equal(payload.state.selectedThreadId, '')
    assert.deepEqual(payload.state.threads, [])
  })
)

test(
  'explain state ordering is restored from sortUpdatedAt instead of metadata-only updatedAt changes',
  withRuntimeDataEnv(async () => {
    const account = createAccessAccount({
      name: 'Dana',
      permissions: ['explain'],
      projectIds: ['intentlane-codex'],
    })

    const token = createAccessToken({
      accountId: account.id,
      label: 'dana-primary',
      permissions: ['explain'],
      projectIds: ['intentlane-codex'],
    }).token

    const app = new Hono()
    app.use('/api/*', requireSharedBearerAuth())
    app.route('/api', explainRoutes)

    const saveResponse = await app.request('http://localhost/api/explain/state', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        projectId: 'intentlane-codex',
        state: {
          selectedThreadId: 'thread-a',
          textEffect: 'plain',
          threads: [
            {
              id: 'thread-a',
              messages: [],
              drafts: [],
              createdAt: '2026-03-31T00:00:00.000Z',
              sortUpdatedAt: '2026-03-31T00:00:00.000Z',
              updatedAt: '2026-04-02T00:00:00.000Z',
            },
            {
              id: 'thread-b',
              messages: [],
              drafts: [],
              createdAt: '2026-04-01T00:00:00.000Z',
              sortUpdatedAt: '2026-04-01T00:00:00.000Z',
              updatedAt: '2026-04-01T00:00:00.000Z',
            },
          ],
        },
      }),
    })

    assert.equal(saveResponse.status, 200)

    const readResponse = await app.request('http://localhost/api/explain/state?projectId=intentlane-codex', {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    })

    assert.equal(readResponse.status, 200)
    const payload = await readResponse.json()
    assert.deepEqual(
      payload.state.threads.map((thread: { id: string }) => thread.id),
      ['thread-b', 'thread-a']
    )
  })
)
