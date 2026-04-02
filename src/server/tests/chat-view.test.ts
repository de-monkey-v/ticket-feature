import test from 'node:test'
import assert from 'node:assert/strict'
import {
  completeExplainReplyThreadState,
  createReconnectStreamStatus,
  failExplainReplyThreadState,
  inferExplainReconnectRunKind,
  shouldHydrateSelectedExplainThread,
} from '../../web/components/ChatView.js'

test('inferExplainReconnectRunKind restores explain reply runs from pending assistant messages', () => {
  assert.equal(
    inferExplainReconnectRunKind({
      activeRunId: 'run-123',
      messages: [
        { id: 'msg-user', role: 'user', content: '왜 사라져?' },
        { id: 'msg-assistant', role: 'assistant', content: '' },
      ],
      drafts: [],
    }),
    'explain_reply'
  )
})

test('inferExplainReconnectRunKind prefers draft runs when a draft is still drafting', () => {
  assert.equal(
    inferExplainReconnectRunKind({
      activeRunId: 'run-456',
      messages: [{ id: 'msg-user', role: 'user', content: 'request로 바꿔줘' }],
      drafts: [
        {
          id: 'draft-1',
          title: '',
          categoryId: 'feature',
          template: {
            problem: '',
            desiredOutcome: '',
            userScenarios: '',
          },
          status: 'drafting',
          createdAt: '2026-04-02T00:00:00.000Z',
          updatedAt: '2026-04-02T00:00:00.000Z',
        },
      ],
    }),
    'explain_request_draft'
  )
})

test('createReconnectStreamStatus keeps the waiting placeholder for empty assistant replies', () => {
  const status = createReconnectStreamStatus('explain_reply', [
    { id: 'msg-user', role: 'user', content: '질문' },
    { id: 'msg-assistant', role: 'assistant', content: '' },
  ])

  assert.equal(status.phase, 'waiting')
  assert.equal(status.label, '응답 준비 중')
  assert.match(status.detail ?? '', /다시 연결/)
})

test('createReconnectStreamStatus shows answering when streamed assistant text already exists', () => {
  const status = createReconnectStreamStatus('explain_reply', [
    { id: 'msg-user', role: 'user', content: '질문' },
    { id: 'msg-assistant', role: 'assistant', content: '지금 정리해보면' },
  ])

  assert.equal(status.phase, 'answering')
  assert.equal(status.label, '답변 생성 중')
})

test('shouldHydrateSelectedExplainThread stays idle when the selected thread snapshot is unchanged', () => {
  const messages = [
    { id: 'msg-user', role: 'user' as const, content: '질문' },
    { id: 'msg-assistant', role: 'assistant' as const, content: '' },
  ]
  const drafts: Array<{
    id: string
    title: string
    categoryId: string
    template: {
      problem: string
      desiredOutcome: string
      userScenarios: string
    }
    status: 'drafting' | 'draft' | 'saving' | 'saved' | 'error'
    createdAt: string
    updatedAt: string
  }> = []

  assert.equal(
    shouldHydrateSelectedExplainThread({
      contextChanged: false,
      nextMessages: messages,
      currentMessages: messages,
      nextDrafts: drafts,
      currentDrafts: drafts,
      nextThreadId: 'thread-1',
      currentThreadId: 'thread-1',
      nextActiveRunId: 'run-1',
      currentActiveRunId: 'run-1',
    }),
    false
  )
})

test('shouldHydrateSelectedExplainThread applies newer server snapshots for the same thread', () => {
  assert.equal(
    shouldHydrateSelectedExplainThread({
      contextChanged: false,
      nextMessages: [
        { id: 'msg-user', role: 'user', content: '질문' },
        { id: 'msg-assistant', role: 'assistant', content: '답변' },
      ],
      currentMessages: [
        { id: 'msg-user', role: 'user', content: '질문' },
        { id: 'msg-assistant', role: 'assistant', content: '' },
      ],
      nextDrafts: [],
      currentDrafts: [],
      nextThreadId: 'thread-1',
      currentThreadId: 'thread-1',
      nextActiveRunId: undefined,
      currentActiveRunId: 'run-1',
    }),
    true
  )
})

test('completeExplainReplyThreadState clears the active run and preserves the completed answer', () => {
  const nextState = completeExplainReplyThreadState(
    {
      selectedThreadId: 'thread-1',
      textEffect: 'plain',
      threads: [
        {
          id: 'thread-1',
          threadId: 'thread-before',
          activeRunId: 'run-1',
          continuityMode: 'native',
          composerDraft: '',
          messages: [
            { id: 'msg-user', role: 'user', content: '질문' },
            { id: 'msg-assistant', role: 'assistant', content: '부분 응답' },
          ],
          drafts: [],
          createdAt: '2026-04-02T00:00:00.000Z',
          sortUpdatedAt: '2026-04-02T00:00:00.000Z',
          updatedAt: '2026-04-02T00:00:00.000Z',
        },
      ],
    },
    'thread-1',
    {
      threadId: 'thread-after',
      finalResponse: '부분 응답 이후까지 모두 포함한 최종 응답',
      updatedAt: '2026-04-02T00:00:05.000Z',
    }
  )

  assert.equal(nextState.threads[0]?.activeRunId, undefined)
  assert.equal(nextState.threads[0]?.threadId, 'thread-after')
  assert.equal(nextState.threads[0]?.messages[1]?.content, '부분 응답 이후까지 모두 포함한 최종 응답')
  assert.equal(nextState.threads[0]?.updatedAt, '2026-04-02T00:00:05.000Z')
})

test('failExplainReplyThreadState persists the terminal error onto the assistant reply', () => {
  const nextState = failExplainReplyThreadState(
    {
      selectedThreadId: 'thread-1',
      textEffect: 'plain',
      threads: [
        {
          id: 'thread-1',
          threadId: 'thread-1',
          activeRunId: 'run-1',
          continuityMode: 'native',
          composerDraft: '',
          messages: [
            { id: 'msg-user', role: 'user', content: '질문' },
            { id: 'msg-assistant', role: 'assistant', content: '부분 응답' },
          ],
          drafts: [],
          createdAt: '2026-04-02T00:00:00.000Z',
          sortUpdatedAt: '2026-04-02T00:00:00.000Z',
          updatedAt: '2026-04-02T00:00:00.000Z',
        },
      ],
    },
    'thread-1',
    {
      errorMessage: 'connection lost',
      updatedAt: '2026-04-02T00:00:06.000Z',
    }
  )

  assert.equal(nextState.threads[0]?.activeRunId, undefined)
  assert.equal(nextState.threads[0]?.messages[1]?.content, '부분 응답\n\n**Error**: connection lost')
  assert.equal(nextState.threads[0]?.updatedAt, '2026-04-02T00:00:06.000Z')
})
