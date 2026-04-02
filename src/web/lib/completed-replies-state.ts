export interface CompletedRepliesState {
  dismissedRunIds: string[]
}

const COMPLETED_REPLIES_STORAGE_PREFIX = 'intentlane-codex.completed-replies'

function normalizeDismissedRunIds(value: unknown) {
  if (!Array.isArray(value)) {
    return []
  }

  const seen = new Set<string>()
  const next: string[] = []

  for (const entry of value) {
    if (typeof entry !== 'string') {
      continue
    }

    const normalized = entry.trim()
    if (!normalized || seen.has(normalized)) {
      continue
    }

    seen.add(normalized)
    next.push(normalized)
  }

  return next
}

export function getCompletedRepliesStorageKey(scopeKey: string, projectId: string) {
  return `${COMPLETED_REPLIES_STORAGE_PREFIX}.${scopeKey}.${projectId}`
}

export function loadCompletedRepliesState(scopeKey: string, projectId: string): CompletedRepliesState {
  if (!scopeKey || !projectId || typeof globalThis.sessionStorage === 'undefined') {
    return {
      dismissedRunIds: [],
    }
  }

  try {
    const raw = globalThis.sessionStorage.getItem(getCompletedRepliesStorageKey(scopeKey, projectId))
    if (!raw) {
      return {
        dismissedRunIds: [],
      }
    }

    const parsed = JSON.parse(raw) as { dismissedRunIds?: unknown }
    return {
      dismissedRunIds: normalizeDismissedRunIds(parsed.dismissedRunIds),
    }
  } catch {
    return {
      dismissedRunIds: [],
    }
  }
}

export function saveCompletedRepliesState(scopeKey: string, projectId: string, state: CompletedRepliesState) {
  if (!scopeKey || !projectId || typeof globalThis.sessionStorage === 'undefined') {
    return
  }

  globalThis.sessionStorage.setItem(
    getCompletedRepliesStorageKey(scopeKey, projectId),
    JSON.stringify({
      dismissedRunIds: normalizeDismissedRunIds(state.dismissedRunIds),
    })
  )
}
