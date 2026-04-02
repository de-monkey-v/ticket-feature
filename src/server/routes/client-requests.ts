import { Hono } from 'hono'
import { getAuthSession, requireProjectPermission } from '../lib/auth.js'
import { hasPermission } from '../lib/access-policy.js'
import { loadConfig } from '../lib/config.js'
import { requireAccessibleProjectById } from '../lib/projects.js'
import {
  buildManualRequestDraftPrompt,
  generateRequestDraft,
} from '../services/request-draft-tool.js'
import { queueBackgroundRun } from '../services/background-runs.js'
import { screenManualRequestInput } from '../services/request-screening.js'
import { queueTicketRun } from '../services/ticket-runner.js'
import { createTicket, toPublicTicket, toPublicTicketRun } from '../services/tickets.js'
import {
  buildTicketDraftFromRequest,
  createClientRequest,
  reconcileClientRequestTicketLink,
  reconcileClientRequestTicketLinks,
  deleteClientRequest,
  getClientRequest,
  linkRequestToTicket,
  listClientRequests,
  reloadClientRequestsFromDisk,
  type RequestTemplateFields,
} from '../services/client-requests.js'

export const clientRequestRoutes = new Hono()

function createEmptyTemplate(): RequestTemplateFields {
  return {
    problem: '',
    desiredOutcome: '',
    userScenarios: '',
    constraints: '',
    nonGoals: '',
    openQuestions: '',
  }
}

function hasRequestDraftInput(title: string | undefined, template: RequestTemplateFields) {
  return Boolean(
    title?.trim() ||
      template.problem.trim() ||
      template.desiredOutcome.trim() ||
      template.userScenarios.trim() ||
      template.constraints?.trim() ||
      template.nonGoals?.trim() ||
      template.openQuestions?.trim()
  )
}

function buildRequestScreeningErrorPayload(result: Awaited<ReturnType<typeof screenManualRequestInput>>) {
  if (result.verdict === 'noise') {
    return {
      error: '의미 없는 텍스트가 많습니다. 요청 내용을 조금 더 구체적으로 작성해 주세요.',
      code: 'REQUEST_INPUT_TOO_NOISY',
    }
  }

  return {
    error: '요청 의도는 보이지만 아직 너무 모호합니다. 문제 배경이나 원하는 결과를 조금 더 구체적으로 적어 주세요.',
    code: 'REQUEST_INPUT_TOO_VAGUE',
  }
}

clientRequestRoutes.get('/client-requests', (c) => {
  reloadClientRequestsFromDisk()
  const config = loadConfig()
  const auth = getAuthSession(c)
  const projectId = c.req.query('projectId')

  if (!hasPermission(auth, 'requests')) {
    return c.json({ error: 'This token cannot access requests', code: 'FEATURE_FORBIDDEN' }, 403)
  }

  if (!projectId) {
    const allowedProjectIds = new Set(
      auth.projectIds === null ? config.projects.map((project) => project.id) : auth.projectIds
    )
    reconcileClientRequestTicketLinks(allowedProjectIds)
    return c.json(listClientRequests().filter((request) => allowedProjectIds.has(request.projectId)))
  }

  try {
    const project = requireAccessibleProjectById(config, auth, projectId)
    const permissionError = requireProjectPermission(c, project.id, 'requests')
    if (permissionError) {
      return permissionError
    }
    reconcileClientRequestTicketLinks([project.id])
    return c.json(listClientRequests(project.id))
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown project'
    return c.json(
      { error: message, code: message === 'Project access denied' ? 'PROJECT_FORBIDDEN' : 'UNKNOWN_PROJECT' },
      message === 'Project access denied' ? 403 : 400
    )
  }
})

clientRequestRoutes.post('/client-requests', async (c) => {
  const { requester, title, template, projectId, categoryId, source, explainThreadId } = await c.req.json<{
    requester: string
    title: string
    template: RequestTemplateFields
    projectId?: string
    categoryId?: string
    source?: 'manual' | 'chat'
    explainThreadId?: string
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

  const permissionError = requireProjectPermission(c, project.id, 'requests')
  if (permissionError) {
    return permissionError
  }

  const category = config.flows.ticket.categories.find((entry) => entry.id === categoryId)
  if (!category) {
    return c.json({ error: 'Unknown ticket category', code: 'UNKNOWN_CATEGORY' }, 400)
  }

  if (source && source !== 'manual' && source !== 'chat') {
    return c.json({ error: 'Unknown client request source', code: 'UNKNOWN_REQUEST_SOURCE' }, 400)
  }

  if (source !== 'chat') {
    const screeningResult = await screenManualRequestInput({
      title,
      template,
      projectPath: project.path,
      screeningConfig: config.flows.requests.screening,
    })

    if (screeningResult.verdict !== 'valid') {
      return c.json(buildRequestScreeningErrorPayload(screeningResult), 400)
    }
  }

  const request = createClientRequest({
      requester,
      title,
      template,
      projectId: project.id,
      categoryId: category.id,
      source,
    explainThreadId,
  })

  return c.json(request)
})

clientRequestRoutes.post('/client-requests/draft', async (c) => {
  const body = await c.req.json<{
    requester?: string
    title?: string
    template?: Partial<RequestTemplateFields>
    projectId?: string
    categoryId?: string
  }>()
  const template: RequestTemplateFields = {
    ...createEmptyTemplate(),
    ...(body.template ?? {}),
  }

  if (!hasRequestDraftInput(body.title, template)) {
    return c.json(
      {
        error: 'Request title or template content is required to generate a draft',
        code: 'INVALID_REQUEST_DRAFT_INPUT',
      },
      400
    )
  }

  const config = loadConfig()
  const auth = getAuthSession(c)
  let project

  try {
    project = requireAccessibleProjectById(config, auth, body.projectId)
  } catch (error: any) {
    return c.json(
      { error: error.message, code: error.message === 'Project access denied' ? 'PROJECT_FORBIDDEN' : 'UNKNOWN_PROJECT' },
      error.message === 'Project access denied' ? 403 : 400
    )
  }

  const permissionError = requireProjectPermission(c, project.id, 'requests')
  if (permissionError) {
    return permissionError
  }

  const category = config.flows.ticket.categories.find((entry) => entry.id === body.categoryId)
  if (!category) {
    return c.json({ error: 'Unknown ticket category', code: 'UNKNOWN_CATEGORY' }, 400)
  }

  const prompt = buildManualRequestDraftPrompt(
    {
      requester: body.requester,
      title: body.title,
      categoryId: category.id,
      template,
    },
    project.id,
    config.flows.ticket.categories
  )

  const screeningResult = await screenManualRequestInput({
    title: body.title,
    template,
    projectPath: project.path,
    screeningConfig: config.flows.requests.screening,
  })

  if (screeningResult.verdict !== 'valid') {
    return c.json(buildRequestScreeningErrorPayload(screeningResult), 400)
  }

  try {
    const draft = await generateRequestDraft({
      prompt,
      projectPath: project.path,
      categories: config.flows.ticket.categories,
      explainFlow: config.flows.explain,
    })

    return c.json(draft)
  } catch (error: any) {
    return c.json(
      {
        error: error?.message || 'Request draft generation failed',
        code: 'REQUEST_DRAFT_FAILED',
      },
      502
    )
  }
})

clientRequestRoutes.post('/client-requests/draft-runs', async (c) => {
  const body = await c.req.json<{
    requester?: string
    title?: string
    template?: Partial<RequestTemplateFields>
    projectId?: string
    categoryId?: string
    scopeLabel?: string
  }>()
  const template: RequestTemplateFields = {
    ...createEmptyTemplate(),
    ...(body.template ?? {}),
  }

  if (!hasRequestDraftInput(body.title, template)) {
    return c.json(
      {
        error: 'Request title or template content is required to generate a draft',
        code: 'INVALID_REQUEST_DRAFT_INPUT',
      },
      400
    )
  }

  const config = loadConfig()
  const auth = getAuthSession(c)
  let project

  try {
    project = requireAccessibleProjectById(config, auth, body.projectId)
  } catch (error: any) {
    return c.json(
      { error: error.message, code: error.message === 'Project access denied' ? 'PROJECT_FORBIDDEN' : 'UNKNOWN_PROJECT' },
      error.message === 'Project access denied' ? 403 : 400
    )
  }

  const permissionError = requireProjectPermission(c, project.id, 'requests')
  if (permissionError) {
    return permissionError
  }

  const category = config.flows.ticket.categories.find((entry) => entry.id === body.categoryId)
  if (!category) {
    return c.json({ error: 'Unknown ticket category', code: 'UNKNOWN_CATEGORY' }, 400)
  }

  const prompt = buildManualRequestDraftPrompt(
    {
      requester: body.requester,
      title: body.title,
      categoryId: category.id,
      template,
    },
    project.id,
    config.flows.ticket.categories
  )

  const screeningResult = await screenManualRequestInput({
    title: body.title,
    template,
    projectPath: project.path,
    screeningConfig: config.flows.requests.screening,
  })

  if (screeningResult.verdict !== 'valid') {
    return c.json(buildRequestScreeningErrorPayload(screeningResult), 400)
  }

  const started = queueBackgroundRun(
    auth,
    {
      projectId: project.id,
      kind: 'manual_request_draft',
      permission: 'requests',
      scopeType: 'request_compose',
      scopeId: 'request-compose',
      scopeLabel: body.scopeLabel?.trim() || 'New Request Draft',
      messagePreview: body.title?.trim() || template.problem.trim() || template.desiredOutcome.trim(),
    },
    async (run) => {
      try {
        run.emitState('요청 초안 정리 중', '입력한 내용을 바탕으로 AI draft를 생성하고 있습니다.')
        const draft = await generateRequestDraft({
          prompt,
          projectPath: project.path,
          categories: config.flows.ticket.categories,
          explainFlow: config.flows.explain,
          signal: run.signal,
        })

        run.complete(
          {
            draft,
          },
          {
            latestLabel: '요청 초안 완료',
            latestDetail: undefined,
            result: draft,
          }
        )
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          run.stop(
            {
              error: '요청 초안 생성이 중단되었습니다.',
            },
            {
              latestLabel: '요청 초안 중단됨',
              latestDetail: '사용자 요청으로 작업을 중단했습니다.',
            }
          )
          return
        }

        const message = error instanceof Error ? error.message : 'Request draft generation failed'
        run.fail(message, { code: 'REQUEST_DRAFT_FAILED' }, {
          latestLabel: '요청 초안 생성 실패',
          latestDetail: message,
        })
      }
    }
  )

  return c.json(started, 202)
})

clientRequestRoutes.post('/client-requests/:id/create-ticket', async (c) => {
  reloadClientRequestsFromDisk()
  const requestId = c.req.param('id')
  const storedRequest = getClientRequest(requestId)
  if (!storedRequest) {
    return c.json({ error: 'Client request not found' }, 404)
  }

  const permissionError = requireProjectPermission(c, storedRequest.projectId, 'tickets')
  if (permissionError) {
    return permissionError
  }

  const request = reconcileClientRequestTicketLink(requestId) ?? storedRequest
  if (request.linkedTicketId) {
    return c.json({ error: 'Ticket already created for this request' }, 400)
  }

  if (request.readinessStatus !== 'ready_for_ticket') {
    return c.json(
      {
        error: 'Client request needs clarification before a ticket can be created',
        code: 'REQUEST_NOT_READY',
        readinessNotes: request.readinessNotes,
      },
      400
    )
  }

  const config = loadConfig()
  const project = requireAccessibleProjectById(config, getAuthSession(c), request.projectId)
  const category = config.flows.ticket.categories.find((entry) => entry.id === request.categoryId)

  if (!category) {
    return c.json({ error: 'Unknown ticket category', code: 'UNKNOWN_CATEGORY' }, 400)
  }

  const mappedTicket = buildTicketDraftFromRequest(request)
  const ticket = createTicket({
    title: mappedTicket.title,
    description: mappedTicket.description,
    projectId: project.id,
    projectPath: project.path,
    categoryId: category.id,
    flowStepIds: category.steps,
    linkedRequestId: request.id,
  })

  linkRequestToTicket(request.id, ticket.id)
  queueTicketRun(ticket.id)

  return c.json({
    requestId: request.id,
    ticket: toPublicTicket(ticket),
    run: ticket.activeRunId ? toPublicTicketRun(ticket.id, ticket.activeRunId) : null,
  })
})

clientRequestRoutes.delete('/client-requests/:id', (c) => {
  reloadClientRequestsFromDisk()
  const requestId = c.req.param('id')
  const storedRequest = getClientRequest(requestId)
  if (!storedRequest) {
    return c.json({ error: 'Client request not found' }, 404)
  }

  const permissionError = requireProjectPermission(c, storedRequest.projectId, 'requests')
  if (permissionError) {
    return permissionError
  }

  const request = reconcileClientRequestTicketLink(requestId) ?? storedRequest
  if (request.linkedTicketId) {
    return c.json(
      {
        error: 'Linked ticket must be deleted before removing this client request',
        code: 'REQUEST_LINKED_TICKET_EXISTS',
        linkedTicketId: request.linkedTicketId,
      },
      400
    )
  }

  const ok = deleteClientRequest(request.id)
  if (!ok) {
    return c.json({ error: 'Client request not found' }, 404)
  }

  return c.json({ ok: true })
})
