import type { GeneratedRequestDraft, RequestTemplateFields } from './api'

const REQUEST_COMPOSE_STORAGE_PREFIX = 'intentlane-codex.request-compose'

export type RequestComposeDraftSelections = Record<string, boolean>

export interface RequestComposeState {
  requester: string
  title: string
  categoryId: string
  template: RequestTemplateFields
  draftPreview: GeneratedRequestDraft | null
  draftSelections: RequestComposeDraftSelections
  draftError: string | null
  draftIsStale: boolean
  activeRunId?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readString(value: unknown) {
  return typeof value === 'string' ? value : undefined
}

function readBoolean(value: unknown, fallback = false) {
  return typeof value === 'boolean' ? value : fallback
}

function normalizeTemplate(value: unknown): RequestTemplateFields {
  if (!isRecord(value)) {
    return {
      problem: '',
      desiredOutcome: '',
      userScenarios: '',
      constraints: '',
      nonGoals: '',
      openQuestions: '',
    }
  }

  return {
    problem: readString(value.problem) ?? '',
    desiredOutcome: readString(value.desiredOutcome) ?? '',
    userScenarios: readString(value.userScenarios) ?? '',
    constraints: readString(value.constraints) ?? '',
    nonGoals: readString(value.nonGoals) ?? '',
    openQuestions: readString(value.openQuestions) ?? '',
  }
}

function normalizeDraftPreview(value: unknown): GeneratedRequestDraft | null {
  if (!isRecord(value)) {
    return null
  }

  const title = readString(value.title)?.trim()
  const categoryId = readString(value.categoryId)?.trim()
  const template = normalizeTemplate(value.template)

  if (!title || !categoryId || !template.problem || !template.desiredOutcome || !template.userScenarios) {
    return null
  }

  return {
    title,
    categoryId,
    template,
    rationale: readString(value.rationale)?.trim() || undefined,
  }
}

function normalizeDraftSelections(value: unknown) {
  if (!isRecord(value)) {
    return {} as RequestComposeDraftSelections
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entryValue]) => [key, readBoolean(entryValue)])
  )
}

function getRequestComposeStorageKey(projectId: string) {
  return `${REQUEST_COMPOSE_STORAGE_PREFIX}:${projectId}`
}

export function loadRequestComposeState(projectId: string): RequestComposeState | null {
  if (!projectId || typeof window === 'undefined') {
    return null
  }

  try {
    const raw = window.sessionStorage.getItem(getRequestComposeStorageKey(projectId))
    if (!raw) {
      return null
    }

    const parsed = JSON.parse(raw)
    if (!isRecord(parsed)) {
      return null
    }

    return {
      requester: readString(parsed.requester) ?? '',
      title: readString(parsed.title) ?? '',
      categoryId: readString(parsed.categoryId) ?? '',
      template: normalizeTemplate(parsed.template),
      draftPreview: normalizeDraftPreview(parsed.draftPreview),
      draftSelections: normalizeDraftSelections(parsed.draftSelections),
      draftError: readString(parsed.draftError) ?? null,
      draftIsStale: readBoolean(parsed.draftIsStale),
      activeRunId: readString(parsed.activeRunId),
    }
  } catch (error) {
    console.error('Failed to load request compose state:', error)
    return null
  }
}

export function saveRequestComposeState(projectId: string, state: RequestComposeState) {
  if (!projectId || typeof window === 'undefined') {
    return
  }

  try {
    window.sessionStorage.setItem(getRequestComposeStorageKey(projectId), JSON.stringify(state))
  } catch (error) {
    console.error('Failed to save request compose state:', error)
  }
}

export function clearRequestComposeState(projectId: string) {
  if (!projectId || typeof window === 'undefined') {
    return
  }

  try {
    window.sessionStorage.removeItem(getRequestComposeStorageKey(projectId))
  } catch (error) {
    console.error('Failed to clear request compose state:', error)
  }
}
