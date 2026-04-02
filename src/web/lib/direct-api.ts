import { authorizedFetch } from './auth'
import { normalizeDirectState, type DirectState } from './direct-state'

interface DirectStateResponse {
  persisted: boolean
  state: DirectState
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

export async function fetchDirectState(projectId: string): Promise<DirectStateResponse> {
  const res = await authorizedFetch(`/api/direct/state?projectId=${encodeURIComponent(projectId)}`)
  const payload = await readJson<{
    persisted?: boolean
    state?: unknown
  }>(res)

  return {
    persisted: Boolean(payload.persisted),
    state: normalizeDirectState(payload.state),
  }
}

export async function saveDirectState(
  projectId: string,
  state: DirectState,
  options?: PersistStateRequestOptions
): Promise<DirectState> {
  const res = await authorizedFetch('/api/direct/state', {
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

  return normalizeDirectState(await readJson<unknown>(res))
}
