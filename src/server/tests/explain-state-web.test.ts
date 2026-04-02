import test from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeExplainState,
  renameExplainThreadState,
  removeExplainDraftState,
  resolveExplainStateChange,
  toExplainThreadOverview,
  updateExplainDraftState,
  updateExplainThreadState,
} from '../../web/lib/explain-state.js'

test('renameExplainThreadState stores a custom thread title and overview prefers it', () => {
  const state = normalizeExplainState({
    selectedThreadId: 'thread-a',
    textEffect: 'plain',
    threads: [
      {
        id: 'thread-a',
        threadId: 'codex-a',
        messages: [{ id: 'msg-1', role: 'user', content: 'Explain the login guard flow' }],
        drafts: [],
        createdAt: '2026-03-31T00:00:00.000Z',
        updatedAt: '2026-03-31T00:00:00.000Z',
      },
    ],
  })

  const renamedState = renameExplainThreadState(state, 'thread-a', '  로그인 가드 분석  ')
  assert.equal(renamedState.threads[0]?.title, '로그인 가드 분석')
  assert.equal(toExplainThreadOverview(renamedState).threads[0]?.label, '로그인 가드 분석')

  const clearedState = renameExplainThreadState(renamedState, 'thread-a', '   ')
  assert.equal(clearedState.threads[0]?.title, undefined)
  assert.match(toExplainThreadOverview(clearedState).threads[0]?.label ?? '', /Explain the login guard flow/)
})

test('normalizeExplainState preserves thread composer drafts and backfills missing values', () => {
  const state = normalizeExplainState({
    selectedThreadId: 'thread-a',
    textEffect: 'plain',
    threads: [
      {
        id: 'thread-a',
        composerDraft: '작성 중인 질문',
        messages: [],
        drafts: [],
        createdAt: '2026-04-02T00:00:00.000Z',
        updatedAt: '2026-04-02T00:00:00.000Z',
      },
      {
        id: 'thread-b',
        messages: [],
        drafts: [],
        createdAt: '2026-04-01T00:00:00.000Z',
        updatedAt: '2026-04-01T00:00:00.000Z',
      },
    ],
  })

  assert.equal(state.threads.find((thread) => thread.id === 'thread-a')?.composerDraft, '작성 중인 질문')
  assert.equal(state.threads.find((thread) => thread.id === 'thread-b')?.composerDraft, '')
  assert.equal(state.threads.find((thread) => thread.id === 'thread-a')?.continuityMode, 'native')
})

test('normalizeExplainState preserves rehydrated continuity metadata in thread overviews', () => {
  const state = normalizeExplainState({
    selectedThreadId: 'thread-a',
    textEffect: 'plain',
    threads: [
      {
        id: 'thread-a',
        threadId: 'codex-a',
        continuityMode: 'rehydrated',
        lastRecoveryAt: '2026-04-02T12:00:00.000Z',
        lastRecoveryReason: 'Codex thread resume produced no events',
        messages: [{ id: 'msg-1', role: 'user', content: '이거 어디서 막아?' }],
        drafts: [],
        createdAt: '2026-04-02T00:00:00.000Z',
        updatedAt: '2026-04-02T12:00:00.000Z',
      },
    ],
  })

  assert.equal(state.threads[0]?.continuityMode, 'rehydrated')
  assert.equal(state.threads[0]?.lastRecoveryReason, 'Codex thread resume produced no events')
  assert.equal(toExplainThreadOverview(state).threads[0]?.continuityMode, 'rehydrated')
})

test('updateExplainDraftState updates only the targeted local request draft', () => {
  const state = normalizeExplainState({
    selectedThreadId: 'thread-a',
    textEffect: 'plain',
    threads: [
      {
        id: 'thread-a',
        threadId: 'codex-a',
        messages: [],
        drafts: [
          {
            id: 'draft-1',
            title: 'Original title',
            categoryId: 'feature',
            template: {
              problem: 'Original problem',
              desiredOutcome: 'Original outcome',
              userScenarios: 'Original scenario',
            },
            status: 'draft',
            createdAt: '2026-03-31T00:00:00.000Z',
            updatedAt: '2026-03-31T00:00:00.000Z',
          },
        ],
        createdAt: '2026-03-31T00:00:00.000Z',
        updatedAt: '2026-03-31T00:00:00.000Z',
      },
    ],
  })

  const nextState = updateExplainDraftState(state, 'thread-a', 'draft-1', {
    title: 'Refined title',
    template: {
      problem: 'Refined problem',
      desiredOutcome: 'Refined outcome',
      userScenarios: 'Refined scenario',
      constraints: 'Keep explain read-only',
    },
  })

  assert.equal(nextState.threads[0]?.drafts[0]?.title, 'Refined title')
  assert.equal(nextState.threads[0]?.drafts[0]?.template.problem, 'Refined problem')
  assert.equal(nextState.threads[0]?.drafts[0]?.template.constraints, 'Keep explain read-only')
})

test('removeExplainDraftState removes only the targeted local request draft', () => {
  const state = normalizeExplainState({
    selectedThreadId: 'thread-a',
    textEffect: 'plain',
    threads: [
      {
        id: 'thread-a',
        threadId: 'codex-a',
        messages: [],
        drafts: [
          {
            id: 'draft-1',
            title: 'Discard me',
            categoryId: 'feature',
            template: {
              problem: 'Problem',
              desiredOutcome: 'Outcome',
              userScenarios: 'Scenario',
            },
            status: 'draft',
            createdAt: '2026-03-31T00:00:00.000Z',
            updatedAt: '2026-03-31T00:00:00.000Z',
          },
        ],
        createdAt: '2026-03-31T00:00:00.000Z',
        updatedAt: '2026-03-31T00:00:00.000Z',
      },
      {
        id: 'thread-b',
        threadId: 'codex-b',
        messages: [],
        drafts: [
          {
            id: 'draft-2',
            title: 'Keep me',
            categoryId: 'feature',
            template: {
              problem: 'Problem 2',
              desiredOutcome: 'Outcome 2',
              userScenarios: 'Scenario 2',
            },
            status: 'draft',
            createdAt: '2026-03-31T00:00:00.000Z',
            updatedAt: '2026-03-31T00:00:00.000Z',
          },
        ],
        createdAt: '2026-03-31T00:00:00.000Z',
        updatedAt: '2026-03-31T00:00:00.000Z',
      },
    ],
  })

  const nextState = removeExplainDraftState(state, 'thread-a', 'draft-1')

  assert.equal(nextState.threads.find((thread) => thread.id === 'thread-a')?.drafts.length, 0)
  assert.equal(nextState.threads.find((thread) => thread.id === 'thread-b')?.drafts[0]?.id, 'draft-2')
})

test('resolveExplainStateChange preserves the latest selected explain thread while updating another thread', () => {
  const initialState = normalizeExplainState({
    selectedThreadId: 'thread-a',
    textEffect: 'plain',
    threads: [
      {
        id: 'thread-a',
        threadId: 'codex-a',
        messages: [{ id: 'msg-a', role: 'user', content: '첫 질문' }],
        drafts: [],
        createdAt: '2026-03-31T00:00:00.000Z',
        updatedAt: '2026-03-31T00:00:00.000Z',
      },
      {
        id: 'thread-b',
        threadId: 'codex-b',
        messages: [],
        drafts: [],
        createdAt: '2026-04-01T00:00:00.000Z',
        updatedAt: '2026-04-01T00:00:00.000Z',
      },
    ],
  })

  const latestState = {
    ...initialState,
    selectedThreadId: 'thread-b',
  }

  const nextState = resolveExplainStateChange(latestState, (currentState) =>
    updateExplainThreadState(currentState, 'thread-a', (thread) => ({
      ...thread,
      activeRunId: 'run-123',
    }))
  )

  assert.equal(nextState?.selectedThreadId, 'thread-b')
  assert.equal(nextState?.threads.find((thread) => thread.id === 'thread-a')?.activeRunId, 'run-123')
})

test('explain thread ordering follows sortUpdatedAt instead of metadata-only updatedAt changes', () => {
  const state = normalizeExplainState({
    selectedThreadId: 'thread-b',
    textEffect: 'plain',
    threads: [
      {
        id: 'thread-a',
        messages: [],
        drafts: [],
        createdAt: '2026-03-31T00:00:00.000Z',
        sortUpdatedAt: '2026-03-31T00:00:00.000Z',
        updatedAt: '2026-03-31T00:00:00.000Z',
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
  })

  const metadataOnlyUpdate = updateExplainThreadState(state, 'thread-a', (thread) => ({
    ...thread,
    activeRunId: 'run-999',
    updatedAt: '2026-04-02T00:00:00.000Z',
  }))

  assert.deepEqual(
    metadataOnlyUpdate.threads.map((thread) => thread.id),
    ['thread-b', 'thread-a']
  )

  const conversationUpdate = updateExplainThreadState(state, 'thread-a', (thread) => ({
    ...thread,
    sortUpdatedAt: '2026-04-02T00:00:00.000Z',
    updatedAt: '2026-04-02T00:00:00.000Z',
  }))

  assert.deepEqual(
    conversationUpdate.threads.map((thread) => thread.id),
    ['thread-a', 'thread-b']
  )
})
