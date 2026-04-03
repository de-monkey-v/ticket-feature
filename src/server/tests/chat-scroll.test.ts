import test from 'node:test'
import assert from 'node:assert/strict'
import { getLastUserMessageId } from '../../web/lib/chat-scroll.js'

test('getLastUserMessageId returns the newest user message id', () => {
  assert.equal(
    getLastUserMessageId([
      { id: 'user-1', role: 'user' },
      { id: 'assistant-1', role: 'assistant' },
      { id: 'user-2', role: 'user' },
      { id: 'assistant-2', role: 'assistant' },
    ]),
    'user-2'
  )
})

test('getLastUserMessageId returns null when the thread has no user messages', () => {
  assert.equal(
    getLastUserMessageId([
      { id: 'assistant-1', role: 'assistant' },
      { id: 'assistant-2', role: 'assistant' },
    ]),
    null
  )
})
