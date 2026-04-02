import test from 'node:test'
import assert from 'node:assert/strict'
import {
  shouldRenderPendingAssistantFooter,
  shouldRenderPendingAssistantPlaceholder,
} from '../../web/components/ChatMessage.js'

test('shouldRenderPendingAssistantPlaceholder keeps waiting placeholder visible for empty pending assistant replies', () => {
  assert.equal(shouldRenderPendingAssistantPlaceholder('assistant', true, ''), true)
  assert.equal(shouldRenderPendingAssistantPlaceholder('assistant', true, 'partial answer'), false)
  assert.equal(shouldRenderPendingAssistantPlaceholder('assistant', false, ''), false)
  assert.equal(shouldRenderPendingAssistantPlaceholder('user', true, ''), false)
})

test('shouldRenderPendingAssistantFooter keeps an in-progress indicator visible while assistant text is streaming', () => {
  assert.equal(shouldRenderPendingAssistantFooter('assistant', true, 'partial answer'), true)
  assert.equal(shouldRenderPendingAssistantFooter('assistant', true, ''), false)
  assert.equal(shouldRenderPendingAssistantFooter('assistant', false, 'partial answer'), false)
  assert.equal(shouldRenderPendingAssistantFooter('user', true, 'partial answer'), false)
})
