export const EXPLAIN_TEXT_EFFECT_OPTIONS = [
  { id: 'plain', label: 'Plain' },
  { id: 'smooth-type', label: 'Smooth Type' },
  { id: 'fade', label: 'Fade' },
  { id: 'focus', label: 'Focus' },
] as const

export type ExplainTextEffectId = (typeof EXPLAIN_TEXT_EFFECT_OPTIONS)[number]['id']

export const DEFAULT_EXPLAIN_TEXT_EFFECT: ExplainTextEffectId = 'smooth-type'

const EXPLAIN_TEXT_EFFECT_IDS = new Set<ExplainTextEffectId>(
  EXPLAIN_TEXT_EFFECT_OPTIONS.map((option) => option.id)
)

export function normalizeExplainTextEffect(value: unknown): ExplainTextEffectId {
  return typeof value === 'string' && EXPLAIN_TEXT_EFFECT_IDS.has(value as ExplainTextEffectId)
    ? (value as ExplainTextEffectId)
    : DEFAULT_EXPLAIN_TEXT_EFFECT
}

export function shouldQueueExplainDeltas(effect: ExplainTextEffectId) {
  return effect !== 'plain'
}

export function getStreamingAssistantEffectClassName(effect: ExplainTextEffectId) {
  if (effect === 'fade') {
    return 'rounded-2xl bg-zinc-900/30 px-4 py-3 opacity-90 animate-pulse'
  }

  if (effect === 'focus') {
    return 'rounded-2xl bg-zinc-900/40 px-4 py-3 ring-1 ring-sky-800/60 shadow-lg shadow-sky-950/20'
  }

  return ''
}
