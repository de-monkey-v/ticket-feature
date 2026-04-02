import type { ReasoningEffort } from './config.js'

export interface ModelCapability {
  id: string
  label: string
  supportedReasoningEfforts: ReasoningEffort[]
  defaultReasoningEffort: ReasoningEffort
}

export interface ScreeningModelOption {
  id: string
  label: string
}

const LOW_MEDIUM_HIGH_XHIGH: ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh']

const MODEL_CAPABILITIES: ModelCapability[] = [
  {
    id: 'gpt-5.4',
    label: 'gpt-5.4',
    supportedReasoningEfforts: LOW_MEDIUM_HIGH_XHIGH,
    defaultReasoningEffort: 'medium',
  },
  {
    id: 'gpt-5.4-mini',
    label: 'gpt-5.4-mini',
    supportedReasoningEfforts: LOW_MEDIUM_HIGH_XHIGH,
    defaultReasoningEffort: 'medium',
  },
  {
    id: 'gpt-5.3-codex',
    label: 'gpt-5.3-codex',
    supportedReasoningEfforts: LOW_MEDIUM_HIGH_XHIGH,
    defaultReasoningEffort: 'medium',
  },
  {
    id: 'gpt-5.3-codex-spark',
    label: 'gpt-5.3-codex-spark',
    supportedReasoningEfforts: LOW_MEDIUM_HIGH_XHIGH,
    defaultReasoningEffort: 'high',
  },
  {
    id: 'gpt-5.2-codex',
    label: 'gpt-5.2-codex',
    supportedReasoningEfforts: LOW_MEDIUM_HIGH_XHIGH,
    defaultReasoningEffort: 'medium',
  },
]

const SCREENING_MODEL_OPTIONS: ScreeningModelOption[] = [
  {
    id: 'gpt-5.3-codex-spark',
    label: 'gpt-5.3-codex-spark',
  },
  {
    id: 'gpt-5-mini',
    label: 'gpt-5-mini',
  },
  {
    id: 'gpt-5.4-mini',
    label: 'gpt-5.4-mini',
  },
  {
    id: 'gpt-5-nano',
    label: 'gpt-5-nano',
  },
  {
    id: 'gpt-5.4-nano',
    label: 'gpt-5.4-nano',
  },
]

export function listModelCapabilities(currentModel?: string): ModelCapability[] {
  return MODEL_CAPABILITIES
}

export function listScreeningModelOptions(): ScreeningModelOption[] {
  return SCREENING_MODEL_OPTIONS
}

export function getModelCapability(model: string | undefined) {
  const capabilities = listModelCapabilities(model)
  if (!model?.trim()) {
    return capabilities[0]
  }

  return capabilities.find((entry) => entry.id === model.trim()) ?? MODEL_CAPABILITIES[0]
}

export function resolveReasoningEffortForModel(
  model: string | undefined,
  effort: ReasoningEffort | undefined
): ReasoningEffort {
  const capability = getModelCapability(model)

  if (effort && capability.supportedReasoningEfforts.includes(effort)) {
    return effort
  }

  if (effort === 'xhigh' && capability.supportedReasoningEfforts.includes('high')) {
    return 'high'
  }

  if (effort === 'high' && capability.supportedReasoningEfforts.includes('medium')) {
    return 'medium'
  }

  if (effort === 'medium' && capability.supportedReasoningEfforts.includes('low')) {
    return 'low'
  }

  return capability.defaultReasoningEffort
}

export function getRequestScreeningFallbackModels(selectedModel: string | undefined): string[] {
  const preferred = selectedModel?.trim()
  const curated = SCREENING_MODEL_OPTIONS.map((entry) => entry.id)

  if (!preferred) {
    return curated
  }

  if (curated.includes(preferred)) {
    return [preferred, ...curated.filter((entry) => entry !== preferred)]
  }

  return [preferred, ...curated]
}
