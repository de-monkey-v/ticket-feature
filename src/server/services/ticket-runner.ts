import {
  applyTicketRetryPlan,
  appendTicketClarification,
  appendTimelineEvent,
  clearTicketStopRequest,
  enqueueTicketExecution,
  emitTicketEvent,
  getTicket,
  getTicketRetryPlan,
  listTickets,
  markTicketStopped,
  prepareTicketForMergeValidation,
  readTicketControlState,
  reloadTicketsFromDisk,
  requestTicketStop,
  resumeTicketFromCurrentRun,
  setTicketMergeBlock,
  setTicketMergeContext,
  setTicketRepairLoop,
  setTicketRunState,
  type TicketQueuedExecution,
} from './tickets.js'
import {
  discardTicketWorktree,
  destroyTicketWorktree,
  preserveTargetWorktreeForMergeReconcile,
  prepareTicketWorktreeForMergeResolution,
  runAutomaticTicketWorkflow,
} from './ticket-orchestrator.js'
import { captureTicketIncidentWithAutoResolution } from './incident-resolution.js'

type StartStepId = 'analyze' | 'plan' | 'implement' | 'verify' | 'review'

const activeRuns = new Map<string, { controller: AbortController; promise: Promise<void> }>()
const RUNNER_ROLE = process.env.INTENTLANE_CODEX_RUNNER_ROLE?.trim() || 'in_process'
const WORKER_POLL_INTERVAL_MS = Number(process.env.INTENTLANE_CODEX_RUNNER_POLL_MS?.trim() || '500')

let runAutomaticTicketWorkflowImpl: typeof runAutomaticTicketWorkflow = runAutomaticTicketWorkflow
let workerLoopTimer: ReturnType<typeof setTimeout> | null = null
let workerLoopStopped = true

export function setRunAutomaticTicketWorkflowForTesting(fn: typeof runAutomaticTicketWorkflow) {
  runAutomaticTicketWorkflowImpl = fn
}

export function resetRunAutomaticTicketWorkflowForTesting() {
  runAutomaticTicketWorkflowImpl = runAutomaticTicketWorkflow
}

function shouldStartRunsLocally() {
  return RUNNER_ROLE !== 'api'
}

function forwardWorkflowEvent(ticketId: string) {
  return async (event: { type: 'step' | 'delta' | 'done'; data: Record<string, unknown> }) => {
    emitTicketEvent(ticketId, {
      type: event.type,
      data: event.data,
    })
  }
}

function captureRunnerIncidentSafely(ticketId: string, message: string) {
  if (!getTicket(ticketId)) {
    return
  }

  try {
    captureTicketIncidentWithAutoResolution(ticketId, {
      kind: 'runner_exception',
      message,
      phase: getTicket(ticketId)?.currentPhase ?? null,
      attempt: getTicket(ticketId)?.attemptCount,
    })
  } catch (error) {
    console.error(`Failed to capture runner incident for ${ticketId}:`, error)
  }
}

function createStopSignalWatcher(ticketId: string, controller: AbortController) {
  const timer = setInterval(() => {
    if (controller.signal.aborted) {
      return
    }

    const control = readTicketControlState(ticketId)
    if (control?.stopRequestedAt) {
      controller.abort()
    }
  }, WORKER_POLL_INTERVAL_MS)

  controller.signal.addEventListener(
    'abort',
    () => {
      clearInterval(timer)
    },
    { once: true }
  )

  return () => {
    clearInterval(timer)
  }
}

function finalizeStopIfRequested(ticketId: string) {
  const latestTicket = getTicket(ticketId)
  const control = readTicketControlState(ticketId)
  if (!latestTicket || !control?.stopRequestedAt) {
    return
  }

  if (latestTicket.runState !== 'queued' && latestTicket.runState !== 'running') {
    clearTicketStopRequest(ticketId)
    return
  }

  clearTicketStopRequest(ticketId)
  markTicketStopped(ticketId)
  appendTimelineEvent(ticketId, {
    type: 'system',
    title: '사용자 요청으로 자동 실행을 중단했습니다.',
    body: 'Retry를 눌러 마지막 안전 지점부터 다시 시작할 수 있습니다.',
  })
}

async function startRun(ticketId: string, startStepId: StartStepId, controller: AbortController, recoveryNotes?: string) {
  let aborted = false

  try {
    if (controller.signal.aborted) {
      aborted = true
      return
    }

    clearTicketStopRequest(ticketId)
    await runAutomaticTicketWorkflowImpl({
      ticketId,
      startStepId,
      recoveryNotes,
      signal: controller.signal,
      onEvent: forwardWorkflowEvent(ticketId),
    })
  } catch (error: any) {
    if (error.name === 'AbortError') {
      aborted = true
      return
    }

    setTicketRunState(ticketId, 'failed')
    appendTimelineEvent(ticketId, {
      type: 'system',
      title: '자동 실행 중 예기치 않은 오류가 발생했습니다.',
      body: error.message,
    })
    captureRunnerIncidentSafely(ticketId, error.message)
    emitTicketEvent(ticketId, {
      type: 'error',
      data: { message: error.message },
    })
  } finally {
    activeRuns.delete(ticketId)
    if (aborted) {
      finalizeStopIfRequested(ticketId)
    }
  }
}

function startLocalQueuedRun(ticketId: string, queuedExecution: TicketQueuedExecution) {
  if (activeRuns.has(ticketId)) {
    return false
  }

  const controller = new AbortController()
  const disposeStopWatcher = createStopSignalWatcher(ticketId, controller)
  const promise = new Promise<void>((resolve, reject) => {
    queueMicrotask(() => {
      void startRun(ticketId, queuedExecution.startStepId, controller, queuedExecution.recoveryNotes)
        .then(resolve, reject)
        .finally(disposeStopWatcher)
    })
  })

  activeRuns.set(ticketId, { controller, promise })
  return true
}

function collectQueuedTickets(ticketIds?: string[]) {
  if (!ticketIds || ticketIds.length === 0) {
    return listTickets()
  }

  return ticketIds
    .map((ticketId) => getTicket(ticketId))
    .filter((ticket): ticket is NonNullable<typeof ticket> => Boolean(ticket))
}

export async function processQueuedTicketRunsOnce(ticketIds?: string[]) {
  if (RUNNER_ROLE === 'worker') {
    reloadTicketsFromDisk()
  }

  for (const ticket of collectQueuedTickets(ticketIds)) {
    if (activeRuns.has(ticket.id)) {
      continue
    }

    if (ticket.runState === 'queued' && ticket.stopRequestedAt) {
      finalizeStopIfRequested(ticket.id)
      continue
    }

    if (ticket.runState !== 'queued' || !ticket.queuedExecution) {
      continue
    }

    startLocalQueuedRun(ticket.id, ticket.queuedExecution)
  }
}

export function startTicketWorkerLoop() {
  if (workerLoopTimer) {
    return () => stopTicketWorkerLoop()
  }

  workerLoopStopped = false

  const tick = async () => {
    if (workerLoopStopped) {
      return
    }

    try {
      await processQueuedTicketRunsOnce()
    } catch (error) {
      console.error('Ticket worker loop failed:', error)
    } finally {
      if (!workerLoopStopped) {
        workerLoopTimer = setTimeout(() => {
          void tick()
        }, WORKER_POLL_INTERVAL_MS)
      }
    }
  }

  void tick()
  return () => stopTicketWorkerLoop()
}

export function stopTicketWorkerLoop() {
  workerLoopStopped = true
  if (workerLoopTimer) {
    clearTimeout(workerLoopTimer)
    workerLoopTimer = null
  }
}

export function isTicketRunActive(ticketId: string) {
  return activeRuns.has(ticketId)
}

export function queueTicketRun(ticketId: string, startStepId: StartStepId = 'analyze', recoveryNotes?: string) {
  if (activeRuns.has(ticketId)) {
    return false
  }

  const queued = enqueueTicketExecution(ticketId, startStepId, recoveryNotes)
  if (!queued) {
    return false
  }

  if (shouldStartRunsLocally()) {
    queueMicrotask(() => {
      void processQueuedTicketRunsOnce([ticketId])
    })
  }

  return queued
}

export async function stopTicketRun(ticketId: string) {
  const ticket = getTicket(ticketId)
  if (!ticket) {
    throw new Error('Ticket not found')
  }

  const activeRun = activeRuns.get(ticketId)
  if (activeRun) {
    requestTicketStop(ticketId)
    activeRun.controller.abort()
    await activeRun.promise
    return
  }

  if (ticket.runState === 'queued') {
    requestTicketStop(ticketId)
    finalizeStopIfRequested(ticketId)
    return
  }

  if (ticket.runState === 'running') {
    requestTicketStop(ticketId)
    return
  }

  throw new Error('Ticket is not running')
}

export async function retryTicketRun(ticketId: string, optionId?: string, clarification?: string) {
  const ticket = getTicket(ticketId)
  if (!ticket) {
    throw new Error('Ticket not found')
  }

  if (activeRuns.has(ticketId)) {
    throw new Error('Ticket is already running')
  }

  if (ticket.status === 'awaiting_merge' || ticket.status === 'completed' || ticket.status === 'discarded') {
    throw new Error('Ticket cannot be retried in its current state')
  }

  const retryPlan = getTicketRetryPlan(ticketId, optionId)
  if (!retryPlan) {
    if (ticket.planningBlock?.options && ticket.planningBlock.options.length > 1 && !optionId) {
      throw new Error('Retry option must be selected')
    }

    throw new Error('Ticket is not retryable')
  }

  const normalizedClarification = clarification?.trim()
  if (ticket.status === 'needs_request_clarification' && !normalizedClarification) {
    throw new Error('Clarification text is required')
  }

  if (normalizedClarification) {
    appendTicketClarification(ticketId, normalizedClarification)
  }

  if (retryPlan.executionMode === 'new_run' && retryPlan.shouldCleanupWorktree) {
    await destroyTicketWorktree(ticketId)
  }

  const reset =
    retryPlan.executionMode === 'same_run'
      ? resumeTicketFromCurrentRun(ticketId, retryPlan)
      : applyTicketRetryPlan(ticketId, retryPlan)
  if (!reset) {
    throw new Error('Ticket is not retryable')
  }

  if (normalizedClarification && retryPlan.executionMode === 'new_run') {
    appendTimelineEvent(ticketId, {
      type: 'system',
      title: '사용자 보완 답변이 추가되었습니다.',
      body: normalizedClarification,
    })
  }

  appendTimelineEvent(ticketId, {
    type: 'system',
    title: 'Retry 요청으로 실행 상태를 초기화했습니다.',
    body:
      reset.executionMode === 'same_run'
        ? `${reset.startStepId} 단계부터 같은 run과 세션을 유지한 채 다시 시작합니다.`
        : `${reset.startStepId} 단계부터 새 run으로 다시 시작합니다. worktree 정리 ${retryPlan.shouldCleanupWorktree ? '수행 후' : '없이'} 재개합니다.`,
  })

  queueTicketRun(ticketId, reset.startStepId)
}

export async function resolveTicketMergeRun(ticketId: string, optionId: string) {
  const ticket = getTicket(ticketId)
  if (!ticket) {
    throw new Error('Ticket not found')
  }

  if (activeRuns.has(ticketId)) {
    throw new Error('Ticket is already running')
  }

  if (!ticket.worktree || ticket.status !== 'awaiting_merge') {
    throw new Error('Ticket is not waiting for a merge decision')
  }

  const option = ticket.mergeBlock?.options.find((entry) => entry.id === optionId)
  if (!option) {
    throw new Error('Merge resolution option must be selected')
  }

  setTicketMergeContext(ticketId, {
    ...ticket.mergeContext,
    conflictFiles: [...(ticket.mergeContext?.conflictFiles ?? ticket.mergeBlock?.conflictFiles ?? [])],
    lastAttemptedAction: option.action,
  })

  if (option.action === 'discard_worktree') {
    await discardTicketWorktree(ticketId)
    setTicketMergeBlock(ticketId, undefined)
    setTicketMergeContext(ticketId, undefined)
    return
  }

  if (option.action === 'reapply_on_latest_base') {
    const sourceWorktree = ticket.worktree ? { ...ticket.worktree } : undefined
    const sourceRunId = ticket.activeRunId ?? undefined
    const sourceFinalReportOutput = ticket.finalReport?.output
    const sourceReadyOutput = ticket.steps.ready?.output
    const sourceDiffSummary = ticket.worktree?.diffSummary
    const sourceConflictFiles = [...(ticket.mergeBlock?.conflictFiles ?? ticket.mergeContext?.conflictFiles ?? [])]
    const sourceAnalysisKey = ticket.mergeContext?.analysisKey
    const sourceCurrentBaseCommit = ticket.mergeContext?.currentBaseCommit
    const sourceHeadCommit = ticket.mergeContext?.headCommit
    const reset = applyTicketRetryPlan(ticketId, {
      id: 'merge-reapply-on-latest-base',
      label: option.label,
      startStepId: 'implement',
      executionMode: 'new_run',
      sessionMode: 'new_thread',
      shouldCleanupWorktree: false,
    })
    if (!reset) {
      throw new Error('Ticket is not retryable from the selected merge option')
    }

    setTicketMergeContext(ticketId, {
      mode: 'reapply_on_latest_base',
      analysisKey: sourceAnalysisKey,
      currentBaseCommit: sourceCurrentBaseCommit,
      headCommit: sourceHeadCommit,
      conflictFiles: sourceConflictFiles,
      lastAttemptedAction: option.action,
      sourceRunId,
      sourceFinalReportOutput,
      sourceReadyOutput,
      sourceDiffSummary,
      supersededWorktree: sourceWorktree,
    })

    appendTimelineEvent(ticketId, {
      type: 'system',
      title: 'merge 해결 선택에 따라 최신 기준 브랜치에서 변경 재적용을 시작합니다.',
      body: option.rationale,
    })
    queueTicketRun(ticketId, 'implement', 'merge 충돌을 해결하기 위해 최신 기준 브랜치에서 기존 reviewed 변경 의도를 다시 적용합니다.')
    return
  }

  if (option.action === 'preserve_target_changes_and_reconcile') {
    const sourceWorktree = ticket.worktree ? { ...ticket.worktree } : undefined
    const sourceRunId = ticket.activeRunId ?? undefined
    const sourceFinalReportOutput = ticket.finalReport?.output
    const sourceReadyOutput = ticket.steps.ready?.output
    const sourceDiffSummary = ticket.worktree?.diffSummary
    const sourceConflictFiles = [...(ticket.mergeBlock?.conflictFiles ?? ticket.mergeContext?.conflictFiles ?? [])]
    const sourceAnalysisKey = ticket.mergeContext?.analysisKey
    const sourceCurrentBaseCommit = ticket.mergeContext?.currentBaseCommit
    const sourceHeadCommit = ticket.mergeContext?.headCommit
    const sourceReviewedBaseCommit = ticket.worktree?.baseCommit
    const sourceReviewedHeadCommit = ticket.worktree?.headCommit
    const preservedTarget = await preserveTargetWorktreeForMergeReconcile(ticketId)
    const reset = applyTicketRetryPlan(ticketId, {
      id: 'merge-preserve-target-and-reconcile',
      label: option.label,
      startStepId: 'implement',
      executionMode: 'new_run',
      sessionMode: 'new_thread',
      shouldCleanupWorktree: false,
    })
    if (!reset) {
      throw new Error('Ticket is not retryable from the selected merge option')
    }

    setTicketMergeContext(ticketId, {
      mode: 'reconcile_target_worktree',
      analysisKey: sourceAnalysisKey,
      currentBaseCommit: sourceCurrentBaseCommit ?? preservedTarget.targetHeadCommit,
      headCommit: sourceHeadCommit,
      conflictFiles: sourceConflictFiles,
      lastAttemptedAction: option.action,
      sourceRunId,
      sourceFinalReportOutput,
      sourceReadyOutput,
      sourceDiffSummary,
      sourceReviewedBaseCommit,
      sourceReviewedHeadCommit,
      targetBranchName: preservedTarget.targetBranchName,
      targetHeadCommit: preservedTarget.targetHeadCommit,
      safetyBranchName: preservedTarget.safetyBranchName,
      safetyCommit: preservedTarget.safetyCommit,
      safetyDiffSummary: preservedTarget.safetyDiffSummary,
      reconcileSeedApplied: false,
      supersededWorktree: sourceWorktree,
    })

    appendTimelineEvent(ticketId, {
      type: 'system',
      title: 'merge 대상 로컬 변경을 보존하고 reconcile run을 시작합니다.',
      body: `${option.rationale}\n보존 브랜치: ${preservedTarget.safetyBranchName}`,
    })
    queueTicketRun(
      ticketId,
      'implement',
      'merge 대상 브랜치의 로컬 변경을 보존한 뒤 reviewed ticket 결과와 reconcile합니다.'
    )
    return
  }

  if (option.action === 'restart_from_plan') {
    const shouldCleanupWorktree = Boolean(
      ticket.worktree && ticket.worktree.status !== 'merged' && ticket.worktree.status !== 'discarded'
    )
    if (shouldCleanupWorktree) {
      await destroyTicketWorktree(ticketId)
    }

    const reset = applyTicketRetryPlan(ticketId, {
      id: 'merge-restart-plan',
      label: option.label,
      startStepId: 'plan',
      executionMode: 'new_run',
      sessionMode: 'new_thread',
      shouldCleanupWorktree,
    })
    if (!reset) {
      throw new Error('Ticket is not retryable from the selected merge option')
    }

    setTicketMergeBlock(ticketId, undefined)
    appendTimelineEvent(ticketId, {
      type: 'system',
      title: 'merge 해결 선택에 따라 plan 단계부터 새 run을 시작합니다.',
      body: option.rationale,
    })
    queueTicketRun(ticketId, 'plan', 'merge 기준이 바뀌어 현재 기준 브랜치에서 계획부터 다시 실행합니다.')
    return
  }

  const prepared = await prepareTicketWorktreeForMergeResolution(ticketId, option.action)
  if (!prepareTicketForMergeValidation(ticketId, prepared.startStepId)) {
    throw new Error('Ticket merge validation could not be prepared')
  }

  const latestTicket = getTicket(ticketId)
  setTicketRepairLoop(ticketId, {
    gate: 'merge',
    cycle: (latestTicket?.repairLoop?.cycle ?? 0) + 1,
    status: prepared.startStepId === 'verify' ? 'waiting_verify' : 'waiting_review',
    failureSummary: option.rationale,
    startedAt: new Date().toISOString(),
  })

  appendTimelineEvent(ticketId, {
    type: 'system',
    title:
      option.action === 'rebase_and_revalidate'
        ? 'merge 해결 선택에 따라 rebase 후 재검증을 시작합니다.'
        : 'merge 해결 선택에 따라 현재 worktree 기준 재검증을 시작합니다.',
    body: option.rationale,
  })
  queueTicketRun(ticketId, prepared.startStepId, prepared.recoveryNotes)
}
