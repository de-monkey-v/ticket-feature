import test from 'node:test'
import assert from 'node:assert/strict'
import { evaluateBackgroundRunRefresh } from '../../web/lib/background-run-refresh.js'
import { normalizeDirectState } from '../../web/lib/direct-state.js'
import { normalizeExplainState } from '../../web/lib/explain-state.js'
import type { BackgroundRunSummary } from '../../web/lib/api.js'

function createBackgroundRun(overrides: Partial<BackgroundRunSummary>): BackgroundRunSummary {
  return {
    id: 'run-123',
    kind: 'explain_reply',
    permission: 'explain',
    projectId: 'intentlane-codex',
    scopeType: 'explain_thread',
    scopeId: 'thread-1',
    scopeLabel: 'Thread 1',
    messagePreview: '질문',
    status: 'completed',
    createdAt: '2026-04-02T00:00:00.000Z',
    startedAt: '2026-04-02T00:00:00.000Z',
    updatedAt: '2026-04-02T00:00:01.000Z',
    completedAt: '2026-04-02T00:00:01.000Z',
    ...overrides,
  }
}

test('evaluateBackgroundRunRefresh refreshes explain state when an active run is first observed as completed', () => {
  const explainState = normalizeExplainState({
    selectedThreadId: 'thread-1',
    threads: [
      {
        id: 'thread-1',
        activeRunId: 'run-123',
        composerDraft: '',
        messages: [
          { id: 'msg-user', role: 'user', content: '안녕' },
          { id: 'msg-assistant', role: 'assistant', content: '' },
        ],
        drafts: [],
        createdAt: '2026-04-02T00:00:00.000Z',
        updatedAt: '2026-04-02T00:00:00.000Z',
      },
    ],
  })

  const result = evaluateBackgroundRunRefresh({
    backgroundRuns: [createBackgroundRun({ id: 'run-123' })],
    previousStatuses: new Map(),
    explainState,
    directState: null,
  })

  assert.equal(result.shouldRefreshExplain, true)
  assert.equal(result.shouldRefreshDirect, false)
  assert.equal(result.nextStatuses.get('run-123'), 'completed')
})

test('evaluateBackgroundRunRefresh refreshes explain state on active-to-terminal transitions', () => {
  const result = evaluateBackgroundRunRefresh({
    backgroundRuns: [createBackgroundRun({ id: 'run-123', status: 'completed' })],
    previousStatuses: new Map([['run-123', 'running']]),
    explainState: null,
    directState: null,
  })

  assert.equal(result.shouldRefreshExplain, true)
  assert.equal(result.shouldRefreshDirect, false)
})

test('evaluateBackgroundRunRefresh skips explain refresh when terminal runs are already reconciled', () => {
  const explainState = normalizeExplainState({
    selectedThreadId: 'thread-1',
    threads: [
      {
        id: 'thread-1',
        composerDraft: '',
        messages: [
          { id: 'msg-user', role: 'user', content: '안녕' },
          { id: 'msg-assistant', role: 'assistant', content: '안녕하세요.' },
        ],
        drafts: [],
        createdAt: '2026-04-02T00:00:00.000Z',
        updatedAt: '2026-04-02T00:00:02.000Z',
      },
    ],
  })

  const result = evaluateBackgroundRunRefresh({
    backgroundRuns: [createBackgroundRun({ id: 'run-123' })],
    previousStatuses: new Map(),
    explainState,
    directState: null,
  })

  assert.equal(result.shouldRefreshExplain, false)
  assert.equal(result.shouldRefreshDirect, false)
})

test('evaluateBackgroundRunRefresh refreshes direct state when a terminal reply still owns the active session run', () => {
  const directState = normalizeDirectState({
    selectedSessionId: 'session-1',
    sessions: [
      {
        id: 'session-1',
        agentRole: 'plain',
        activeRunId: 'run-456',
        messages: [
          { id: 'msg-user', role: 'user', content: '고쳐줘' },
          { id: 'msg-assistant', role: 'assistant', content: '' },
        ],
        createdAt: '2026-04-02T00:00:00.000Z',
        updatedAt: '2026-04-02T00:00:00.000Z',
      },
    ],
  })

  const result = evaluateBackgroundRunRefresh({
    backgroundRuns: [
      createBackgroundRun({
        id: 'run-456',
        kind: 'direct_reply',
        permission: 'direct',
        scopeType: 'direct_session',
        scopeId: 'session-1',
      }),
    ],
    previousStatuses: new Map(),
    explainState: null,
    directState,
  })

  assert.equal(result.shouldRefreshExplain, false)
  assert.equal(result.shouldRefreshDirect, true)
})
