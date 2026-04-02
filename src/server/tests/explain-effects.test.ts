import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_EXPLAIN_TEXT_EFFECT,
  EXPLAIN_TEXT_EFFECT_OPTIONS,
  getStreamingAssistantEffectClassName,
  normalizeExplainTextEffect,
  shouldQueueExplainDeltas,
} from '../../web/lib/explain-effects.js'

test('normalizeExplainTextEffect keeps supported ids and defaults invalid values', () => {
  assert.deepEqual(
    EXPLAIN_TEXT_EFFECT_OPTIONS.map((option) => normalizeExplainTextEffect(option.id)),
    EXPLAIN_TEXT_EFFECT_OPTIONS.map((option) => option.id)
  )

  assert.equal(normalizeExplainTextEffect('unknown'), DEFAULT_EXPLAIN_TEXT_EFFECT)
  assert.equal(normalizeExplainTextEffect(undefined), DEFAULT_EXPLAIN_TEXT_EFFECT)
})

test('shouldQueueExplainDeltas only disables smoothing for plain mode', () => {
  assert.equal(shouldQueueExplainDeltas('plain'), false)
  assert.equal(shouldQueueExplainDeltas('smooth-type'), true)
  assert.equal(shouldQueueExplainDeltas('fade'), true)
  assert.equal(shouldQueueExplainDeltas('focus'), true)
})

test('getStreamingAssistantEffectClassName only decorates streaming-only visual effects', () => {
  assert.equal(getStreamingAssistantEffectClassName('plain'), '')
  assert.equal(getStreamingAssistantEffectClassName('smooth-type'), '')
  assert.match(getStreamingAssistantEffectClassName('fade'), /animate-pulse/)
  assert.match(getStreamingAssistantEffectClassName('focus'), /ring-1/)
})
