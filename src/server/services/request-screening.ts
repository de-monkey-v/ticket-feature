import type { RequestScreeningConfig } from '../lib/config.js'
import { getRequestScreeningFallbackModels } from '../lib/model-capabilities.js'
import { runCodexTurn } from './codex-sdk.js'
import type { RequestTemplateFields } from './client-requests.js'

export type RequestScreeningVerdict = 'valid' | 'noise' | 'needs_more_detail'

export interface RequestScreeningResult {
  verdict: RequestScreeningVerdict
  reason: string
  confidence: number
  source: 'heuristic' | 'model' | 'heuristic_fallback'
  attemptedModels: string[]
  model?: string
}

export interface ScreenManualRequestInputOptions {
  title?: string
  template: Partial<RequestTemplateFields>
  projectPath: string
  screeningConfig: RequestScreeningConfig
}

interface RequestScreeningModelOutput {
  verdict: RequestScreeningVerdict
  reason: string
  confidence: number
}

const requestScreeningSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'reason', 'confidence'],
  properties: {
    verdict: {
      type: 'string',
      enum: ['valid', 'noise', 'needs_more_detail'],
    },
    reason: {
      type: 'string',
    },
    confidence: {
      type: 'number',
    },
  },
} satisfies Record<string, unknown>

let runCodexTurnForRequestScreeningImpl: typeof runCodexTurn = runCodexTurn

function normalizeMultilineText(text: string | undefined) {
  return (text ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function formatPromptField(label: string, value: string | undefined) {
  return `${label}\n${value?.trim() ? value : '(empty)'}`
}

function buildRequestScreeningContent(options: ScreenManualRequestInputOptions) {
  return {
    title: normalizeMultilineText(options.title),
    problem: normalizeMultilineText(options.template.problem),
    desiredOutcome: normalizeMultilineText(options.template.desiredOutcome),
    userScenarios: normalizeMultilineText(options.template.userScenarios),
    constraints: normalizeMultilineText(options.template.constraints),
    nonGoals: normalizeMultilineText(options.template.nonGoals),
    openQuestions: normalizeMultilineText(options.template.openQuestions),
  }
}

function compactRequestText(content: ReturnType<typeof buildRequestScreeningContent>) {
  return Object.values(content).join('\n').replace(/\s+/g, '').toLowerCase()
}

function normalizedRequestFields(content: ReturnType<typeof buildRequestScreeningContent>) {
  return Object.values(content)
    .map((value) => value.replace(/\s+/g, '').toLowerCase())
    .filter(Boolean)
}

function hasMeaningfulLetters(text: string) {
  return /[a-z\uac00-\ud7a3]/i.test(text)
}

function isSequentialKeyboardRow(text: string) {
  const rows = ['1234567890', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm']

  return rows.some((row) => row.includes(text) || row.split('').reverse().join('').includes(text))
}

export function detectObviousRequestInputNoise(
  options: ScreenManualRequestInputOptions
): RequestScreeningResult | null {
  const content = buildRequestScreeningContent(options)
  const compact = compactRequestText(content)
  const normalizedFields = normalizedRequestFields(content)

  if (!compact) {
    return {
      verdict: 'needs_more_detail',
      reason: '요청 내용이 비어 있습니다.',
      confidence: 1,
      source: 'heuristic',
      attemptedModels: [],
    }
  }

  if (normalizedFields.length > 1 && new Set(normalizedFields).size === 1) {
    const repeatedValue = normalizedFields[0] || ''

    if (/^[\u3131-\u318e]+$/u.test(repeatedValue) && repeatedValue.length >= 2) {
      return {
        verdict: 'noise',
        reason: '같은 자모 입력이 여러 필드에 반복되었습니다.',
        confidence: 0.99,
        source: 'heuristic',
        attemptedModels: [],
      }
    }

    if (/^[0-9\p{P}\p{S}_]+$/u.test(repeatedValue) && repeatedValue.length >= 3) {
      return {
        verdict: 'noise',
        reason: '같은 숫자 또는 기호 입력이 여러 필드에 반복되었습니다.',
        confidence: 0.98,
        source: 'heuristic',
        attemptedModels: [],
      }
    }

    if (/^[a-z]+$/i.test(repeatedValue) && repeatedValue.length >= 4 && isSequentialKeyboardRow(repeatedValue)) {
      return {
        verdict: 'noise',
        reason: '같은 키보드 연속 입력이 여러 필드에 반복되었습니다.',
        confidence: 0.99,
        source: 'heuristic',
        attemptedModels: [],
      }
    }
  }

  if (/^[\u3131-\u318e]+$/u.test(compact) && compact.length >= 2) {
    return {
      verdict: 'noise',
      reason: '자모만 입력된 무의미한 텍스트입니다.',
      confidence: 0.99,
      source: 'heuristic',
      attemptedModels: [],
    }
  }

  if (/^[0-9\p{P}\p{S}_]+$/u.test(compact) && compact.length >= 3) {
    return {
      verdict: 'noise',
      reason: '숫자나 기호만으로 이루어진 입력입니다.',
      confidence: 0.98,
      source: 'heuristic',
      attemptedModels: [],
    }
  }

  if (/(.)\1{3,}/u.test(compact)) {
    return {
      verdict: 'noise',
      reason: '같은 문자가 과도하게 반복된 입력입니다.',
      confidence: 0.97,
      source: 'heuristic',
      attemptedModels: [],
    }
  }

  const uniqueChars = new Set(compact)
  if (compact.length >= 5 && uniqueChars.size <= 2 && !hasMeaningfulLetters(compact)) {
    return {
      verdict: 'noise',
      reason: '무의미한 반복 입력으로 보입니다.',
      confidence: 0.95,
      source: 'heuristic',
      attemptedModels: [],
    }
  }

  if (/^[a-z]+$/i.test(compact) && compact.length >= 4 && isSequentialKeyboardRow(compact)) {
    return {
      verdict: 'noise',
      reason: '키보드 연속 입력으로 보입니다.',
      confidence: 0.99,
      source: 'heuristic',
      attemptedModels: [],
    }
  }

  return null
}

export function buildManualRequestScreeningPrompt(options: ScreenManualRequestInputOptions) {
  const content = buildRequestScreeningContent(options)

  return [
    'Classify whether this manual client request intake input is meaningful, obvious noise, or needs more detail.',
    'Return JSON only.',
    '',
    'Manual request intake:',
    formatPromptField('Title:', content.title),
    '',
    formatPromptField('Problem:', content.problem),
    '',
    formatPromptField('Desired outcome:', content.desiredOutcome),
    '',
    formatPromptField('User scenarios:', content.userScenarios),
    '',
    formatPromptField('Constraints:', content.constraints),
    '',
    formatPromptField('Non-goals:', content.nonGoals),
    '',
    formatPromptField('Open questions:', content.openQuestions),
  ].join('\n')
}

function normalizeScreeningModelOutput(value: RequestScreeningModelOutput | undefined): RequestScreeningModelOutput | null {
  if (!value) {
    return null
  }

  if (value.verdict !== 'valid' && value.verdict !== 'noise' && value.verdict !== 'needs_more_detail') {
    return null
  }

  const reason = typeof value.reason === 'string' ? value.reason.trim() : ''
  const confidence = Number.isFinite(value.confidence) ? Math.max(0, Math.min(1, value.confidence)) : 0

  if (!reason) {
    return null
  }

  return {
    verdict: value.verdict,
    reason,
    confidence,
  }
}

function getScreeningReasoningEffort(model: string) {
  return /(mini|nano)$/i.test(model) ? 'low' : undefined
}

function isModelAvailabilityError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)

  return /unknown model|unsupported model|invalid model|model .*not found|no such model|model_not_found|not available/i.test(
    message
  )
}

async function runModelRequestScreening(
  model: string,
  options: ScreenManualRequestInputOptions
): Promise<RequestScreeningModelOutput> {
  const prompt = buildManualRequestScreeningPrompt(options)
  const result = await runCodexTurnForRequestScreeningImpl<RequestScreeningModelOutput>({
    prompt,
    promptFile: options.screeningConfig.promptFile,
    cwd: options.projectPath,
    model,
    reasoningEffort: getScreeningReasoningEffort(model),
    serviceTier: options.screeningConfig.serviceTier ?? 'fast',
    sandboxMode: 'read-only',
    approvalPolicy: 'never',
    networkAccessEnabled: false,
    outputSchema: requestScreeningSchema,
  })

  const normalized = normalizeScreeningModelOutput(result.parsedOutput as RequestScreeningModelOutput | undefined)
  if (!normalized) {
    throw new Error('Request screening model returned invalid output')
  }

  return normalized
}

export function setRunCodexTurnForRequestScreeningTesting(fn: typeof runCodexTurn) {
  runCodexTurnForRequestScreeningImpl = fn
}

export function resetRunCodexTurnForRequestScreeningTesting() {
  runCodexTurnForRequestScreeningImpl = runCodexTurn
}

export async function screenManualRequestInput(
  options: ScreenManualRequestInputOptions
): Promise<RequestScreeningResult> {
  const heuristicResult = detectObviousRequestInputNoise(options)
  if (heuristicResult) {
    return heuristicResult
  }

  const attemptedModels: string[] = []

  for (const model of getRequestScreeningFallbackModels(options.screeningConfig.model)) {
    attemptedModels.push(model)

    try {
      const result = await runModelRequestScreening(model, options)
      return {
        ...result,
        source: 'model',
        attemptedModels,
        model,
      }
    } catch (error) {
      if (isModelAvailabilityError(error)) {
        continue
      }

      console.warn(`Request screening model failed for ${model}:`, error)
      return {
        verdict: 'valid',
        reason: '모델 분류를 건너뛰고 규칙 기반 검사만 적용했습니다.',
        confidence: 0,
        source: 'heuristic_fallback',
        attemptedModels,
      }
    }
  }

  return {
    verdict: 'valid',
    reason: '사용 가능한 screening 모델이 없어 규칙 기반 검사만 적용했습니다.',
    confidence: 0,
    source: 'heuristic_fallback',
    attemptedModels,
  }
}
