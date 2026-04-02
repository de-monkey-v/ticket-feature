import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { AuthSession } from '../lib/access-policy.js'
import { resolveRuntimeDataPath } from '../lib/runtime-data-paths.js'
import {
  getBackgroundRun,
  readBackgroundRunEventJournal,
  type BackgroundRunSummary,
} from './background-runs.js'
import { normalizeRequestTemplate, type RequestTemplateFields } from './client-requests.js'

export interface ExplainMessageRecord {
  id: string
  role: 'user' | 'assistant'
  content: string
}

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
  messages: ExplainMessageRecord[]
  drafts: ExplainRequestDraft[]
  createdAt: string
  sortUpdatedAt: string
  updatedAt: string
}

export interface ExplainState {
  selectedThreadId: string
  textEffect: string
  threads: ExplainThreadState[]
}

export interface LoadExplainStateResult {
  state: ExplainState
  persisted: boolean
}

interface PersistedExplainState extends ExplainState {
  version: 1
  ownerId: string
  projectId: string
}

const DEFAULT_TEXT_EFFECT = 'smooth-type'
const INITIAL_THREAD_ID = 'thread-initial'

function nowIso() {
  return new Date().toISOString()
}

function createThreadKey() {
  return `thread-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function createDefaultThread(now = nowIso()): ExplainThreadState {
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

export function createDefaultExplainState(now = nowIso()): ExplainState {
  const thread = createDefaultThread(now)
  return {
    selectedThreadId: thread.id,
    textEffect: DEFAULT_TEXT_EFFECT,
    threads: [thread],
  }
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

function isMessageRole(value: unknown): value is ExplainMessageRecord['role'] {
  return value === 'user' || value === 'assistant'
}

function normalizeMessages(value: unknown): ExplainMessageRecord[] {
  if (!Array.isArray(value)) {
    return []
  }

  return value.flatMap((entry, index) => {
    if (!isRecord(entry) || !isMessageRole(entry.role) || typeof entry.content !== 'string') {
      return []
    }

    return [
      {
        id: readString(entry.id) ?? `msg-${index + 1}`,
        role: entry.role,
        content: entry.content,
      },
    ]
  })
}

function createEmptyRequestTemplate(): RequestTemplateFields {
  return {
    problem: '',
    desiredOutcome: '',
    userScenarios: '',
  }
}

function normalizeDraftTemplate(value: unknown): RequestTemplateFields {
  if (!isRecord(value)) {
    return createEmptyRequestTemplate()
  }

  return normalizeRequestTemplate({
    problem: readString(value.problem) ?? '',
    desiredOutcome: readString(value.desiredOutcome) ?? '',
    userScenarios: readString(value.userScenarios) ?? '',
    constraints: readString(value.constraints),
    nonGoals: readString(value.nonGoals),
    openQuestions: readString(value.openQuestions),
  })
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

    if (!id || !title || !categoryId || !isDraftStatus(status) || status === 'saved' || !createdAt || !updatedAt) {
      return []
    }

    return [
      {
        id,
        title,
        categoryId,
        template: normalizeDraftTemplate(entry.template),
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

function sortThreads(threads: ExplainThreadState[]) {
  return [...threads].sort((left, right) => {
    const sortComparison = right.sortUpdatedAt.localeCompare(left.sortUpdatedAt)
    if (sortComparison !== 0) {
      return sortComparison
    }

    return right.updatedAt.localeCompare(left.updatedAt)
  })
}

function normalizeThread(entry: unknown, index: number): ExplainThreadState | null {
  if (!isRecord(entry)) {
    return null
  }

  const now = nowIso()

  return {
    id: readString(entry.id) ?? (index === 0 ? INITIAL_THREAD_ID : createThreadKey()),
    title: normalizeThreadTitle(entry.title),
    threadId: readString(entry.threadId),
    activeRunId: readString(entry.activeRunId),
    continuityMode: normalizeContinuityMode(entry.continuityMode),
    lastRecoveryAt: readString(entry.lastRecoveryAt),
    lastRecoveryReason: readString(entry.lastRecoveryReason),
    composerDraft: readString(entry.composerDraft) ?? '',
    messages: normalizeMessages(entry.messages),
    drafts: normalizeDrafts(entry.drafts),
    createdAt: readString(entry.createdAt) ?? now,
    sortUpdatedAt: readString(entry.sortUpdatedAt) ?? readString(entry.updatedAt) ?? now,
    updatedAt: readString(entry.updatedAt) ?? now,
  }
}

function isTerminalBackgroundRun(run: BackgroundRunSummary | undefined) {
  return run?.status === 'completed' || run?.status === 'stopped' || run?.status === 'failed'
}

function updateLastAssistantMessage(messages: ExplainMessageRecord[], updater: (current: string) => string) {
  const next = [...messages]

  for (let index = next.length - 1; index >= 0; index -= 1) {
    if (next[index]?.role !== 'assistant') {
      continue
    }

    next[index] = {
      ...next[index],
      content: updater(next[index].content),
    }
    return next
  }

  return next
}

function reconcileExplainReplyThread(thread: ExplainThreadState, run: BackgroundRunSummary) {
  const result = isRecord(run.result) ? run.result : undefined
  const terminalEvent = [...readBackgroundRunEventJournal(run.id)]
    .reverse()
    .find((event) => event.type === 'done' || event.type === 'error')
  const terminalData = isRecord(terminalEvent?.data) ? terminalEvent.data : undefined
  const nextThreadId = readString(result?.threadId) ?? readString(terminalData?.threadId)
  const finalResponse = readString(result?.finalResponse)?.trim() ?? readString(terminalData?.finalResponse)?.trim()
  const errorMessage =
    run.error?.trim() || readString(result?.message)?.trim() || readString(terminalData?.message)?.trim()

  let nextThread: ExplainThreadState = {
    ...thread,
    activeRunId: undefined,
    threadId: nextThreadId ?? thread.threadId,
  }

  if (run.status === 'completed' && finalResponse) {
    nextThread = {
      ...nextThread,
      messages: updateLastAssistantMessage(thread.messages, () => finalResponse),
    }
  } else if (run.status === 'stopped') {
    nextThread = {
      ...nextThread,
      messages: updateLastAssistantMessage(thread.messages, (current) => {
        const base = finalResponse || current.trim() || '_응답이 중단되었습니다._'
        return base.includes('_응답이 중단되었습니다._') ? base : `${base}\n\n_응답이 중단되었습니다._`
      }),
    }
  } else if (run.status === 'failed' && errorMessage) {
    nextThread = {
      ...nextThread,
      messages: updateLastAssistantMessage(thread.messages, (current) =>
        current ? `${current}\n\n**Error**: ${errorMessage}` : `**Error**: ${errorMessage}`
      ),
    }
  }

  return nextThread
}

function reconcileExplainThreadWithBackgroundRun(
  session: AuthSession,
  projectId: string,
  thread: ExplainThreadState
) {
  const activeRunId = thread.activeRunId?.trim()
  if (!activeRunId) {
    return thread
  }

  const run = getBackgroundRun(session, activeRunId)
  if (!run) {
    return {
      ...thread,
      activeRunId: undefined,
    }
  }

  if (run.projectId !== projectId || run.scopeType !== 'explain_thread' || run.scopeId !== thread.id) {
    return {
      ...thread,
      activeRunId: undefined,
    }
  }

  if (!isTerminalBackgroundRun(run)) {
    return thread
  }

  if (run.kind === 'explain_reply') {
    return reconcileExplainReplyThread(thread, run)
  }

  return {
    ...thread,
    activeRunId: undefined,
  }
}

function reconcileExplainState(session: AuthSession, projectId: string, state: ExplainState) {
  let changed = false
  const threads = state.threads.map((thread) => {
    const nextThread = reconcileExplainThreadWithBackgroundRun(session, projectId, thread)
    if (nextThread !== thread) {
      changed = true
    }
    return nextThread
  })

  return changed
    ? {
        ...state,
        threads,
      }
    : state
}

export function normalizeExplainState(raw: unknown): ExplainState {
  if (!isRecord(raw)) {
    return createDefaultExplainState()
  }

  if (Array.isArray(raw.threads)) {
    const threads = sortThreads(
      raw.threads.map((entry, index) => normalizeThread(entry, index)).filter((entry): entry is ExplainThreadState => entry !== null)
    )
    const storedSelectedThreadId = readString(raw.selectedThreadId)
    const selectedThreadId =
      threads.length === 0
        ? ''
        : storedSelectedThreadId && threads.some((thread) => thread.id === storedSelectedThreadId)
          ? storedSelectedThreadId
          : threads[0]!.id

    return {
      selectedThreadId,
      textEffect: readString(raw.textEffect) || DEFAULT_TEXT_EFFECT,
      threads,
    }
  }

  const now = nowIso()
  const legacyThread: ExplainThreadState = {
    id: INITIAL_THREAD_ID,
    title: normalizeThreadTitle(raw.title),
    threadId: readString(raw.threadId),
    activeRunId: readString(raw.activeRunId),
    continuityMode: normalizeContinuityMode(raw.continuityMode),
    lastRecoveryAt: readString(raw.lastRecoveryAt),
    lastRecoveryReason: readString(raw.lastRecoveryReason),
    composerDraft: readString(raw.composerDraft) ?? '',
    messages: normalizeMessages(raw.messages),
    drafts: normalizeDrafts(raw.drafts),
    createdAt: now,
    sortUpdatedAt: readString(raw.sortUpdatedAt) ?? readString(raw.updatedAt) ?? now,
    updatedAt: now,
  }

  return {
    selectedThreadId: legacyThread.id,
    textEffect: DEFAULT_TEXT_EFFECT,
    threads: [legacyThread],
  }
}

export function resolveExplainOwnerId(session: AuthSession) {
  if (session.accountId) {
    return `account:${session.accountId}`
  }

  if (session.kind === 'shared_admin') {
    return 'shared_admin'
  }

  if (session.kind === 'open') {
    return 'open_access'
  }

  if (session.tokenId) {
    return `${session.kind}:${session.tokenId}`
  }

  return session.kind
}

function toPathSegment(value: string) {
  return encodeURIComponent(value)
}

function getExplainStatesDir() {
  return resolveRuntimeDataPath('explain')
}

function getExplainOwnerDir(session: AuthSession) {
  return resolve(getExplainStatesDir(), toPathSegment(resolveExplainOwnerId(session)))
}

function getExplainStatePath(session: AuthSession, projectId: string) {
  return resolve(getExplainOwnerDir(session), `${toPathSegment(projectId)}.json`)
}

function ensureExplainOwnerDir(session: AuthSession) {
  const explainStatesDir = getExplainStatesDir()
  if (!existsSync(explainStatesDir)) {
    mkdirSync(explainStatesDir, { recursive: true })
  }

  const ownerDir = getExplainOwnerDir(session)
  if (!existsSync(ownerDir)) {
    mkdirSync(ownerDir, { recursive: true })
  }
}

function toPersistedExplainState(projectId: string, ownerId: string, state: ExplainState): PersistedExplainState {
  return {
    version: 1,
    ownerId,
    projectId,
    ...state,
  }
}

export function loadExplainState(session: AuthSession, projectId: string): LoadExplainStateResult {
  const filepath = getExplainStatePath(session, projectId)
  if (!existsSync(filepath)) {
    return {
      state: reconcileExplainState(session, projectId, createDefaultExplainState()),
      persisted: false,
    }
  }

  try {
    const parsed: unknown = JSON.parse(readFileSync(filepath, 'utf-8'))
    return {
      state: reconcileExplainState(session, projectId, normalizeExplainState(parsed)),
      persisted: true,
    }
  } catch {
    return {
      state: reconcileExplainState(session, projectId, createDefaultExplainState()),
      persisted: false,
    }
  }
}

export function saveExplainState(session: AuthSession, projectId: string, raw: unknown): ExplainState {
  const state = reconcileExplainState(session, projectId, normalizeExplainState(raw))
  ensureExplainOwnerDir(session)
  const filepath = getExplainStatePath(session, projectId)
  const payload = toPersistedExplainState(projectId, resolveExplainOwnerId(session), state)
  writeFileSync(filepath, JSON.stringify(payload, null, 2), 'utf-8')
  return state
}
