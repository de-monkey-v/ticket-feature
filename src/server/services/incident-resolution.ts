import { analyzeIncident } from './incident-analysis.js'
import {
  createTicketIncident,
  getIncident,
  listIncidents,
  setIncidentResolutionState,
  type Incident,
  type IncidentResolutionActionType,
  type IncidentTrigger,
} from './incidents.js'
import { applyTicketRetryPlan, enqueueTicketExecution } from './tickets.js'

type ResolutionStepId = 'analyze' | 'plan' | 'implement'

interface IncidentResolutionIntent {
  type: IncidentResolutionActionType
  startStepId?: ResolutionStepId | null
  rationale: string
}

const activeIncidentResolutions = new Set<string>()
const INCIDENT_RUNNER_ROLE = process.env.INTENTLANE_CODEX_RUNNER_ROLE?.trim() || 'in_process'
let incidentAutoResolutionEnabled = true

function shouldProcessIncidentResolutionsLocally() {
  return incidentAutoResolutionEnabled && INCIDENT_RUNNER_ROLE !== 'api'
}

function isResolutionStepId(value: string | null | undefined): value is ResolutionStepId {
  return value === 'analyze' || value === 'plan' || value === 'implement'
}

function stepLabel(stepId: ResolutionStepId) {
  if (stepId === 'analyze') return '분석'
  if (stepId === 'plan') return '계획'
  return '구현'
}

function buildFallbackIntent(incident: Incident): IncidentResolutionIntent {
  if (incident.analysis?.recommendedAction.type === 'rerun_from_step') {
    return {
      type: 'retry_ticket',
      startStepId: incident.analysis.recommendedAction.startStepId ?? null,
      rationale: incident.analysis.recommendedAction.rationale,
    }
  }

  return {
    type:
      incident.trigger.kind === 'verify_failed' || incident.trigger.kind === 'review_failed'
        ? 'needs_decision'
        : 'manual_intervention',
    startStepId: incident.analysis?.recommendedAction.startStepId ?? null,
    rationale: incident.analysis?.recommendedAction.rationale ?? '사람의 추가 판단이 필요합니다.',
  }
}

function resolveStartStepId(incident: Incident, preferredStepId?: string | null) {
  if (isResolutionStepId(preferredStepId)) {
    return preferredStepId
  }

  if (isResolutionStepId(incident.analysis?.recommendedAction.startStepId)) {
    return incident.analysis.recommendedAction.startStepId
  }

  if (isResolutionStepId(incident.trigger.phase)) {
    return incident.trigger.phase
  }

  if (incident.trigger.kind === 'analyze_failed') {
    return 'analyze'
  }

  if (incident.trigger.kind === 'verify_failed' || incident.trigger.kind === 'review_failed') {
    return 'implement'
  }

  return 'implement'
}

function normalizeResolutionIntent(incident: Incident): IncidentResolutionIntent {
  const baseIntent = incident.analysis?.resolution
    ? {
        type: incident.analysis.resolution.type,
        startStepId: incident.analysis.resolution.startStepId ?? null,
        rationale: incident.analysis.resolution.rationale,
      }
    : buildFallbackIntent(incident)

  if (incident.trigger.kind === 'verification_environment_failed') {
    return {
      type: 'manual_intervention',
      startStepId: null,
      rationale: '검증 환경 문제는 같은 티켓을 자동 재시도하기보다 환경을 먼저 복구해야 합니다.',
    }
  }

  if (incident.trigger.kind === 'runner_exception') {
    return {
      type: 'manual_intervention',
      startStepId: null,
      rationale: 'runner 예외는 동일한 자동 실행을 반복하기보다 로그와 실행 환경을 먼저 점검해야 합니다.',
    }
  }

  if (baseIntent.type === 'manual_intervention') {
    return {
      ...baseIntent,
      startStepId: null,
    }
  }

  if (baseIntent.type === 'retry_ticket') {
    return {
      type: 'retry_ticket',
      startStepId: resolveStartStepId(incident, baseIntent.startStepId),
      rationale: baseIntent.rationale,
    }
  }

  return {
    ...baseIntent,
    startStepId: resolveStartStepId(incident, baseIntent.startStepId),
  }
}

function buildResolutionMessage(intent: IncidentResolutionIntent) {
  if (intent.type === 'retry_ticket') {
    if (intent.startStepId) {
      return `${stepLabel(intent.startStepId)} 단계부터 자동 재시도를 시작했습니다.`
    }

    return '자동 재시도를 시작했습니다.'
  }

  if (intent.type === 'needs_request_clarification') {
    if (intent.startStepId) {
      return `ticket 상태는 바꾸지 않았습니다. 요구사항 보완 후 ${stepLabel(intent.startStepId)} 단계 재시작 여부를 검토하세요.`
    }

    return 'ticket 상태는 바꾸지 않았습니다. 요구사항 보완이 먼저 필요합니다.'
  }

  if (intent.type === 'needs_decision') {
    if (intent.startStepId) {
      return `자동 재시도는 수행하지 않았습니다. ${stepLabel(intent.startStepId)} 단계 재시작 여부를 사람이 결정해야 합니다.`
    }

    return '자동 재시도는 수행하지 않았습니다. 다음 조치를 사람이 결정해야 합니다.'
  }

  return '자동 재시도 없이 분석 결과만 기록했습니다. ticket 상태는 바꾸지 않았습니다.'
}

function restartTicketFromIncident(incident: Incident, intent: IncidentResolutionIntent) {
  const startStepId = resolveStartStepId(incident, intent.startStepId)
  const shouldCleanupWorktree = Boolean(
    incident.bundle.worktree && incident.bundle.worktree.status !== 'merged' && incident.bundle.worktree.status !== 'discarded'
  )
  const reset = applyTicketRetryPlan(incident.sourceId, {
    id: `incident-retry-${startStepId}`,
    label: `incident 자동 복구: ${startStepId}부터 새 run 시작`,
    startStepId,
    executionMode: 'new_run',
    sessionMode: 'new_thread',
    shouldCleanupWorktree,
  })

  if (!reset) {
    throw new Error('Ticket retry plan could not be applied for the incident resolution')
  }

  const queued = enqueueTicketExecution(incident.sourceId, reset.startStepId, intent.rationale)
  if (!queued) {
    throw new Error('Ticket could not be queued after incident retry reset')
  }
}

function completeIncidentResolution(incident: Incident, intent: IncidentResolutionIntent) {
  setIncidentResolutionState(incident.id, {
    status: 'completed',
    actionType: intent.type,
    startStepId: intent.type === 'manual_intervention' ? null : intent.startStepId ?? null,
    message: buildResolutionMessage(intent),
  })
}

async function runIncidentAutoResolution(incidentId: string) {
  const incident = getIncident(incidentId)
  if (!incident) {
    return undefined
  }

  setIncidentResolutionState(incidentId, {
    status: 'running',
    actionType: incident.analysis?.resolution?.type,
    startStepId: incident.analysis?.resolution?.startStepId ?? null,
    message: '인시던트 자동 분석 및 후속 조치를 실행 중입니다.',
  })

  let analyzedIncident = incident

  try {
    if (incident.status !== 'analyzed' || !incident.analysis) {
      analyzedIncident = await analyzeIncident(incidentId)
    }

    const latestIncident = getIncident(incidentId) ?? analyzedIncident
    if (!latestIncident.analysis) {
      throw new Error('Incident analysis missing after analysis step')
    }

    const intent = normalizeResolutionIntent(latestIncident)
    if (intent.type === 'retry_ticket') {
      restartTicketFromIncident(latestIncident, intent)
    }
    completeIncidentResolution(latestIncident, intent)
    return getIncident(incidentId)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Incident auto resolution failed'
    const failedIntent = analyzedIncident.analysis ? normalizeResolutionIntent(analyzedIncident) : undefined
    setIncidentResolutionState(incidentId, {
      status: 'failed',
      actionType: failedIntent?.type,
      startStepId: failedIntent?.startStepId ?? null,
      message,
    })
    throw error
  }
}

export function isIncidentResolutionActive(incidentId: string) {
  return activeIncidentResolutions.has(incidentId)
}

export async function resolveIncidentAutomatically(incidentId: string) {
  if (!activeIncidentResolutions.has(incidentId)) {
    activeIncidentResolutions.add(incidentId)
  }

  try {
    return await runIncidentAutoResolution(incidentId)
  } finally {
    activeIncidentResolutions.delete(incidentId)
  }
}

export function queueIncidentAutoResolution(incidentId: string) {
  const incident = getIncident(incidentId)
  if (!incident || !shouldProcessIncidentResolutionsLocally()) {
    return false
  }

  if (activeIncidentResolutions.has(incidentId)) {
    return false
  }

  if (incident.resolution?.status === 'completed' || incident.resolution?.status === 'skipped') {
    return false
  }

  activeIncidentResolutions.add(incidentId)
  setIncidentResolutionState(incidentId, {
    status: 'pending',
    actionType: incident.analysis?.resolution?.type,
    startStepId: incident.analysis?.resolution?.startStepId ?? null,
    message: '자동 분석 및 후속 조치를 대기열에 등록했습니다.',
  })

  queueMicrotask(() => {
    void runIncidentAutoResolution(incidentId)
      .catch((error) => {
        console.error(`Failed to resolve incident ${incidentId}:`, error)
      })
      .finally(() => {
        activeIncidentResolutions.delete(incidentId)
      })
  })

  return true
}

export function captureTicketIncidentWithAutoResolution(ticketId: string, trigger: IncidentTrigger) {
  const incident = createTicketIncident(ticketId, trigger)
  queueIncidentAutoResolution(incident.id)
  return incident
}

export function resumePendingIncidentAutoResolutions() {
  if (!shouldProcessIncidentResolutionsLocally()) {
    return 0
  }

  let queuedCount = 0

  for (const incident of listIncidents()) {
    if (incident.status === 'analyzing') {
      continue
    }

    if (queueIncidentAutoResolution(incident.id)) {
      queuedCount += 1
    }
  }

  return queuedCount
}

export function setIncidentAutoResolutionEnabledForTesting(enabled: boolean) {
  incidentAutoResolutionEnabled = enabled
}

export function resetIncidentAutoResolutionEnabledForTesting() {
  incidentAutoResolutionEnabled = true
}
