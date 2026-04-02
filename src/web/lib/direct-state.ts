import { normalizeStoredMessages, type ChatMessageRecord } from './chat-session'

export type DirectAgentRole = 'plain' | 'prometheus' | 'hephaestus' | 'sisyphus'

export const DEFAULT_DIRECT_AGENT_ROLE: DirectAgentRole = 'plain'
export type DirectContinuityMode = 'native' | 'rehydrated'

const DIRECT_AGENT_ROLE_SEQUENCE: Array<Exclude<DirectAgentRole, 'plain'>> = ['sisyphus', 'hephaestus', 'prometheus']

const DIRECT_AGENT_ROLE_DETAILS: Record<
  DirectAgentRole,
  {
    role: DirectAgentRole
    label: string
    badge: string
    description: string
  }
> = {
  plain: {
    role: 'plain',
    label: 'Plain',
    badge: 'Default Mode',
    description: '별도 specialist 없이 기본 Codex 흐름으로 바로 작업을 진행하는 기본 모드입니다.',
  },
  sisyphus: {
    role: 'sisyphus',
    label: 'Sisyphus',
    badge: 'Main Orchestrator',
    description: 'Prometheus와 Hephaestus를 병렬로 조율해 다음 최선의 실행 방향을 정리하는 총괄 역할입니다.',
  },
  hephaestus: {
    role: 'hephaestus',
    label: 'Hephaestus',
    badge: 'Deep Worker',
    description: '문제를 깊게 파고들어 분석하거나 구현을 끝까지 밀어붙이는 자율 실행 역할입니다.',
  },
  prometheus: {
    role: 'prometheus',
    label: 'Prometheus',
    badge: 'Strategic Planner',
    description: '범위와 모호함을 정리하고 실행 가능한 상세 계획을 만드는 전략 플래너입니다.',
  },
}

export const DIRECT_AGENT_ROLE_TABS = DIRECT_AGENT_ROLE_SEQUENCE.map((role) => DIRECT_AGENT_ROLE_DETAILS[role])

export function getDirectAgentDescriptor(role: DirectAgentRole) {
  return DIRECT_AGENT_ROLE_DETAILS[role]
}

export interface DirectSessionState {
  id: string
  agentRole: DirectAgentRole
  title?: string
  threadId?: string
  activeRunId?: string
  continuityMode: DirectContinuityMode
  lastRecoveryAt?: string
  lastRecoveryReason?: string
  messages: ChatMessageRecord[]
  createdAt: string
  updatedAt: string
}

export interface DirectState {
  selectedSessionId: string
  sessions: DirectSessionState[]
}

export interface DirectSessionSummary {
  id: string
  agentRole: DirectAgentRole
  title?: string
  label: string
  preview: string
  continuityMode: DirectContinuityMode
  updatedAt: string
}

export interface DirectSessionOverview {
  selectedSessionId: string
  sessions: DirectSessionSummary[]
}

const DEFAULT_SESSION_LABEL = 'New session'
const SESSION_LABEL_LIMIT = 48
const SESSION_PREVIEW_LIMIT = 80
const INITIAL_SESSION_ID = 'session-initial'

function createSessionKey() {
  return `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function normalizeText(value: string, limit: number) {
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (!normalized) {
    return ''
  }

  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized
}

function sortSessions(sessions: DirectSessionState[]) {
  return [...sessions].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
}

function createInitialSession(now = new Date().toISOString()): DirectSessionState {
  return {
    id: INITIAL_SESSION_ID,
    agentRole: DEFAULT_DIRECT_AGENT_ROLE,
    continuityMode: 'native',
    messages: [],
    createdAt: now,
    updatedAt: now,
  }
}

export function createEmptyDirectSession(now = new Date().toISOString()): DirectSessionState {
  return {
    id: createSessionKey(),
    agentRole: DEFAULT_DIRECT_AGENT_ROLE,
    continuityMode: 'native',
    messages: [],
    createdAt: now,
    updatedAt: now,
  }
}

export function createDefaultDirectState(now = new Date().toISOString()): DirectState {
  const session = createInitialSession(now)
  return {
    selectedSessionId: session.id,
    sessions: [session],
  }
}

function getSessionLabel(messages: ChatMessageRecord[]) {
  const firstUserMessage = messages.find((message) => message.role === 'user' && message.content.trim())
  return firstUserMessage ? normalizeText(firstUserMessage.content, SESSION_LABEL_LIMIT) : DEFAULT_SESSION_LABEL
}

function getSessionPreview(messages: ChatMessageRecord[]) {
  const latestMessage = [...messages].reverse().find((message) => message.content.trim())
  return latestMessage ? normalizeText(latestMessage.content, SESSION_PREVIEW_LIMIT) : DEFAULT_SESSION_LABEL
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
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

function normalizeDirectAgentRole(value: unknown): DirectAgentRole {
  if (value === 'plain' || value === 'prometheus' || value === 'hephaestus' || value === 'sisyphus') {
    return value
  }

  if (value === 'atlas') {
    return 'plain'
  }

  return DEFAULT_DIRECT_AGENT_ROLE
}

function normalizeSession(entry: unknown, index: number): DirectSessionState | null {
  if (!isRecord(entry)) {
    return null
  }

  const now = new Date().toISOString()

  return {
    id: readString(entry.id) ?? (index === 0 ? INITIAL_SESSION_ID : createSessionKey()),
    agentRole: normalizeDirectAgentRole(entry.agentRole),
    title: normalizeSessionTitle(entry.title),
    threadId: readString(entry.threadId),
    activeRunId: readString(entry.activeRunId),
    continuityMode: normalizeContinuityMode(entry.continuityMode),
    lastRecoveryAt: readString(entry.lastRecoveryAt),
    lastRecoveryReason: readString(entry.lastRecoveryReason),
    messages: normalizeStoredMessages(entry.messages),
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

  const now = new Date().toISOString()
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
    messages: normalizeStoredMessages(raw.messages),
    createdAt: updatedAt,
    updatedAt,
  }

  return {
    selectedSessionId: legacySession.id,
    sessions: [legacySession],
  }
}

export function toDirectSessionOverview(state: DirectState): DirectSessionOverview {
  return {
    selectedSessionId:
      state.selectedSessionId && state.sessions.some((session) => session.id === state.selectedSessionId)
        ? state.selectedSessionId
        : '',
    sessions: state.sessions.map((session) => ({
      id: session.id,
      agentRole: session.agentRole,
      title: session.title,
      label: session.title ? normalizeText(session.title, SESSION_LABEL_LIMIT) : getSessionLabel(session.messages),
      preview: getSessionPreview(session.messages),
      continuityMode: session.continuityMode,
      updatedAt: session.updatedAt,
    })),
  }
}

export function getAdjacentDirectAgentRoles(role: DirectAgentRole): {
  previous: DirectAgentRole
  next: DirectAgentRole
} {
  if (role === 'plain') {
    return {
      previous: 'prometheus' as const,
      next: 'sisyphus' as const,
    }
  }

  const index = DIRECT_AGENT_ROLE_SEQUENCE.indexOf(role)

  return {
    previous: index <= 0 ? 'plain' : DIRECT_AGENT_ROLE_SEQUENCE[index - 1]!,
    next: index < 0 || index >= DIRECT_AGENT_ROLE_SEQUENCE.length - 1 ? 'plain' : DIRECT_AGENT_ROLE_SEQUENCE[index + 1]!,
  }
}

export function cycleDirectAgentRole(role: DirectAgentRole, direction: 'forward' | 'backward') {
  return getCycledDirectAgentRole(role, direction)
}

export function getCycledDirectAgentRole(role: DirectAgentRole, direction: 'forward' | 'backward'): DirectAgentRole {
  if (role === 'plain') {
    return direction === 'forward' ? 'sisyphus' : 'prometheus'
  }

  const index = DIRECT_AGENT_ROLE_SEQUENCE.indexOf(role)
  if (index < 0) {
    return DEFAULT_DIRECT_AGENT_ROLE
  }

  if (direction === 'backward') {
    return index === 0 ? 'plain' : DIRECT_AGENT_ROLE_SEQUENCE[index - 1]!
  }

  return index === DIRECT_AGENT_ROLE_SEQUENCE.length - 1 ? 'plain' : DIRECT_AGENT_ROLE_SEQUENCE[index + 1]!
}

export function selectDirectSessionState(state: DirectState, selectedSessionId: string): DirectState {
  if (state.sessions.length === 0) {
    if (!state.selectedSessionId) {
      return state
    }

    return {
      ...state,
      selectedSessionId: '',
    }
  }

  const nextSelectedSessionId =
    selectedSessionId && state.sessions.some((session) => session.id === selectedSessionId)
      ? selectedSessionId
      : state.sessions[0]!.id

  if (nextSelectedSessionId === state.selectedSessionId) {
    return state
  }

  return {
    ...state,
    selectedSessionId: nextSelectedSessionId,
  }
}

export function createDirectSessionState(state: DirectState): DirectState {
  const nextSession = createEmptyDirectSession()
  return {
    selectedSessionId: nextSession.id,
    sessions: sortSessions([nextSession, ...state.sessions]),
  }
}

export function deleteDirectSessionState(state: DirectState, sessionKey: string): DirectState {
  const remainingSessions = sortSessions(state.sessions.filter((session) => session.id !== sessionKey))

  if (remainingSessions.length === state.sessions.length) {
    return state
  }

  if (remainingSessions.length === 0) {
    return {
      selectedSessionId: '',
      sessions: [],
    }
  }

  const nextSelectedSessionId =
    state.selectedSessionId === sessionKey || !remainingSessions.some((session) => session.id === state.selectedSessionId)
      ? remainingSessions[0]!.id
      : state.selectedSessionId

  return {
    selectedSessionId: nextSelectedSessionId,
    sessions: remainingSessions,
  }
}

export function updateDirectSessionState(
  state: DirectState,
  sessionKey: string,
  updater: (session: DirectSessionState) => DirectSessionState
): DirectState {
  let didUpdate = false
  const nextSessions = sortSessions(
    state.sessions.map((session) => {
      if (session.id !== sessionKey) {
        return session
      }

      didUpdate = true
      return updater(session)
    })
  )

  if (!didUpdate) {
    return state
  }

  return {
    selectedSessionId: state.selectedSessionId,
    sessions: nextSessions,
  }
}

export function renameDirectSessionState(state: DirectState, sessionKey: string, title: string): DirectState {
  const normalizedTitle = title.trim()
  return updateDirectSessionState(state, sessionKey, (session) => {
    if ((session.title ?? '') === normalizedTitle) {
      return session
    }

    const now = new Date().toISOString()
    return {
      ...session,
      title: normalizedTitle || undefined,
      updatedAt: now,
    }
  })
}
