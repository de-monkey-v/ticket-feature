import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildNextExplainMessages,
  normalizeStoredMessages,
  shouldInterceptImplementationRequestForExplain,
  shouldBypassRequestInterceptForExplain,
} from '../../web/lib/chat-session.js'

test('normalizeStoredMessages migrates legacy entries and skips invalid values', () => {
  let idCount = 0
  const messages = normalizeStoredMessages(
    [
      { role: 'user', content: 'legacy user' },
      { id: 'assistant-1', role: 'assistant', content: 'kept' },
      { role: 'system', content: 'skip me' },
      { role: 'user', content: 123 },
      null,
    ],
    () => `generated-${++idCount}`
  )

  assert.deepEqual(messages, [
    { id: 'generated-1', role: 'user', content: 'legacy user' },
    { id: 'assistant-1', role: 'assistant', content: 'kept' },
  ])
})

test('buildNextExplainMessages appends a new user turn and placeholder assistant', () => {
  let idCount = 0
  const result = buildNextExplainMessages(
    [{ id: 'user-1', role: 'user', content: 'first question' }],
    'second question',
    {
      idFactory: () => `generated-${++idCount}`,
    }
  )

  assert.equal(result.truncated, false)
  assert.deepEqual(result.baseMessages, [
    { id: 'user-1', role: 'user', content: 'first question' },
  ])
  assert.deepEqual(result.messages, [
    { id: 'user-1', role: 'user', content: 'first question' },
    { id: 'generated-1', role: 'user', content: 'second question' },
    { id: 'generated-2', role: 'assistant', content: '' },
  ])
})

test('buildNextExplainMessages restarts from the selected user message when editing', () => {
  let idCount = 0
  const result = buildNextExplainMessages(
    [
      { id: 'user-1', role: 'user', content: 'first question' },
      { id: 'assistant-1', role: 'assistant', content: 'first answer' },
      { id: 'user-2', role: 'user', content: 'second question' },
      { id: 'assistant-2', role: 'assistant', content: 'second answer' },
    ],
    'updated second question',
    {
      editMessageId: 'user-2',
      idFactory: () => `generated-${++idCount}`,
    }
  )

  assert.equal(result.truncated, true)
  assert.deepEqual(result.baseMessages, [
    { id: 'user-1', role: 'user', content: 'first question' },
    { id: 'assistant-1', role: 'assistant', content: 'first answer' },
  ])
  assert.deepEqual(result.messages, [
    { id: 'user-1', role: 'user', content: 'first question' },
    { id: 'assistant-1', role: 'assistant', content: 'first answer' },
    { id: 'generated-1', role: 'user', content: 'updated second question' },
    { id: 'generated-2', role: 'assistant', content: '' },
  ])
})

test('shouldBypassRequestInterceptForExplain keeps the original question when user declines request creation', () => {
  assert.equal(
    shouldBypassRequestInterceptForExplain(
      '그냥 explain으로 해달라',
      '이 버튼 동작을 수정하고 API 연결까지 해줘'
    ),
    true
  )
  assert.equal(
    shouldBypassRequestInterceptForExplain(
      'request 말고 설명만 해줘',
      '이 버튼 동작을 수정하고 API 연결까지 해줘'
    ),
    true
  )
  assert.equal(
    shouldBypassRequestInterceptForExplain(
      '이 버튼 동작을 수정하고 API 연결까지 해줘',
      '이 버튼 동작을 수정하고 API 연결까지 해줘'
    ),
    false
  )
  assert.equal(
    shouldBypassRequestInterceptForExplain(
      '로그인이 왜 실패하는지 원인을 알려줘',
      '이 버튼 동작을 수정하고 API 연결까지 해줘'
    ),
    false
  )
})

test('shouldInterceptImplementationRequestForExplain only intercepts implementation requests when enabled', () => {
  assert.equal(
    shouldInterceptImplementationRequestForExplain(
      '이 버튼 동작을 수정하고 API 연결까지 해줘',
      true
    ),
    true
  )
  assert.equal(
    shouldInterceptImplementationRequestForExplain(
      '이 버튼 동작을 수정하고 API 연결까지 해줘',
      false
    ),
    false
  )
  assert.equal(
    shouldInterceptImplementationRequestForExplain(
      '로그인이 왜 실패하는지 원인을 알려줘',
      true
    ),
    false
  )
})
