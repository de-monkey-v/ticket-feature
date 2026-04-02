import test from 'node:test'
import assert from 'node:assert/strict'
import type { RunCodexTurnOptions } from '../services/codex-sdk.js'
import {
  detectObviousRequestInputNoise,
  resetRunCodexTurnForRequestScreeningTesting,
  screenManualRequestInput,
  setRunCodexTurnForRequestScreeningTesting,
} from '../services/request-screening.js'

const screeningConfig = {
  promptFile: 'prompts/request-screening.txt',
  model: 'gpt-5.3-codex-spark',
  serviceTier: 'fast' as const,
}

test('detectObviousRequestInputNoise rejects obvious keyboard mash and symbol noise', () => {
  const jamoNoise = detectObviousRequestInputNoise({
    title: 'ㅁㄴㅇ',
    template: {},
    projectPath: process.cwd(),
    screeningConfig,
  })
  const keyboardNoise = detectObviousRequestInputNoise({
    title: 'asdf',
    template: {},
    projectPath: process.cwd(),
    screeningConfig,
  })
  const symbolNoise = detectObviousRequestInputNoise({
    title: '1111!!!!',
    template: {},
    projectPath: process.cwd(),
    screeningConfig,
  })
  const repeatedFieldNoise = detectObviousRequestInputNoise({
    title: 'asdf',
    template: {
      problem: 'asdf',
      desiredOutcome: 'asdf',
      userScenarios: 'asdf',
    },
    projectPath: process.cwd(),
    screeningConfig,
  })

  assert.equal(jamoNoise?.verdict, 'noise')
  assert.equal(keyboardNoise?.verdict, 'noise')
  assert.equal(symbolNoise?.verdict, 'noise')
  assert.equal(repeatedFieldNoise?.verdict, 'noise')
})

test('detectObviousRequestInputNoise keeps short but meaningful input for model screening', () => {
  const result = detectObviousRequestInputNoise({
    title: '로그인 버그',
    template: {
      problem: '로그인이 안 된다.',
    },
    projectPath: process.cwd(),
    screeningConfig,
  })

  assert.equal(result, null)
})

test('screenManualRequestInput tries selected custom model first and falls back on model availability errors', async () => {
  const attemptedModels: string[] = []

  setRunCodexTurnForRequestScreeningTesting(async <T = unknown>(opts: RunCodexTurnOptions) => {
    attemptedModels.push(opts.model)

    if (opts.model === 'custom-screening-model') {
      throw new Error('unknown model: custom-screening-model')
    }

    return {
      threadId: null,
      finalResponse: '',
      parsedOutput: {
        verdict: 'valid',
        reason: '의미 있는 요청입니다.',
        confidence: 0.91,
      } as T,
    }
  })

  try {
    const result = await screenManualRequestInput({
      title: 'Requests 폼 자동 보완',
      template: {
        problem: '사용자가 요청을 끝까지 쓰기 어렵다.',
      },
      projectPath: process.cwd(),
      screeningConfig: {
        ...screeningConfig,
        model: 'custom-screening-model',
      },
    })

    assert.equal(result.verdict, 'valid')
    assert.equal(result.source, 'model')
    assert.equal(result.model, 'gpt-5.3-codex-spark')
    assert.deepEqual(attemptedModels.slice(0, 2), ['custom-screening-model', 'gpt-5.3-codex-spark'])
  } finally {
    resetRunCodexTurnForRequestScreeningTesting()
  }
})

test('screenManualRequestInput falls back to heuristics-only when runtime fails for non-availability reasons', async () => {
  const originalWarn = console.warn
  console.warn = () => undefined
  setRunCodexTurnForRequestScreeningTesting(async () => {
    throw new Error('runtime transport timeout')
  })

  try {
    const result = await screenManualRequestInput({
      title: 'Requests 폼 자동 보완',
      template: {
        problem: '사용자가 요청을 끝까지 쓰기 어렵다.',
      },
      projectPath: process.cwd(),
      screeningConfig,
    })

    assert.equal(result.verdict, 'valid')
    assert.equal(result.source, 'heuristic_fallback')
    assert.deepEqual(result.attemptedModels, ['gpt-5.3-codex-spark'])
  } finally {
    console.warn = originalWarn
    resetRunCodexTurnForRequestScreeningTesting()
  }
})

test('screenManualRequestInput returns needs_more_detail when model classifies the input as too vague', async () => {
  setRunCodexTurnForRequestScreeningTesting(async <T = unknown>() => ({
    threadId: null,
    finalResponse: '',
    parsedOutput: {
      verdict: 'needs_more_detail',
      reason: '의도는 보이지만 너무 짧습니다.',
      confidence: 0.73,
    } as T,
  }))

  try {
    const result = await screenManualRequestInput({
      title: '수정 필요',
      template: {
        problem: '좀 바꿔줘.',
      },
      projectPath: process.cwd(),
      screeningConfig,
    })

    assert.equal(result.verdict, 'needs_more_detail')
    assert.equal(result.source, 'model')
    assert.equal(result.model, 'gpt-5.3-codex-spark')
  } finally {
    resetRunCodexTurnForRequestScreeningTesting()
  }
})
