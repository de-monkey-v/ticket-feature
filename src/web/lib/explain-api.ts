import { authorizedFetch } from './auth'
import {
  clearLegacyExplainState,
  loadLegacyExplainState,
  normalizeExplainState,
  type ExplainState,
} from './explain-state'

export interface ExplainStateResponse {
  persisted: boolean
  state: ExplainState
}

interface PersistStateRequestOptions {
  keepalive?: boolean
}

async function readJson<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    const message =
      payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string'
        ? payload.error
        : `HTTP ${response.status}`
    throw new Error(message)
  }

  return payload as T
}

export async function fetchExplainState(projectId: string): Promise<ExplainStateResponse> {
  const res = await authorizedFetch(`/api/explain/state?projectId=${encodeURIComponent(projectId)}`)
  const payload = await readJson<{
    persisted?: boolean
    state?: unknown
  }>(res)

  return {
    persisted: Boolean(payload.persisted),
    state: normalizeExplainState(payload.state),
  }
}

export async function saveExplainState(
  projectId: string,
  state: ExplainState,
  options?: PersistStateRequestOptions
): Promise<ExplainState> {
  const res = await authorizedFetch('/api/explain/state', {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
    },
    keepalive: options?.keepalive,
    body: JSON.stringify({
      projectId,
      state,
    }),
  })

  const payload = await readJson<unknown>(res)
  return normalizeExplainState(payload)
}

export async function fetchOrMigrateExplainState(projectId: string): Promise<ExplainState> {
  const loaded = await fetchExplainState(projectId)
  if (loaded.persisted) {
    clearLegacyExplainState(projectId)
    return loaded.state
  }

  const legacyState = loadLegacyExplainState(projectId)
  if (!legacyState) {
    return loaded.state
  }

  const savedState = await saveExplainState(projectId, legacyState)
  clearLegacyExplainState(projectId)
  return savedState
}
