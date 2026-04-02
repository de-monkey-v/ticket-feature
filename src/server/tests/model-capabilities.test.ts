import test from 'node:test'
import assert from 'node:assert/strict'
import {
  getModelCapability,
  getRequestScreeningFallbackModels,
  listModelCapabilities,
  listScreeningModelOptions,
  resolveReasoningEffortForModel,
} from '../lib/model-capabilities.js'

test('listModelCapabilities includes the supported explain models', () => {
  const capabilities = listModelCapabilities('gpt-5.4')

  assert.deepEqual(
    capabilities.map((entry) => entry.id),
    ['gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex', 'gpt-5.3-codex-spark', 'gpt-5.2-codex']
  )
})

test('resolveReasoningEffortForModel keeps supported efforts and normalizes unsupported ones safely', () => {
  assert.equal(resolveReasoningEffortForModel('gpt-5.4', 'xhigh'), 'xhigh')
  assert.equal(getModelCapability('gpt-5.4').defaultReasoningEffort, 'medium')
  assert.equal(getModelCapability('gpt-5.4-mini').defaultReasoningEffort, 'medium')
  assert.equal(getModelCapability('gpt-5.3-codex').defaultReasoningEffort, 'medium')
  assert.equal(getModelCapability('gpt-5.3-codex-spark').defaultReasoningEffort, 'high')
  assert.equal(getModelCapability('gpt-5.2-codex').defaultReasoningEffort, 'medium')
  assert.equal(resolveReasoningEffortForModel('gpt-5.4-mini', 'xhigh'), 'xhigh')
  assert.equal(resolveReasoningEffortForModel('gpt-5.3-codex', 'xhigh'), 'xhigh')
  assert.equal(resolveReasoningEffortForModel('gpt-5.4', 'none'), 'medium')
  assert.equal(resolveReasoningEffortForModel('gpt-5.3-codex-spark', 'minimal'), 'high')
  assert.equal(getModelCapability('unknown-private-model').id, 'gpt-5.4')
})

test('listScreeningModelOptions exposes request screening candidates', () => {
  const options = listScreeningModelOptions()

  assert.deepEqual(
    options.map((entry) => entry.id),
    ['gpt-5.3-codex-spark', 'gpt-5-mini', 'gpt-5.4-mini', 'gpt-5-nano', 'gpt-5.4-nano']
  )
})

test('getRequestScreeningFallbackModels keeps custom and curated preference first', () => {
  assert.deepEqual(getRequestScreeningFallbackModels('gpt-5.4-mini').slice(0, 3), [
    'gpt-5.4-mini',
    'gpt-5.3-codex-spark',
    'gpt-5-mini',
  ])

  assert.deepEqual(getRequestScreeningFallbackModels('custom-screening-model').slice(0, 4), [
    'custom-screening-model',
    'gpt-5.3-codex-spark',
    'gpt-5-mini',
    'gpt-5.4-mini',
  ])
})
