import type { BackgroundRunSummary } from './api'
import type { DirectState } from './direct-state'
import type { ExplainState } from './explain-state'

function isTerminalBackgroundRunStatus(status: BackgroundRunSummary['status']) {
  return status === 'completed' || status === 'stopped' || status === 'failed'
}

function hasTerminalTransition(
  run: BackgroundRunSummary,
  previousStatuses: Map<string, string>
) {
  const previousStatus = previousStatuses.get(run.id)
  return Boolean(previousStatus && previousStatus !== run.status && isTerminalBackgroundRunStatus(run.status))
}

function shouldRefreshExplainForRun(
  run: BackgroundRunSummary,
  previousStatuses: Map<string, string>,
  explainState: ExplainState | null
) {
  if (run.kind !== 'explain_reply' && run.kind !== 'explain_request_draft') {
    return false
  }

  if (!isTerminalBackgroundRunStatus(run.status)) {
    return false
  }

  if (hasTerminalTransition(run, previousStatuses)) {
    return true
  }

  const thread = explainState?.threads.find((entry) => entry.id === run.scopeId)
  return thread?.activeRunId === run.id
}

function shouldRefreshDirectForRun(
  run: BackgroundRunSummary,
  previousStatuses: Map<string, string>,
  directState: DirectState | null
) {
  if (run.kind !== 'direct_reply' || !isTerminalBackgroundRunStatus(run.status)) {
    return false
  }

  if (hasTerminalTransition(run, previousStatuses)) {
    return true
  }

  const session = directState?.sessions.find((entry) => entry.id === run.scopeId)
  return session?.activeRunId === run.id
}

export function evaluateBackgroundRunRefresh(params: {
  backgroundRuns: BackgroundRunSummary[]
  previousStatuses: Map<string, string>
  explainState: ExplainState | null
  directState: DirectState | null
}) {
  const nextStatuses = new Map<string, string>()
  let shouldRefreshExplain = false
  let shouldRefreshDirect = false

  for (const run of params.backgroundRuns) {
    nextStatuses.set(run.id, run.status)

    if (!shouldRefreshExplain && shouldRefreshExplainForRun(run, params.previousStatuses, params.explainState)) {
      shouldRefreshExplain = true
    }

    if (!shouldRefreshDirect && shouldRefreshDirectForRun(run, params.previousStatuses, params.directState)) {
      shouldRefreshDirect = true
    }
  }

  return {
    nextStatuses,
    shouldRefreshExplain,
    shouldRefreshDirect,
  }
}
