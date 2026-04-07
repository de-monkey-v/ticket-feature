import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { hasPermission } from '../lib/access-policy.js'
import { getAuthSession, requireProjectPermission } from '../lib/auth.js'
import { loadConfig } from '../lib/config.js'
import { requireAccessibleProjectById } from '../lib/projects.js'
import { deleteTicketWithCleanup } from '../services/ticket-deletion.js'
import {
  analyzeTicketMergeIssue,
  discardTicketWorktree,
  mergeTicketWorktree,
  runTicketWorkflow,
} from '../services/ticket-orchestrator.js'
import { isTicketRunActive, queueTicketRun, resolveTicketMergeRun, retryTicketRun, stopTicketRun } from '../services/ticket-runner.js'
import {
  buildTicketDraftFromRequest,
  getClientRequest,
  linkRequestToTicket,
  reconcileClientRequestTicketLink,
  reloadClientRequestsFromDisk,
} from '../services/client-requests.js'
import {
  createTicket,
  getTicket,
  listTickets,
  readTicketEventJournal,
  reloadTicketsFromDisk,
  toPublicTicket,
  toPublicTicketRun,
  toPublicTicketSummary,
  type StepResult,
  type Ticket,
} from '../services/tickets.js'
import { captureTicketIncidentWithAutoResolution } from '../services/incident-resolution.js'

export const ticketRoutes = new Hono()

function isCompletedStep(step?: StepResult) {
  return step?.status === 'done' || step?.status === 'approved'
}

function latestStageReviewVerdict(ticket: Ticket, subjectStepId: 'analyze' | 'plan') {
  return [...ticket.stageReviews].reverse().find((review) => review.subjectStepId === subjectStepId)?.verdict
}

function canRunManualStep(ticket: Ticket, stepId: string): { ok: true } | { ok: false; error: string } {
  const config = loadConfig()
  const stepConfig = config.flows.ticket.steps.find((step) => step.id === stepId)

  if (!ticket.flowStepIds.includes(stepId)) {
    return { ok: false, error: 'Step is not part of this ticket flow' }
  }

  if (!stepConfig) {
    return { ok: false, error: 'Step not found' }
  }

  if (stepConfig.runMode !== 'manual') {
    return { ok: false, error: 'Step is automatic' }
  }

  if (isTicketRunActive(ticket.id) || ticket.runState === 'queued' || ticket.runState === 'running') {
    return { ok: false, error: 'Ticket is already running' }
  }

  if (ticket.runState === 'needs_decision' || ticket.runState === 'needs_request_clarification') {
    return { ok: false, error: 'Ticket requires clarification before another manual step can run' }
  }

  const stepResult = ticket.steps[stepId]

  if (stepId === 'analyze') {
    const allowed = !stepResult || stepResult.status === 'pending' || stepResult.status === 'failed'
    return allowed ? { ok: true } : { ok: false, error: 'Analyze step cannot be run right now' }
  }

  if (stepId === 'plan') {
    const analyzeResult = ticket.steps.analyze
    const analyzeReview = latestStageReviewVerdict(ticket, 'analyze')
    const allowed =
      isCompletedStep(analyzeResult) &&
      (analyzeReview === 'pass' || ticket.stageReviews.every((review) => review.subjectStepId !== 'analyze')) &&
      (!stepResult || stepResult.status === 'pending' || stepResult.status === 'failed')

    return allowed
      ? { ok: true }
      : { ok: false, error: 'Analyze and analyze review must complete before planning' }
  }

  if (stepId === 'implement') {
    const planResult = ticket.steps.plan
    const planReview = latestStageReviewVerdict(ticket, 'plan')
    const readyResult = ticket.steps.ready

    if (!isCompletedStep(planResult) || planReview !== 'pass') {
      return { ok: false, error: 'Plan review must complete first' }
    }

    if (readyResult?.status === 'done' || ticket.status === 'completed' || ticket.status === 'awaiting_merge') {
      return { ok: false, error: 'Ticket is already complete' }
    }

    const allowed = !stepResult || stepResult.status === 'pending' || stepResult.status === 'failed'

    return allowed
      ? { ok: true }
      : { ok: false, error: 'Implement step cannot be run right now' }
  }

  return { ok: false, error: 'Unsupported manual step' }
}

function shouldCaptureActionIncident(operation: 'retry' | 'merge' | 'discard', message: string) {
  if (operation === 'retry') {
    return ![
      'Ticket not found',
      'Ticket is already running',
      'Ticket cannot be retried in its current state',
      'Ticket is not retryable',
      'Retry option must be selected',
    ].includes(message)
  }

  if (operation === 'merge') {
    return message !== 'Ticket not found' && message !== 'Ticket is not ready for merge'
  }

  return message !== 'Ticket not found' && message !== 'Ticket is not waiting for a merge decision'
}

function requiresMergeDecision(message: string) {
  return (
    message.includes('Merge target branch changed since worktree creation') ||
    message.includes('Merge target commit changed since worktree creation') ||
    message.includes('Worktree head changed after review') ||
    message.includes('Failed to merge ticket worktree branch') ||
    message.includes('Merge target worktree has local changes overlapping reviewed ticket files') ||
    message.includes('would be overwritten by merge') ||
    message.includes('untracked working tree files would be overwritten by merge') ||
    /rebase/i.test(message)
  )
}

function findAutomaticMergeResolutionOption(mergeBlock: NonNullable<Ticket['mergeBlock']>) {
  if (mergeBlock.conflictFiles.length > 0) {
    return null
  }

  if (mergeBlock.issue === 'base_branch_changed' || mergeBlock.issue === 'base_commit_changed') {
    return mergeBlock.options.find((option) => option.action === 'rebase_and_revalidate') ?? null
  }

  if (mergeBlock.issue === 'head_changed_after_review') {
    return mergeBlock.options.find((option) => option.action === 'revalidate_current_worktree') ?? null
  }

  return null
}

function buildAutomaticMergeResolutionWarning(mergeBlock: NonNullable<Ticket['mergeBlock']>) {
  if (mergeBlock.issue === 'head_changed_after_review') {
    return 'review 이후 HEAD가 달라져 현재 worktree 기준 verify/review를 다시 시작했습니다.'
  }

  return '기준 브랜치가 이동해 자동 rebase/revalidate를 시작했습니다.'
}

function captureActionIncidentSafely(
  ticketId: string,
  trigger: Parameters<typeof captureTicketIncidentWithAutoResolution>[1]
) {
  if (!getTicket(ticketId)) {
    return
  }

  try {
    captureTicketIncidentWithAutoResolution(ticketId, trigger)
  } catch (captureError) {
    console.error(`Failed to capture action incident for ${ticketId}:`, captureError)
  }
}

function requireTicketAccess(c: any, ticket: Ticket) {
  return requireProjectPermission(c, ticket.projectId, 'tickets')
}

function refreshTicket(ticketId: string) {
  reloadTicketsFromDisk()
  return getTicket(ticketId)
}

function delay(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true }
    )
  })
}

ticketRoutes.post('/tickets', async (c) => {
  const { title, description, projectId, categoryId, linkedRequestId } = await c.req.json<{
    title: string
    description: string
    projectId?: string
    categoryId?: string
    linkedRequestId?: string
  }>()

  const config = loadConfig()
  const auth = getAuthSession(c)
  let project
  reloadClientRequestsFromDisk()

  try {
    project = requireAccessibleProjectById(config, auth, projectId)
  } catch (error: any) {
    return c.json(
      { error: error.message, code: error.message === 'Project access denied' ? 'PROJECT_FORBIDDEN' : 'UNKNOWN_PROJECT' },
      error.message === 'Project access denied' ? 403 : 400
    )
  }

  const permissionError = requireProjectPermission(c, project.id, 'tickets')
  if (permissionError) {
    return permissionError
  }

  const category = config.flows.ticket.categories.find((entry) => entry.id === categoryId)
  if (!category) {
    return c.json({ error: 'Unknown ticket category', code: 'UNKNOWN_CATEGORY' }, 400)
  }

  const storedLinkedRequest = linkedRequestId ? getClientRequest(linkedRequestId) : undefined
  if (linkedRequestId && !storedLinkedRequest) {
    return c.json({ error: 'Client request not found', code: 'UNKNOWN_REQUEST' }, 404)
  }

  const linkedRequest =
    storedLinkedRequest && linkedRequestId
      ? (reconcileClientRequestTicketLink(linkedRequestId) ?? storedLinkedRequest)
      : undefined

  if (linkedRequest) {
    if (linkedRequest.linkedTicketId) {
      return c.json({ error: 'Ticket already created for this request', code: 'REQUEST_ALREADY_LINKED' }, 400)
    }

    if (linkedRequest.readinessStatus !== 'ready_for_ticket') {
      return c.json(
        {
          error: 'Client request needs clarification before a ticket can be created',
          code: 'REQUEST_NOT_READY',
          readinessNotes: linkedRequest.readinessNotes,
        },
        400
      )
    }
  }

  const mappedTicket = linkedRequest ? buildTicketDraftFromRequest(linkedRequest) : { title, description }

  const ticket = createTicket({
    title: mappedTicket.title,
    description: mappedTicket.description,
    projectId: project.id,
    projectPath: project.path,
    categoryId: category.id,
    flowStepIds: category.steps,
    linkedRequestId,
  })

  if (linkedRequest) {
    linkRequestToTicket(linkedRequest.id, ticket.id)
  }

  queueTicketRun(ticket.id)

  return c.json({
    ticketId: ticket.id,
    title: ticket.title,
    ticket: toPublicTicket(ticket),
    run: ticket.activeRunId ? toPublicTicketRun(ticket.id, ticket.activeRunId) : null,
  })
})

ticketRoutes.get('/tickets', (c) => {
  reloadTicketsFromDisk()
  const config = loadConfig()
  const auth = getAuthSession(c)
  const projectId = c.req.query('projectId')

  if (!hasPermission(auth, 'tickets')) {
    return c.json({ error: 'This token cannot access tickets', code: 'FEATURE_FORBIDDEN' }, 403)
  }

  if (!projectId) {
    const allowedProjectIds = new Set(
      auth.projectIds === null ? config.projects.map((project) => project.id) : auth.projectIds
    )
    return c.json(
      listTickets()
        .filter((ticket) => allowedProjectIds.has(ticket.projectId))
        .map(toPublicTicketSummary)
    )
  }

  try {
    const project = requireAccessibleProjectById(config, auth, projectId)
    const permissionError = requireProjectPermission(c, project.id, 'tickets')
    if (permissionError) {
      return permissionError
    }
    return c.json(listTickets(project.id).map(toPublicTicketSummary))
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown project'
    return c.json(
      { error: message, code: message === 'Project access denied' ? 'PROJECT_FORBIDDEN' : 'UNKNOWN_PROJECT' },
      message === 'Project access denied' ? 403 : 400
    )
  }
})

ticketRoutes.get('/tickets/:id', (c) => {
  const ticket = refreshTicket(c.req.param('id'))
  if (!ticket) return c.json({ error: 'Ticket not found' }, 404)
  const permissionError = requireTicketAccess(c, ticket)
  if (permissionError) {
    return permissionError
  }
  return c.json(toPublicTicket(ticket))
})

ticketRoutes.get('/tickets/:id/runs/:runId', (c) => {
  const ticket = refreshTicket(c.req.param('id'))
  if (!ticket) return c.json({ error: 'Ticket not found' }, 404)
  const permissionError = requireTicketAccess(c, ticket)
  if (permissionError) {
    return permissionError
  }

  const run = toPublicTicketRun(ticket.id, c.req.param('runId'))
  if (!run) {
    return c.json({ error: 'Ticket run not found' }, 404)
  }

  return c.json(run)
})

ticketRoutes.get('/tickets/:id/events', (c) => {
  const ticketId = c.req.param('id')
  const ticket = refreshTicket(ticketId)
  if (!ticket) return c.json({ error: 'Ticket not found' }, 404)
  const permissionError = requireTicketAccess(c, ticket)
  if (permissionError) {
    return permissionError
  }

  return streamSSE(c, async (stream) => {
    const abortController = new AbortController()
    const sentEventCounts = new Map<string, number>()
    let lastStatePayload = ''

    stream.onAbort(() => {
      abortController.abort()
    })

    await stream.writeSSE({
      event: 'init',
      data: JSON.stringify({ ticketId, activeRunId: ticket.activeRunId }),
    })

    while (!abortController.signal.aborted) {
      reloadTicketsFromDisk()
      const currentTicket = getTicket(ticketId)

      if (!currentTicket) {
        const deletedPayload = JSON.stringify({ deleted: true, ticketId })
        if (deletedPayload !== lastStatePayload) {
          await stream.writeSSE({
            event: 'state',
            data: deletedPayload,
          })
        }
        abortController.abort()
        break
      }

      const statePayload = JSON.stringify({
        ticket: toPublicTicket(currentTicket),
        run: currentTicket.activeRunId ? toPublicTicketRun(ticketId, currentTicket.activeRunId) : null,
      })
      if (statePayload !== lastStatePayload) {
        await stream.writeSSE({
          event: 'state',
          data: statePayload,
        })
        lastStatePayload = statePayload
      }

      if (currentTicket.activeRunId) {
        const journalEntries = readTicketEventJournal(ticketId, currentTicket.activeRunId)
        const sentCount = sentEventCounts.get(currentTicket.activeRunId) ?? 0
        const unsentEntries = journalEntries.slice(sentCount)

        for (const entry of unsentEntries) {
          await stream.writeSSE({
            event: entry.type,
            data: JSON.stringify(entry.data),
          })

          if (entry.type === 'state') {
            lastStatePayload = JSON.stringify(entry.data)
          }
        }

        sentEventCounts.set(currentTicket.activeRunId, journalEntries.length)
      }

      await delay(250, abortController.signal)
    }
  })
})

ticketRoutes.delete('/tickets/:id', async (c) => {
  const ticketId = c.req.param('id')
  const ticket = refreshTicket(ticketId)
  if (!ticket) return c.json({ error: 'Ticket not found' }, 404)
  const permissionError = requireTicketAccess(c, ticket)
  if (permissionError) {
    return permissionError
  }

  try {
    await deleteTicketWithCleanup(ticketId)
  } catch (error: any) {
    return c.json({ error: error.message, code: 'DELETE_FAILED' }, 400)
  }

  return c.json({ ok: true })
})

ticketRoutes.post('/tickets/:id/steps/:step', async (c) => {
  const ticketId = c.req.param('id')
  const stepId = c.req.param('step')
  const ticket = refreshTicket(ticketId)

  if (!ticket) return c.json({ error: 'Ticket not found' }, 404)
  const permissionError = requireTicketAccess(c, ticket)
  if (permissionError) {
    return permissionError
  }

  const config = loadConfig()
  const stepConfig = config.flows.ticket.steps.find((s) => s.id === stepId)
  if (!stepConfig) return c.json({ error: 'Step not found' }, 404)
  const runCheck = canRunManualStep(ticket, stepId)
  if (!runCheck.ok) {
    return c.json({ error: runCheck.error, code: 'STEP_NOT_RUNNABLE' }, 400)
  }

  return streamSSE(c, async (stream) => {
    const abortController = new AbortController()

    stream.onAbort(() => {
      abortController.abort()
    })

    try {
      await runTicketWorkflow({
        ticketId,
        stepId,
        signal: abortController.signal,
        onEvent: async (event) => {
          await stream.writeSSE({
            event: event.type,
            data: JSON.stringify(event.data),
          })
        },
      })
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        await stream.writeSSE({
          event: 'error',
          data: JSON.stringify({ message: err.message, stepId }),
        })
      }
    }
  })
})

ticketRoutes.post('/tickets/:id/retry', async (c) => {
  const ticketId = c.req.param('id')
  const ticket = refreshTicket(ticketId)
  if (!ticket) {
    return c.json({ error: 'Ticket not found' }, 404)
  }
  const permissionError = requireTicketAccess(c, ticket)
  if (permissionError) {
    return permissionError
  }
  let optionId: string | undefined
  let clarification: string | undefined

  try {
    const rawBody = await c.req.text()
    if (rawBody.trim()) {
      const parsed = JSON.parse(rawBody) as { optionId?: unknown; clarification?: unknown }
      if (parsed.optionId !== undefined && typeof parsed.optionId !== 'string') {
        return c.json({ error: 'optionId must be a string', code: 'INVALID_RETRY_OPTION' }, 400)
      }
      if (parsed.clarification !== undefined && typeof parsed.clarification !== 'string') {
        return c.json({ error: 'clarification must be a string', code: 'INVALID_CLARIFICATION' }, 400)
      }
      optionId = parsed.optionId
      clarification = parsed.clarification?.trim() || undefined
    }

    await retryTicketRun(ticketId, optionId, clarification)
    return c.json({ ok: true })
  } catch (error: any) {
    if (shouldCaptureActionIncident('retry', error.message)) {
      captureActionIncidentSafely(ticketId, {
        kind: 'retry_failed',
        message: error.message,
        phase: refreshTicket(ticketId)?.currentPhase ?? null,
        attempt: getTicket(ticketId)?.attemptCount,
      })
    }
    return c.json({ error: error.message, code: 'RETRY_FAILED' }, 400)
  }
})

ticketRoutes.post('/tickets/:id/stop', async (c) => {
  const ticket = refreshTicket(c.req.param('id'))
  if (!ticket) {
    return c.json({ error: 'Ticket not found' }, 404)
  }
  const permissionError = requireTicketAccess(c, ticket)
  if (permissionError) {
    return permissionError
  }

  try {
    await stopTicketRun(c.req.param('id'))
    return c.json({ ok: true })
  } catch (error: any) {
    return c.json({ error: error.message, code: 'STOP_FAILED' }, 400)
  }
})

ticketRoutes.post('/tickets/:id/merge', async (c) => {
  const ticketId = c.req.param('id')
  const ticket = refreshTicket(ticketId)
  if (!ticket) {
    return c.json({ error: 'Ticket not found' }, 404)
  }
  const permissionError = requireTicketAccess(c, ticket)
  if (permissionError) {
    return permissionError
  }
  try {
    await mergeTicketWorktree(ticketId)
    return c.json({ ok: true })
  } catch (error: any) {
    const ticket = refreshTicket(ticketId)
    if (ticket?.status === 'completed' && ticket.worktree?.status === 'cleanup_failed') {
      return c.json({ ok: true, warning: error.message })
    }

    if (requiresMergeDecision(error.message)) {
      const mergeBlock = await analyzeTicketMergeIssue(ticketId, error.message)
      const automaticOption = findAutomaticMergeResolutionOption(mergeBlock)
      if (automaticOption) {
        try {
          await resolveTicketMergeRun(ticketId, automaticOption.id)
          return c.json({
            ok: true,
            warning: buildAutomaticMergeResolutionWarning(mergeBlock),
          })
        } catch (resolutionError: any) {
          if (!requiresMergeDecision(resolutionError.message)) {
            if (shouldCaptureActionIncident('merge', resolutionError.message)) {
              captureActionIncidentSafely(ticketId, {
                kind: 'merge_failed',
                message: resolutionError.message,
                phase: refreshTicket(ticketId)?.currentPhase ?? null,
                attempt: getTicket(ticketId)?.attemptCount,
              })
            }
            return c.json({ error: resolutionError.message, code: 'MERGE_FAILED' }, 400)
          }
        }
      }
      return c.json({ ok: false, error: error.message, code: 'MERGE_DECISION_REQUIRED', mergeBlock }, 409)
    }

    if (shouldCaptureActionIncident('merge', error.message)) {
      captureActionIncidentSafely(ticketId, {
        kind: 'merge_failed',
        message: error.message,
        phase: ticket?.currentPhase ?? null,
        attempt: ticket?.attemptCount,
      })
    }
    return c.json({ error: error.message, code: 'MERGE_FAILED' }, 400)
  }
})

ticketRoutes.post('/tickets/:id/merge/resolve', async (c) => {
  const ticketId = c.req.param('id')
  const ticket = refreshTicket(ticketId)
  if (!ticket) {
    return c.json({ error: 'Ticket not found' }, 404)
  }
  const permissionError = requireTicketAccess(c, ticket)
  if (permissionError) {
    return permissionError
  }
  try {
    const body = (await c.req.json<{ optionId?: string }>().catch(() => ({} as { optionId?: string }))) as {
      optionId?: string
    }
    if (!body.optionId) {
      return c.json({ error: 'Merge resolution option must be selected', code: 'MERGE_RESOLUTION_REQUIRED' }, 400)
    }

    await resolveTicketMergeRun(ticketId, body.optionId)
    return c.json({ ok: true })
  } catch (error: any) {
    if (requiresMergeDecision(error.message)) {
      const mergeBlock = await analyzeTicketMergeIssue(ticketId, error.message)
      return c.json({ ok: false, error: error.message, code: 'MERGE_DECISION_REQUIRED', mergeBlock }, 409)
    }

    if (shouldCaptureActionIncident('merge', error.message)) {
      captureActionIncidentSafely(ticketId, {
        kind: 'merge_failed',
        message: error.message,
        phase: refreshTicket(ticketId)?.currentPhase ?? null,
        attempt: getTicket(ticketId)?.attemptCount,
      })
    }

    return c.json({ error: error.message, code: 'MERGE_RESOLUTION_FAILED' }, 400)
  }
})

ticketRoutes.post('/tickets/:id/discard', async (c) => {
  const ticketId = c.req.param('id')
  const ticket = refreshTicket(ticketId)
  if (!ticket) {
    return c.json({ error: 'Ticket not found' }, 404)
  }
  const permissionError = requireTicketAccess(c, ticket)
  if (permissionError) {
    return permissionError
  }
  try {
    await discardTicketWorktree(ticketId)
    return c.json({ ok: true })
  } catch (error: any) {
    if (shouldCaptureActionIncident('discard', error.message)) {
      captureActionIncidentSafely(ticketId, {
        kind: 'discard_failed',
        message: error.message,
        phase: refreshTicket(ticketId)?.currentPhase ?? null,
        attempt: getTicket(ticketId)?.attemptCount,
      })
    }
    return c.json({ error: error.message, code: 'DISCARD_FAILED' }, 400)
  }
})
