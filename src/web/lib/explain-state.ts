import type { RequestTemplateFields } from './api'
import { normalizeStoredMessages, type ChatMessageRecord } from './chat-session'
import {
  DEFAULT_EXPLAIN_TEXT_EFFECT,
  normalizeExplainTextEffect,
  type ExplainTextEffectId,
} from './explain-effects'

export interface ExplainRequestDraft {
  id: string
  title: string
  categoryId: string
  template: RequestTemplateFields
  rationale?: string
  explainThreadId?: string
  status: 'drafting' | 'draft' | 'saving' | 'saved' | 'error'
  requestId?: string
  error?: string
  createdAt: string
  updatedAt: string
}

export type ExplainContinuityMode = 'native' | 'rehydrated'

export interface ExplainThreadState {
  id: string
  title?: string
  threadId?: string
  activeRunId?: string
  continuityMode: ExplainContinuityMode
  lastRecoveryAt?: string
  lastRecoveryReason?: string
  composerDraft: string
  messages: ChatMessageRecord[]
  drafts: ExplainRequestDraft[]
  createdAt: string
  sortUpdatedAt: string
  updatedAt: string
}

export interface ExplainState {
  selectedThreadId: string
  textEffect: ExplainTextEffectId
  threads: ExplainThreadState[]
}

export type ExplainStateChange = ExplainState | ((state: ExplainState) => ExplainState)

export interface ExplainThreadSummary {
  id: string
  title?: string
  label: string
  preview: string
  continuityMode: ExplainContinuityMode
  updatedAt: string
}

export interface ExplainThreadOverview {
  selectedThreadId: string
  threads: ExplainThreadSummary[]
}

const DEFAULT_THREAD_LABEL = 'New thread'
const THREAD_LABEL_LIMIT = 48
const THREAD_PREVIEW_LIMIT = 80
const INITIAL_THREAD_ID = 'thread-initial'

function createThreadKey() {
  return `thread-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function normalizeText(value: string, limit: number) {
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (!normalized) {
    return ''
  }

  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized
}

function sortThreads(threads: ExplainThreadState[]) {
  return [...threads].sort((left, right) => {
    const sortComparison = right.sortUpdatedAt.localeCompare(left.sortUpdatedAt)
    if (sortComparison !== 0) {
      return sortComparison
    }

    return right.updatedAt.localeCompare(left.updatedAt)
  })
}

function createInitialThread(now = new Date().toISOString()): ExplainThreadState {
  return {
    id: INITIAL_THREAD_ID,
    continuityMode: 'native',
    composerDraft: '',
    messages: [],
    drafts: [],
    createdAt: now,
    sortUpdatedAt: now,
    updatedAt: now,
  }
}

export function createEmptyExplainThread(now = new Date().toISOString()): ExplainThreadState {
  return {
    id: createThreadKey(),
    continuityMode: 'native',
    composerDraft: '',
    messages: [],
    drafts: [],
    createdAt: now,
    sortUpdatedAt: now,
    updatedAt: now,
  }
}

export function createDefaultExplainState(now = new Date().toISOString()): ExplainState {
  const thread = createInitialThread(now)
  return {
    selectedThreadId: thread.id,
    textEffect: DEFAULT_EXPLAIN_TEXT_EFFECT,
    threads: [thread],
  }
}

function getThreadLabel(messages: ChatMessageRecord[]) {
  const firstUserMessage = messages.find((message) => message.role === 'user' && message.content.trim())
  return firstUserMessage ? normalizeText(firstUserMessage.content, THREAD_LABEL_LIMIT) : DEFAULT_THREAD_LABEL
}

function getThreadPreview(messages: ChatMessageRecord[]) {
  const latestMessage = [...messages].reverse().find((message) => message.content.trim())
  return latestMessage ? normalizeText(latestMessage.content, THREAD_PREVIEW_LIMIT) : DEFAULT_THREAD_LABEL
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readString(value: unknown) {
  return typeof value === 'string' ? value : undefined
}

function normalizeThreadTitle(value: unknown) {
  const title = readString(value)?.trim()
  return title ? title : undefined
}

function normalizeContinuityMode(value: unknown): ExplainContinuityMode {
  return value === 'rehydrated' ? 'rehydrated' : 'native'
}

function isDraftStatus(value: unknown): value is ExplainRequestDraft['status'] {
  return value === 'drafting' || value === 'draft' || value === 'saving' || value === 'saved' || value === 'error'
}

function normalizeDrafts(value: unknown): ExplainRequestDraft[] {
  if (!Array.isArray(value)) {
    return []
  }

  return value.flatMap((entry) => {
    if (!isRecord(entry)) {
      return []
    }

    const id = readString(entry.id)
    const title = readString(entry.title)
    const categoryId = readString(entry.categoryId)
    const status = readString(entry.status)
    const createdAt = readString(entry.createdAt)
    const updatedAt = readString(entry.updatedAt)
    const template = isRecord(entry.template)
      ? {
          problem: readString(entry.template.problem) ?? '',
          desiredOutcome: readString(entry.template.desiredOutcome) ?? '',
          userScenarios: readString(entry.template.userScenarios) ?? '',
          constraints: readString(entry.template.constraints),
          nonGoals: readString(entry.template.nonGoals),
          openQuestions: readString(entry.template.openQuestions),
        }
      : undefined

    if (
      !id ||
      !title ||
      !categoryId ||
      !isDraftStatus(status) ||
      status === 'saved' ||
      !createdAt ||
      !updatedAt ||
      !template
    ) {
      return []
    }

    return [
      {
        id,
        title,
        categoryId,
        template,
        rationale: readString(entry.rationale),
        explainThreadId: readString(entry.explainThreadId),
        status,
        requestId: readString(entry.requestId),
        error: readString(entry.error),
        createdAt,
        updatedAt,
      },
    ]
  })
}

function normalizeThread(entry: unknown, index: number): ExplainThreadState | null {
  if (!isRecord(entry)) {
    return null
  }

  const now = new Date().toISOString()

  return {
    id: readString(entry.id) ?? (index === 0 ? INITIAL_THREAD_ID : createThreadKey()),
    title: normalizeThreadTitle(entry.title),
    threadId: readString(entry.threadId),
    activeRunId: readString(entry.activeRunId),
    continuityMode: normalizeContinuityMode(entry.continuityMode),
    lastRecoveryAt: readString(entry.lastRecoveryAt),
    lastRecoveryReason: readString(entry.lastRecoveryReason),
    composerDraft: readString(entry.composerDraft) ?? '',
    messages: normalizeStoredMessages(entry.messages),
    drafts: normalizeDrafts(entry.drafts),
    createdAt: readString(entry.createdAt) ?? now,
    sortUpdatedAt: readString(entry.sortUpdatedAt) ?? readString(entry.updatedAt) ?? now,
    updatedAt: readString(entry.updatedAt) ?? now,
  }
}

export function normalizeExplainState(raw: unknown): ExplainState {
  if (typeof raw === 'string') {
    try {
      return normalizeExplainState(JSON.parse(raw))
    } catch {
      return createDefaultExplainState()
    }
  }

  if (!isRecord(raw)) {
    return createDefaultExplainState()
  }

  if (Array.isArray(raw.threads)) {
    const threads = sortThreads(raw.threads.map((entry, index) => normalizeThread(entry, index)).filter((entry): entry is ExplainThreadState => entry !== null))
    const storedSelectedThreadId = readString(raw.selectedThreadId)
    const selectedThreadId =
      threads.length === 0
        ? ''
        : storedSelectedThreadId && threads.some((thread) => thread.id === storedSelectedThreadId)
          ? storedSelectedThreadId
          : threads[0]!.id

    return {
      selectedThreadId,
      textEffect: normalizeExplainTextEffect(raw.textEffect),
      threads,
    }
  }

  const now = new Date().toISOString()
  const legacyThread: ExplainThreadState = {
    id: INITIAL_THREAD_ID,
    title: normalizeThreadTitle(raw.title),
    threadId: readString(raw.threadId),
    activeRunId: readString(raw.activeRunId),
    continuityMode: normalizeContinuityMode(raw.continuityMode),
    lastRecoveryAt: readString(raw.lastRecoveryAt),
    lastRecoveryReason: readString(raw.lastRecoveryReason),
    composerDraft: readString(raw.composerDraft) ?? '',
    messages: normalizeStoredMessages(raw.messages),
    drafts: normalizeDrafts(raw.drafts),
    createdAt: now,
    sortUpdatedAt: readString(raw.sortUpdatedAt) ?? readString(raw.updatedAt) ?? now,
    updatedAt: now,
  }

  return {
    selectedThreadId: legacyThread.id,
    textEffect: DEFAULT_EXPLAIN_TEXT_EFFECT,
    threads: [legacyThread],
  }
}

export function resolveExplainStateChange(
  currentState: ExplainState | null,
  change: ExplainStateChange
): ExplainState | null {
  if (typeof change === 'function') {
    return currentState ? change(currentState) : currentState
  }

  return change
}

export function toExplainThreadOverview(state: ExplainState): ExplainThreadOverview {
  return {
    selectedThreadId:
      state.selectedThreadId && state.threads.some((thread) => thread.id === state.selectedThreadId)
        ? state.selectedThreadId
        : '',
    threads: state.threads.map((thread) => ({
      id: thread.id,
      title: thread.title,
      label: thread.title ? normalizeText(thread.title, THREAD_LABEL_LIMIT) : getThreadLabel(thread.messages),
      preview: getThreadPreview(thread.messages),
      continuityMode: thread.continuityMode,
      updatedAt: thread.updatedAt,
    })),
  }
}

export function selectExplainThreadState(state: ExplainState, selectedThreadId: string): ExplainState {
  if (state.threads.length === 0) {
    if (!state.selectedThreadId) {
      return state
    }

    return {
      ...state,
      selectedThreadId: '',
    }
  }

  const nextSelectedThreadId =
    selectedThreadId && state.threads.some((thread) => thread.id === selectedThreadId)
      ? selectedThreadId
      : state.threads[0]!.id

  if (nextSelectedThreadId === state.selectedThreadId) {
    return state
  }

  return {
    ...state,
    selectedThreadId: nextSelectedThreadId,
  }
}

export function createExplainThreadState(state: ExplainState): ExplainState {
  const nextThread = createEmptyExplainThread()
  return {
    selectedThreadId: nextThread.id,
    textEffect: state.textEffect,
    threads: sortThreads([nextThread, ...state.threads]),
  }
}

export function deleteExplainThreadState(state: ExplainState, threadKey: string): ExplainState {
  const remainingThreads = sortThreads(state.threads.filter((thread) => thread.id !== threadKey))

  if (remainingThreads.length === state.threads.length) {
    return state
  }

  if (remainingThreads.length === 0) {
    return {
      selectedThreadId: '',
      textEffect: state.textEffect,
      threads: [],
    }
  }

  const nextSelectedThreadId =
    state.selectedThreadId === threadKey || !remainingThreads.some((thread) => thread.id === state.selectedThreadId)
      ? remainingThreads[0]!.id
      : state.selectedThreadId

  return {
    selectedThreadId: nextSelectedThreadId,
    textEffect: state.textEffect,
    threads: remainingThreads,
  }
}

export function updateExplainThreadState(
  state: ExplainState,
  threadKey: string,
  updater: (thread: ExplainThreadState) => ExplainThreadState
): ExplainState {
  let didUpdate = false
  const nextThreads = sortThreads(
    state.threads.map((thread) => {
      if (thread.id !== threadKey) {
        return thread
      }

      didUpdate = true
      return updater(thread)
    })
  )

  if (!didUpdate) {
    return state
  }

  return {
    selectedThreadId: state.selectedThreadId,
    textEffect: state.textEffect,
    threads: nextThreads,
  }
}

export function updateExplainDraftState(
  state: ExplainState,
  threadKey: string,
  draftId: string,
  patch: Partial<ExplainRequestDraft>
): ExplainState {
  const now = new Date().toISOString()
  return updateExplainThreadState(state, threadKey, (thread) => ({
    ...thread,
    drafts: thread.drafts.map((draft) =>
      draft.id === draftId
        ? {
            ...draft,
            ...patch,
            updatedAt: now,
          }
        : draft
    ),
    updatedAt: now,
  }))
}

export function removeExplainDraftState(state: ExplainState, threadKey: string, draftId: string): ExplainState {
  const now = new Date().toISOString()
  return updateExplainThreadState(state, threadKey, (thread) => ({
    ...thread,
    drafts: thread.drafts.filter((draft) => draft.id !== draftId),
    updatedAt: now,
  }))
}

export function renameExplainThreadState(state: ExplainState, threadKey: string, title: string): ExplainState {
  const normalizedTitle = title.trim()
  return updateExplainThreadState(state, threadKey, (thread) => {
    if ((thread.title ?? '') === normalizedTitle) {
      return thread
    }

    const now = new Date().toISOString()
    return {
      ...thread,
      title: normalizedTitle || undefined,
      updatedAt: now,
    }
  })
}

function legacyStorageKey(projectId: string) {
  return `intentlane-codex.explain.${projectId}`
}

export function loadLegacyExplainState(projectId: string): ExplainState | null {
  if (typeof window === 'undefined') {
    return null
  }

  const raw = window.localStorage.getItem(legacyStorageKey(projectId))
  return raw === null ? null : normalizeExplainState(raw)
}

export function clearLegacyExplainState(projectId: string) {
  if (typeof window === 'undefined') {
    return
  }

  window.localStorage.removeItem(legacyStorageKey(projectId))
}
