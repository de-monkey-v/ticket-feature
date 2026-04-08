import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { AuthSession } from './access-policy.js'
import type { ReasoningEffort } from './config.js'
import { getModelCapability, resolveReasoningEffortForModel } from './model-capabilities.js'
import { resolveRuntimeDataPath } from './runtime-data-paths.js'

export type ChatInitialScrollTarget = 'bottom' | 'last_user_message'

export interface UserChatPreferences {
  initialScrollTarget?: ChatInitialScrollTarget
}

export interface UserModelPreferences {
  model?: string
  reasoningEffort?: ReasoningEffort
}

export interface UserExplainPreferences extends UserModelPreferences {
  interceptImplementationRequests?: boolean
}

export interface UserPreferences {
  chat: UserChatPreferences | null
  explain: UserExplainPreferences | null
  direct: UserModelPreferences | null
}

interface PersistedUserPreferences extends UserPreferences {
  version: 1
  ownerId: string
}

function createDefaultUserPreferences(): UserPreferences {
  return {
    chat: null,
    explain: null,
    direct: null,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readString(value: unknown) {
  return typeof value === 'string' ? value : undefined
}

function readBoolean(value: unknown) {
  return typeof value === 'boolean' ? value : undefined
}

function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return (
    value === 'none' ||
    value === 'minimal' ||
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'xhigh'
  )
}

function normalizeChatInitialScrollTarget(value: unknown): ChatInitialScrollTarget | undefined {
  return value === 'last_user_message' ? 'last_user_message' : value === 'bottom' ? 'bottom' : undefined
}

function normalizeUserChatPreferences(value: unknown): UserChatPreferences | null {
  if (!isRecord(value)) {
    return null
  }

  const initialScrollTarget = normalizeChatInitialScrollTarget(value.initialScrollTarget)
  return initialScrollTarget ? { initialScrollTarget } : null
}

function normalizeUserExplainPreferences(value: unknown): UserExplainPreferences | null {
  if (!isRecord(value)) {
    return null
  }

  const model = readString(value.model)?.trim()
  const reasoningEffort = isReasoningEffort(value.reasoningEffort) ? value.reasoningEffort : undefined
  const interceptImplementationRequests = readBoolean(value.interceptImplementationRequests)

  if (!model && !reasoningEffort && interceptImplementationRequests === undefined) {
    return null
  }

  return {
    model: model ? getModelCapability(model).id : undefined,
    reasoningEffort,
    interceptImplementationRequests,
  }
}

function normalizeUserModelPreferences(value: unknown): UserModelPreferences | null {
  if (!isRecord(value)) {
    return null
  }

  const model = readString(value.model)?.trim()
  const reasoningEffort = isReasoningEffort(value.reasoningEffort) ? value.reasoningEffort : undefined

  if (!model && !reasoningEffort) {
    return null
  }

  return {
    model: model ? getModelCapability(model).id : undefined,
    reasoningEffort,
  }
}

export function resolveUserPreferenceOwnerId(session: AuthSession) {
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

function getUserPreferencesPath(session: AuthSession) {
  return resolveRuntimeDataPath('user-preferences', `${encodeURIComponent(resolveUserPreferenceOwnerId(session))}.json`)
}

function normalizeUserPreferences(raw: unknown): UserPreferences {
  if (!isRecord(raw)) {
    return createDefaultUserPreferences()
  }

  return {
    chat: normalizeUserChatPreferences(raw.chat),
    explain: normalizeUserExplainPreferences(raw.explain),
    direct: normalizeUserModelPreferences(raw.direct),
  }
}

function saveUserPreferences(session: AuthSession, preferences: UserPreferences) {
  const filepath = getUserPreferencesPath(session)
  const payload: PersistedUserPreferences = {
    version: 1,
    ownerId: resolveUserPreferenceOwnerId(session),
    chat: preferences.chat,
    explain: preferences.explain,
    direct: preferences.direct,
  }

  mkdirSync(dirname(filepath), { recursive: true })
  writeFileSync(filepath, JSON.stringify(payload, null, 2), 'utf-8')
}

export function loadUserPreferences(session: AuthSession): UserPreferences {
  const filepath = getUserPreferencesPath(session)

  if (!existsSync(filepath)) {
    return createDefaultUserPreferences()
  }

  try {
    const raw = JSON.parse(readFileSync(filepath, 'utf-8')) as unknown
    return normalizeUserPreferences(raw)
  } catch {
    return createDefaultUserPreferences()
  }
}

export function updateUserChatPreferences(session: AuthSession, initialScrollTarget: ChatInitialScrollTarget) {
  const preferences = loadUserPreferences(session)
  preferences.chat = {
    initialScrollTarget,
  }
  saveUserPreferences(session, preferences)
  return preferences.chat
}

function updateUserModelPreferences(
  session: AuthSession,
  key: 'direct',
  model: string,
  reasoningEffort: ReasoningEffort
) {
  const preferences = loadUserPreferences(session)
  const normalizedModel = getModelCapability(model).id
  preferences[key] = {
    model: normalizedModel,
    reasoningEffort: resolveReasoningEffortForModel(normalizedModel, reasoningEffort),
  }
  saveUserPreferences(session, preferences)
  return preferences[key]
}

export function updateUserExplainPreferences(
  session: AuthSession,
  model: string,
  reasoningEffort: ReasoningEffort,
  interceptImplementationRequests?: boolean
) {
  const preferences = loadUserPreferences(session)
  const normalizedModel = getModelCapability(model).id
  const existingInterceptImplementationRequests = preferences.explain?.interceptImplementationRequests

  preferences.explain = {
    model: normalizedModel,
    reasoningEffort: resolveReasoningEffortForModel(normalizedModel, reasoningEffort),
    ...((interceptImplementationRequests ?? existingInterceptImplementationRequests) === undefined
      ? {}
      : {
          interceptImplementationRequests:
            interceptImplementationRequests ?? existingInterceptImplementationRequests,
        }),
  }
  saveUserPreferences(session, preferences)
  return preferences.explain
}

export function updateUserDirectPreferences(session: AuthSession, model: string, reasoningEffort: ReasoningEffort) {
  return updateUserModelPreferences(session, 'direct', model, reasoningEffort)
}

export function resolveUserSelectedModelSettings(
  baseModel: string,
  baseReasoningEffort: ReasoningEffort | undefined,
  preferences: UserModelPreferences | null
) {
  const selectedModel = getModelCapability(preferences?.model ?? baseModel).id
  const selectedReasoningEffort = resolveReasoningEffortForModel(
    selectedModel,
    preferences?.reasoningEffort ?? baseReasoningEffort
  )

  return {
    selectedModel,
    selectedReasoningEffort,
  }
}
