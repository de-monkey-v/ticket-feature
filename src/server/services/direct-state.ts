import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AuthSession } from '../lib/access-policy.js'
import { resolveRuntimeDataRoot } from '../lib/runtime-data-paths.js'

export interface DirectMessageRecord {
  id: string
  role: 'user' | 'assistant'
  content: string
}

export type DirectAgentRole = 'plain' | 'prometheus' | 'hephaestus' | 'sisyphus'

export const DEFAULT_DIRECT_AGENT_ROLE: DirectAgentRole = 'plain'

export type DirectContinuityMode = 'native' | 'rehydrated'

export interface DirectSessionState {
  id: string
  agentRole: DirectAgentRole
  title?: string
  threadId?: string
  activeRunId?: string
  continuityMode: DirectContinuityMode
  lastRecoveryAt?: string
  lastRecoveryReason?: string
  messages: DirectMessageRecord[]
  createdAt: string
  updatedAt: string
}

export interface DirectState {
  selectedSessionId: string
  sessions: DirectSessionState[]
}

interface PersistedDirectState {
  version: 1
  ownerId: string
  projectId: string
  state: DirectState
}

export interface LoadDirectStateResult {
  state: DirectState
  persisted: boolean
}

const INITIAL_SESSION_ID = 'session-initial'

function nowIso() {
  return new Date().toISOString()
}

function createSessionKey() {
  return `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function readString(value: unknown) {
  return typeof value === 'string' ? value : undefined
}

function normalizeSessionTitle(value: unknown) {
  const title = readString(value)?.trim()
  return title ? title : undefined
}

function normalizeContinuityMode(value: unknown): DirectContinuityMode {
  return value === 'rehydrated' ? 'rehydrated' : 'native'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isMessageRole(value: unknown): value is DirectMessageRecord['role'] {
  return value === 'user' || value === 'assistant'
}

function normalizeDirectAgentRole(value: unknown): DirectAgentRole {
  if (value === 'plain' || value === 'prometheus' || value === 'hephaestus' || value === 'sisyphus') {
    return value
  }

  if (value === 'atlas') {
    return 'plain'
  }

  return DEFAULT_DIRECT_AGENT_ROLE
}

function normalizeMessages(value: unknown): DirectMessageRecord[] {
  if (!Array.isArray(value)) {
    return []
  }

  return value.flatMap((entry) => {
    if (!isRecord(entry)) {
      return []
    }

    const id = readString(entry.id)
    const role = entry.role
    const content = readString(entry.content)

    if (!id || !isMessageRole(role) || content === undefined) {
      return []
    }

    return [{ id, role, content }]
  })
}

function sortSessions(sessions: DirectSessionState[]) {
  return [...sessions].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
}

function createDefaultSession(now = nowIso()): DirectSessionState {
  return {
    id: INITIAL_SESSION_ID,
    agentRole: DEFAULT_DIRECT_AGENT_ROLE,
    continuityMode: 'native',
    messages: [],
    createdAt: now,
    updatedAt: now,
  }
}

export function createDefaultDirectState(now = nowIso()): DirectState {
  const session = createDefaultSession(now)
  return {
    selectedSessionId: session.id,
    sessions: [session],
  }
}

function normalizeSession(entry: unknown, index: number): DirectSessionState | null {
  if (!isRecord(entry)) {
    return null
  }

  const now = nowIso()

  return {
    id: readString(entry.id) ?? (index === 0 ? INITIAL_SESSION_ID : createSessionKey()),
    agentRole: normalizeDirectAgentRole(entry.agentRole),
    title: normalizeSessionTitle(entry.title),
    threadId: readString(entry.threadId),
    activeRunId: readString(entry.activeRunId),
    continuityMode: normalizeContinuityMode(entry.continuityMode),
    lastRecoveryAt: readString(entry.lastRecoveryAt),
    lastRecoveryReason: readString(entry.lastRecoveryReason),
    messages: normalizeMessages(entry.messages),
    createdAt: readString(entry.createdAt) ?? now,
    updatedAt: readString(entry.updatedAt) ?? now,
  }
}

export function normalizeDirectState(raw: unknown): DirectState {
  if (typeof raw === 'string') {
    try {
      return normalizeDirectState(JSON.parse(raw))
    } catch {
      return createDefaultDirectState()
    }
  }

  if (!isRecord(raw)) {
    return createDefaultDirectState()
  }

  if (Array.isArray(raw.sessions)) {
    const fallbackRole = normalizeDirectAgentRole(raw.selectedAgentRole)
    const sessions = sortSessions(
      raw.sessions
        .map((entry, index) => {
          const normalized = normalizeSession(entry, index)
          if (!normalized) {
            return null
          }

          return isRecord(entry) && entry.agentRole === undefined
            ? {
                ...normalized,
                agentRole: fallbackRole,
              }
            : normalized
        })
        .filter((entry): entry is DirectSessionState => entry !== null)
    )
    const storedSelectedSessionId = readString(raw.selectedSessionId)
    const selectedSessionId =
      sessions.length === 0
        ? ''
        : storedSelectedSessionId && sessions.some((session) => session.id === storedSelectedSessionId)
          ? storedSelectedSessionId
          : sessions[0]!.id

    return {
      selectedSessionId,
      sessions,
    }
  }

  const now = nowIso()
  const updatedAt = readString(raw.updatedAt) ?? now
  const legacySession: DirectSessionState = {
    id: INITIAL_SESSION_ID,
    agentRole: normalizeDirectAgentRole(raw.selectedAgentRole),
    title: normalizeSessionTitle(raw.title),
    threadId: readString(raw.threadId),
    activeRunId: readString(raw.activeRunId),
    continuityMode: normalizeContinuityMode(raw.continuityMode),
    lastRecoveryAt: readString(raw.lastRecoveryAt),
    lastRecoveryReason: readString(raw.lastRecoveryReason),
    messages: normalizeMessages(raw.messages),
    createdAt: updatedAt,
    updatedAt,
  }

  return {
    selectedSessionId: legacySession.id,
    sessions: [legacySession],
  }
}

function resolveDirectOwnerId(session: AuthSession) {
  return session.accountId ?? session.tokenId ?? session.kind
}

function toPathSegment(value: string) {
  const trimmed = value.trim()
  return trimmed.replace(/[^a-zA-Z0-9._-]+/g, '-') || 'anonymous'
}

function getDirectStatesDir() {
  return join(resolveRuntimeDataRoot(), 'direct-sessions')
}

function getDirectOwnerDir(session: AuthSession) {
  return join(getDirectStatesDir(), toPathSegment(resolveDirectOwnerId(session)))
}

function ensureDirectOwnerDir(session: AuthSession) {
  mkdirSync(getDirectOwnerDir(session), { recursive: true })
}

function getDirectStatePath(session: AuthSession, projectId: string) {
  return join(getDirectOwnerDir(session), `${toPathSegment(projectId)}.json`)
}

function toPersistedDirectState(projectId: string, ownerId: string, state: DirectState): PersistedDirectState {
  return {
    version: 1,
    ownerId,
    projectId,
    state,
  }
}

export function loadDirectState(session: AuthSession, projectId: string): LoadDirectStateResult {
  const filepath = getDirectStatePath(session, projectId)
  if (!existsSync(filepath)) {
    return {
      state: createDefaultDirectState(),
      persisted: false,
    }
  }

  try {
    const parsed: unknown = JSON.parse(readFileSync(filepath, 'utf-8'))
    const persistedState = isRecord(parsed) && 'state' in parsed ? parsed.state : parsed
    return {
      state: normalizeDirectState(persistedState),
      persisted: true,
    }
  } catch {
    return {
      state: createDefaultDirectState(),
      persisted: false,
    }
  }
}

export function saveDirectState(session: AuthSession, projectId: string, raw: unknown): DirectState {
  const state = normalizeDirectState(raw)
  ensureDirectOwnerDir(session)
  const filepath = getDirectStatePath(session, projectId)
  const payload = toPersistedDirectState(projectId, resolveDirectOwnerId(session), state)
  writeFileSync(filepath, JSON.stringify(payload, null, 2), 'utf-8')
  return state
}
