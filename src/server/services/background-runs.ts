import { nanoid } from 'nanoid'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { AuthSession, AccessPermission } from '../lib/access-policy.js'
import { resolveRuntimeDataPath } from '../lib/runtime-data-paths.js'

export type BackgroundRunKind =
  | 'explain_reply'
  | 'direct_reply'
  | 'explain_request_draft'
  | 'manual_request_draft'

export type BackgroundRunStatus = 'queued' | 'running' | 'stopping' | 'completed' | 'stopped' | 'failed'
export type BackgroundRunScopeType = 'explain_thread' | 'direct_session' | 'request_compose'

export interface BackgroundRunRecord {
  id: string
  version: 1
  ownerId: string
  projectId: string
  kind: BackgroundRunKind
  permission: AccessPermission
  scopeType: BackgroundRunScopeType
  scopeId: string
  scopeLabel: string
  messagePreview: string
  status: BackgroundRunStatus
  latestLabel?: string
  latestDetail?: string
  error?: string
  result?: unknown
  createdAt: string
  startedAt: string
  updatedAt: string
  completedAt?: string
  stoppedAt?: string
}

export interface BackgroundRunSummary {
  id: string
  kind: BackgroundRunKind
  permission: AccessPermission
  projectId: string
  scopeType: BackgroundRunScopeType
  scopeId: string
  scopeLabel: string
  messagePreview: string
  status: BackgroundRunStatus
  latestLabel?: string
  latestDetail?: string
  error?: string
  result?: unknown
  createdAt: string
  startedAt: string
  updatedAt: string
  completedAt?: string
  stoppedAt?: string
}

export interface PersistedBackgroundRunEvent {
  type: 'init' | 'state' | 'delta' | 'tool_use' | 'tool_result' | 'done' | 'error'
  data: Record<string, unknown>
  createdAt: string
}

export interface QueueBackgroundRunOptions {
  projectId: string
  kind: BackgroundRunKind
  permission: AccessPermission
  scopeType: BackgroundRunScopeType
  scopeId: string
  scopeLabel: string
  messagePreview: string
}

export interface QueueBackgroundRunResult {
  run: BackgroundRunSummary
  existing: boolean
}

interface ActiveBackgroundRun {
  controller: AbortController
  promise: Promise<void>
}

interface BackgroundRunExecutionContext {
  runId: string
  signal: AbortSignal
  updateRun: (patch: Partial<BackgroundRunRecord>) => BackgroundRunRecord | undefined
  emitEvent: (event: PersistedBackgroundRunEvent) => void
  emitState: (label: string, detail?: string) => void
  complete: (data?: Record<string, unknown>, patch?: Partial<BackgroundRunRecord>) => BackgroundRunRecord | undefined
  stop: (data?: Record<string, unknown>, patch?: Partial<BackgroundRunRecord>) => BackgroundRunRecord | undefined
  fail: (message: string, data?: Record<string, unknown>, patch?: Partial<BackgroundRunRecord>) => BackgroundRunRecord | undefined
}

type BackgroundRunExecutor = (context: BackgroundRunExecutionContext) => Promise<void>

const backgroundRuns = new Map<string, BackgroundRunRecord>()
const listeners = new Map<string, Set<(event: PersistedBackgroundRunEvent) => void>>()
const activeRuns = new Map<string, ActiveBackgroundRun>()
const activeScopeRuns = new Map<string, string>()

function nowIso() {
  return new Date().toISOString()
}

function normalizeSingleLine(value: string | undefined, fallback = '') {
  return (value ?? '').replace(/\s+/g, ' ').trim() || fallback
}

function resolveBackgroundRunOwnerId(session: AuthSession) {
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

function getBackgroundRunsDir() {
  return resolveRuntimeDataPath('background-runs')
}

function getOwnerDir(ownerId: string) {
  return resolve(getBackgroundRunsDir(), toPathSegment(ownerId))
}

function getProjectDir(ownerId: string, projectId: string) {
  return resolve(getOwnerDir(ownerId), toPathSegment(projectId))
}

function getRunPath(ownerId: string, projectId: string, runId: string) {
  return resolve(getProjectDir(ownerId, projectId), `${runId}.json`)
}

function getJournalPath(ownerId: string, projectId: string, runId: string) {
  return resolve(getProjectDir(ownerId, projectId), `${runId}.events.ndjson`)
}

function ensureProjectDir(ownerId: string, projectId: string) {
  const projectDir = getProjectDir(ownerId, projectId)
  if (!existsSync(projectDir)) {
    mkdirSync(projectDir, { recursive: true })
  }
}

function createScopeKey(ownerId: string, projectId: string, scopeType: BackgroundRunScopeType, scopeId: string) {
  return `${ownerId}:${projectId}:${scopeType}:${scopeId}`
}

function saveBackgroundRun(run: BackgroundRunRecord) {
  ensureProjectDir(run.ownerId, run.projectId)
  writeFileSync(getRunPath(run.ownerId, run.projectId, run.id), JSON.stringify(run, null, 2), 'utf-8')
}

function toSummary(run: BackgroundRunRecord): BackgroundRunSummary {
  return {
    id: run.id,
    kind: run.kind,
    permission: run.permission,
    projectId: run.projectId,
    scopeType: run.scopeType,
    scopeId: run.scopeId,
    scopeLabel: run.scopeLabel,
    messagePreview: run.messagePreview,
    status: run.status,
    latestLabel: run.latestLabel,
    latestDetail: run.latestDetail,
    error: run.error,
    result: run.result,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    completedAt: run.completedAt,
    stoppedAt: run.stoppedAt,
  }
}

function isTerminalStatus(status: BackgroundRunStatus) {
  return status === 'completed' || status === 'stopped' || status === 'failed'
}

function rebuildActiveScopeIndex() {
  activeScopeRuns.clear()

  for (const run of backgroundRuns.values()) {
    if (run.status !== 'queued' && run.status !== 'running' && run.status !== 'stopping') {
      continue
    }

    activeScopeRuns.set(createScopeKey(run.ownerId, run.projectId, run.scopeType, run.scopeId), run.id)
  }
}

function updateRunRecord(runId: string, patch: Partial<BackgroundRunRecord>) {
  const current = backgroundRuns.get(runId)
  if (!current) {
    return undefined
  }

  const next: BackgroundRunRecord = {
    ...current,
    ...patch,
    updatedAt: patch.updatedAt ?? nowIso(),
  }
  backgroundRuns.set(runId, next)
  saveBackgroundRun(next)
  rebuildActiveScopeIndex()
  return next
}

function emitBackgroundRunEvent(runId: string, event: PersistedBackgroundRunEvent) {
  const run = backgroundRuns.get(runId)
  if (!run) {
    return
  }

  ensureProjectDir(run.ownerId, run.projectId)
  const journalPath = getJournalPath(run.ownerId, run.projectId, run.id)
  writeFileSync(journalPath, `${JSON.stringify(event)}\n`, {
    encoding: 'utf-8',
    flag: 'a',
  })

  const currentListeners = listeners.get(runId)
  if (!currentListeners) {
    return
  }

  for (const listener of currentListeners) {
    try {
      listener(event)
    } catch (error) {
      console.error(`Background run listener failed for ${runId}:`, error)
    }
  }
}

function finalizeRun(
  runId: string,
  status: Extract<BackgroundRunStatus, 'completed' | 'stopped' | 'failed'>,
  patch?: Partial<BackgroundRunRecord>
) {
  const now = nowIso()
  const nextPatch: Partial<BackgroundRunRecord> = {
    ...patch,
    status,
    updatedAt: now,
  }

  if (status === 'completed' || status === 'failed') {
    nextPatch.completedAt = patch?.completedAt ?? now
  }

  if (status === 'stopped') {
    nextPatch.stoppedAt = patch?.stoppedAt ?? now
  }

  return updateRunRecord(runId, nextPatch)
}

function createExecutionContext(runId: string, controller: AbortController): BackgroundRunExecutionContext {
  return {
    runId,
    signal: controller.signal,
    updateRun: (patch) => updateRunRecord(runId, patch),
    emitEvent: (event) => emitBackgroundRunEvent(runId, event),
    emitState: (label, detail) => {
      updateRunRecord(runId, {
        latestLabel: normalizeSingleLine(label),
        latestDetail: detail?.trim() || undefined,
      })
      emitBackgroundRunEvent(runId, {
        type: 'state',
        data: {
          label: normalizeSingleLine(label),
          detail: detail?.trim() || undefined,
        },
        createdAt: nowIso(),
      })
    },
    complete: (data, patch) => {
      const run = finalizeRun(runId, 'completed', patch)
      emitBackgroundRunEvent(runId, {
        type: 'done',
        data: {
          status: 'completed',
          ...(data ?? {}),
        },
        createdAt: nowIso(),
      })
      return run
    },
    stop: (data, patch) => {
      const run = finalizeRun(runId, 'stopped', patch)
      emitBackgroundRunEvent(runId, {
        type: 'done',
        data: {
          status: 'stopped',
          ...(data ?? {}),
        },
        createdAt: nowIso(),
      })
      return run
    },
    fail: (message, data, patch) => {
      const normalizedMessage = normalizeSingleLine(message, 'Background run failed')
      const run = finalizeRun(runId, 'failed', {
        ...patch,
        error: normalizedMessage,
      })
      emitBackgroundRunEvent(runId, {
        type: 'error',
        data: {
          message: normalizedMessage,
          ...(data ?? {}),
        },
        createdAt: nowIso(),
      })
      return run
    },
  }
}

async function executeBackgroundRun(runId: string, controller: AbortController, executor: BackgroundRunExecutor) {
  const context = createExecutionContext(runId, controller)

  try {
    await executor(context)
  } catch (error) {
    const current = backgroundRuns.get(runId)
    if (!current || isTerminalStatus(current.status)) {
      return
    }

    if (error instanceof Error && error.name === 'AbortError') {
      context.stop({
        message: 'Background run stopped',
      })
      return
    }

    context.fail(error instanceof Error ? error.message : 'Background run failed unexpectedly')
  } finally {
    activeRuns.delete(runId)
    rebuildActiveScopeIndex()
  }
}

function createBackgroundRun(ownerId: string, options: QueueBackgroundRunOptions): BackgroundRunRecord {
  const now = nowIso()
  return {
    id: `run-${nanoid(8)}`,
    version: 1,
    ownerId,
    projectId: options.projectId,
    kind: options.kind,
    permission: options.permission,
    scopeType: options.scopeType,
    scopeId: options.scopeId,
    scopeLabel: normalizeSingleLine(options.scopeLabel, options.scopeId),
    messagePreview: normalizeSingleLine(options.messagePreview, '(empty)'),
    status: 'running',
    createdAt: now,
    startedAt: now,
    updatedAt: now,
  }
}

function findActiveScopeRun(ownerId: string, projectId: string, scopeType: BackgroundRunScopeType, scopeId: string) {
  const runId = activeScopeRuns.get(createScopeKey(ownerId, projectId, scopeType, scopeId))
  return runId ? backgroundRuns.get(runId) : undefined
}

export function queueBackgroundRun(
  session: AuthSession,
  options: QueueBackgroundRunOptions,
  executor: BackgroundRunExecutor
): QueueBackgroundRunResult {
  const ownerId = resolveBackgroundRunOwnerId(session)
  const existing = findActiveScopeRun(ownerId, options.projectId, options.scopeType, options.scopeId)
  if (existing) {
    return {
      run: toSummary(existing),
      existing: true,
    }
  }

  const run = createBackgroundRun(ownerId, options)
  backgroundRuns.set(run.id, run)
  saveBackgroundRun(run)
  rebuildActiveScopeIndex()

  const controller = new AbortController()
  const promise = new Promise<void>((resolve, reject) => {
    queueMicrotask(() => {
      void executeBackgroundRun(run.id, controller, executor).then(resolve, reject)
    })
  })
  activeRuns.set(run.id, { controller, promise })

  emitBackgroundRunEvent(run.id, {
    type: 'init',
    data: {
      run: toSummary(run),
    },
    createdAt: nowIso(),
  })

  return {
    run: toSummary(run),
    existing: false,
  }
}

export function subscribeToBackgroundRunEvents(runId: string, listener: (event: PersistedBackgroundRunEvent) => void) {
  const current = listeners.get(runId) ?? new Set<(event: PersistedBackgroundRunEvent) => void>()
  current.add(listener)
  listeners.set(runId, current)

  return () => {
    const listenersForRun = listeners.get(runId)
    if (!listenersForRun) {
      return
    }

    listenersForRun.delete(listener)
    if (listenersForRun.size === 0) {
      listeners.delete(runId)
    }
  }
}

export function readBackgroundRunEventJournal(runId: string) {
  const run = backgroundRuns.get(runId)
  if (!run) {
    return [] as PersistedBackgroundRunEvent[]
  }

  const journalPath = getJournalPath(run.ownerId, run.projectId, run.id)
  if (!existsSync(journalPath)) {
    return [] as PersistedBackgroundRunEvent[]
  }

  return readFileSync(journalPath, 'utf-8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as PersistedBackgroundRunEvent)
}

export function listBackgroundRuns(session: AuthSession, projectId?: string) {
  const ownerId = resolveBackgroundRunOwnerId(session)

  return [...backgroundRuns.values()]
    .filter((run) => run.ownerId === ownerId)
    .filter((run) => !projectId || run.projectId === projectId)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .map(toSummary)
}

export function getBackgroundRun(session: AuthSession, runId: string) {
  const run = backgroundRuns.get(runId)
  if (!run) {
    return undefined
  }

  return run.ownerId === resolveBackgroundRunOwnerId(session) ? toSummary(run) : undefined
}

export function stopBackgroundRun(session: AuthSession, runId: string) {
  const run = backgroundRuns.get(runId)
  if (!run || run.ownerId !== resolveBackgroundRunOwnerId(session)) {
    throw new Error('Background run not found')
  }

  if (isTerminalStatus(run.status)) {
    throw new Error('Background run is not active')
  }

  updateRunRecord(runId, {
    status: 'stopping',
    latestLabel: '중단 요청 중',
    latestDetail: '백그라운드 작업을 안전하게 중단하고 있습니다.',
  })
  emitBackgroundRunEvent(runId, {
    type: 'state',
    data: {
      label: '중단 요청 중',
      detail: '백그라운드 작업을 안전하게 중단하고 있습니다.',
    },
    createdAt: nowIso(),
  })

  activeRuns.get(runId)?.controller.abort()
  return toSummary(backgroundRuns.get(runId)!)
}

function loadRunFromFile(filepath: string) {
  try {
    const parsed = JSON.parse(readFileSync(filepath, 'utf-8')) as BackgroundRunRecord
    if (!parsed || typeof parsed !== 'object' || typeof parsed.id !== 'string') {
      return undefined
    }

    return parsed
  } catch {
    return undefined
  }
}

export function reloadBackgroundRunsFromDisk() {
  backgroundRuns.clear()
  listeners.clear()
  activeRuns.clear()
  activeScopeRuns.clear()

  const runsDir = getBackgroundRunsDir()
  if (!existsSync(runsDir)) {
    return
  }

  for (const ownerEntry of readdirSync(runsDir, { withFileTypes: true })) {
    if (!ownerEntry.isDirectory()) {
      continue
    }

    const ownerDir = resolve(runsDir, ownerEntry.name)
    for (const projectEntry of readdirSync(ownerDir, { withFileTypes: true })) {
      if (!projectEntry.isDirectory()) {
        continue
      }

      const projectDir = resolve(ownerDir, projectEntry.name)
      for (const child of readdirSync(projectDir, { withFileTypes: true })) {
        if (!child.isFile() || !child.name.endsWith('.json')) {
          continue
        }

        const parsed = loadRunFromFile(resolve(projectDir, child.name))
        if (!parsed) {
          continue
        }

        backgroundRuns.set(parsed.id, parsed)
      }
    }
  }

  rebuildActiveScopeIndex()
}

export function markRecoverableBackgroundRunsFromStartup() {
  for (const run of backgroundRuns.values()) {
    if (isTerminalStatus(run.status)) {
      continue
    }

    finalizeRun(run.id, 'failed', {
      error: 'API server restarted before the background run completed.',
      latestLabel: '실행이 중단되었습니다',
      latestDetail: '서버가 재시작되어 백그라운드 작업을 복구하지 못했습니다.',
    })
    emitBackgroundRunEvent(run.id, {
      type: 'error',
      data: {
        message: 'API server restarted before the background run completed.',
        code: 'BACKGROUND_RUN_RECOVERY_FAILED',
      },
      createdAt: nowIso(),
    })
  }
}
