import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, unlinkSync } from 'node:fs'
import { Hono } from 'hono'
import { resolveRuntimeDataPath } from '../lib/runtime-data-paths.js'
import { clientRequestRoutes } from '../routes/client-requests.js'
import { ticketRoutes } from '../routes/tickets.js'
import {
  REQUEST_DRAFT_TOOL_NAME,
  resetRunCodexTurnForRequestDraftTesting,
  setRunCodexTurnForRequestDraftTesting,
} from '../services/request-draft-tool.js'
import {
  isTicketRunActive,
  resetRunAutomaticTicketWorkflowForTesting,
  setRunAutomaticTicketWorkflowForTesting,
  stopTicketRun,
} from '../services/ticket-runner.js'
import {
  resetRunCodexTurnForRequestScreeningTesting,
  setRunCodexTurnForRequestScreeningTesting,
} from '../services/request-screening.js'
import { resetRunCodexTurnForTesting, setRunCodexTurnForTesting } from '../services/ticket-orchestrator.js'
import {
  createClientRequest,
  deleteClientRequest,
  getClientRequest,
  linkRequestToTicket,
  reloadClientRequestsFromDisk,
} from '../services/client-requests.js'
import { deleteTicket, getTicket, setTicketRunState, updateStepStatus } from '../services/tickets.js'

async function requestClientDraft(body: Record<string, unknown>) {
  const app = new Hono()
  app.route('/api', clientRequestRoutes)

  return app.request('http://localhost/api/client-requests/draft', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function stubValidRequestScreening() {
  setRunCodexTurnForRequestScreeningTesting(async <T = unknown>() => ({
    threadId: null,
    finalResponse: '',
    parsedOutput: {
      verdict: 'valid',
      reason: '의미 있는 요청입니다.',
      confidence: 0.95,
    } as T,
  }))
}

test('client requests created from chat persist source metadata', async () => {
  const app = new Hono()
  app.route('/api', clientRequestRoutes)

  const response = await app.request('http://localhost/api/client-requests', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      requester: 'Codex Chat',
      title: 'Chat sourced request',
      template: {
        problem: '사용자가 대화 내용을 요청으로 남기기 어렵다.',
        desiredOutcome: '현재 대화를 client request로 저장할 수 있어야 한다.',
        userScenarios: '사용자가 Explain 대화에서 Request + 버튼을 누른다.',
      },
      projectId: 'intentlane-codex',
      categoryId: 'feature',
      source: 'chat',
      explainThreadId: 'thread-chat-123',
    }),
  })

  assert.equal(response.status, 200)
  const request = await response.json()

    assert.equal(request.source, 'chat')
    assert.equal(request.explainThreadId, 'thread-chat-123')
    assert.equal(request.readinessStatus, 'ready_for_ticket')
    assert.equal(getClientRequest(request.id)?.source, 'chat')

  deleteClientRequest(request.id)
})

test('client requests default to manual source', async () => {
  stubValidRequestScreening()

  try {
    const app = new Hono()
    app.route('/api', clientRequestRoutes)

    const response = await app.request('http://localhost/api/client-requests', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        requester: 'Manual User',
        title: 'Manual request',
        template: {
          problem: '수동 요청 저장 화면이 필요하다.',
          desiredOutcome: '요청자가 구조화된 요청을 저장할 수 있어야 한다.',
          userScenarios: '운영자가 Requests 화면에서 입력 후 저장한다.',
        },
        projectId: 'intentlane-codex',
        categoryId: 'bugfix',
      }),
    })

    assert.equal(response.status, 200)
    const request = await response.json()

      assert.equal(request.source, 'manual')
      assert.equal(request.readinessStatus, 'ready_for_ticket')
      assert.equal(getClientRequest(request.id)?.source, 'manual')

    deleteClientRequest(request.id)
  } finally {
    resetRunCodexTurnForRequestScreeningTesting()
  }
})

test('client request list route scopes results by projectId query', async () => {
  const app = new Hono()
  app.route('/api', clientRequestRoutes)

  const matchingRequest = createClientRequest({
    requester: 'Project A',
    title: 'Intentlane request',
    template: {
      problem: '프로젝트별 요청 분리가 필요하다.',
      desiredOutcome: '현재 프로젝트 요청만 보여야 한다.',
      userScenarios: '사용자가 프로젝트를 전환한다.',
    },
    projectId: 'intentlane-codex',
    categoryId: 'feature',
  })

  const otherRequest = createClientRequest({
    requester: 'Project B',
    title: 'Other project request',
    template: {
      problem: '다른 프로젝트 요청이다.',
      desiredOutcome: '현재 프로젝트에는 보이면 안 된다.',
      userScenarios: '서버가 다른 프로젝트 데이터를 함께 반환한다.',
    },
    projectId: 'other-project',
    categoryId: 'feature',
  })

  try {
    const response = await app.request('http://localhost/api/client-requests?projectId=intentlane-codex')

    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.ok(payload.some((request: { id: string }) => request.id === matchingRequest.id))
    assert.equal(payload.some((request: { id: string }) => request.id === otherRequest.id), false)
    assert.equal(payload.every((request: { projectId: string }) => request.projectId === 'intentlane-codex'), true)
  } finally {
    deleteClientRequest(matchingRequest.id)
    deleteClientRequest(otherRequest.id)
  }
})

test('client requests reload from disk and preserve stored metadata', () => {
  const created = createClientRequest({
    requester: 'Reload Test',
    title: 'Persist me',
    template: {
      problem: '서버 재시작 후에도 request가 살아 있어야 한다.',
      desiredOutcome: '디스크 저장본에서 다시 읽어와야 한다.',
      userScenarios: '운영자가 저장 후 서버를 재시작한다.',
    },
    projectId: 'intentlane-codex',
    categoryId: 'feature',
    source: 'chat',
    explainThreadId: 'thread-reload-test',
  })

  try {
    reloadClientRequestsFromDisk()

    const reloaded = getClientRequest(created.id)
    assert.ok(reloaded)
    assert.equal(reloaded?.source, 'chat')
    assert.equal(reloaded?.explainThreadId, 'thread-reload-test')
    assert.equal(reloaded?.projectId, 'intentlane-codex')
    assert.equal(reloaded?.categoryId, 'feature')
  } finally {
    deleteClientRequest(created.id)
  }
})

test('legacy markdown-only client requests are reloaded and backfilled with json sidecars', () => {
  const created = createClientRequest({
    requester: 'Legacy Reload Test',
    title: 'Legacy persist me',
    template: {
      problem: 'json sidecar가 없는 예전 request도 읽어야 한다.',
      desiredOutcome: 'markdown만 있어도 hydrate 후 json이 다시 생겨야 한다.',
      userScenarios: '업그레이드 후 예전 request를 다시 연다.',
    },
    projectId: 'intentlane-codex',
    categoryId: 'change',
  })
  const jsonPath = resolveRuntimeDataPath('client-requests', 'intentlane-codex', `${created.id}.json`)

  try {
    assert.equal(existsSync(jsonPath), true)
    unlinkSync(jsonPath)
    assert.equal(existsSync(jsonPath), false)

    reloadClientRequestsFromDisk()

    assert.equal(existsSync(jsonPath), true)
    assert.equal(getClientRequest(created.id)?.title, 'Legacy persist me')
  } finally {
    deleteClientRequest(created.id)
  }
})

test('client request draft route returns a normalized draft from partial intake input', async () => {
  stubValidRequestScreening()
  setRunCodexTurnForRequestDraftTesting(async (opts) => {
    await opts.onEvent?.({
      type: 'tool_result',
      data: {
        id: 'tool-1',
        server: 'request_intake',
        tool: REQUEST_DRAFT_TOOL_NAME,
        input: { title: 'Draft' },
        result: {
          title: '  AI-generated request  ',
          categoryId: '  change ',
          template: {
            problem: '  사용자가 request를 끝까지 작성하기 어렵다. ',
            desiredOutcome: '  일부만 입력해도 나머지 request를 보완할 수 있어야 한다. ',
            userScenarios: '  운영자가 intake form에서 AI 초안을 만든다. ',
            constraints: '  실제 저장은 사용자가 직접 한다. ',
          },
          rationale: '  partial form을 기반으로 구조화  ',
        },
      },
    })

    return { threadId: null, finalResponse: '' }
  })

  try {
    const response = await requestClientDraft({
      requester: 'Product Manager',
      title: 'Need request assist',
      template: {
        problem: '사용자가 request form을 작성하다 막힌다.',
        desiredOutcome: '',
        userScenarios: '',
        constraints: '',
        nonGoals: '',
        openQuestions: '',
      },
      projectId: 'intentlane-codex',
      categoryId: 'feature',
    })

    assert.equal(response.status, 200)
    const payload = await response.json()

    assert.equal(payload.title, 'AI-generated request')
    assert.equal(payload.categoryId, 'change')
    assert.equal(payload.template.problem, '사용자가 request를 끝까지 작성하기 어렵다.')
    assert.equal(payload.template.desiredOutcome, '일부만 입력해도 나머지 request를 보완할 수 있어야 한다.')
    assert.equal(payload.template.userScenarios, '운영자가 intake form에서 AI 초안을 만든다.')
    assert.equal(payload.template.constraints, '실제 저장은 사용자가 직접 한다.')
    assert.equal(payload.rationale, 'partial form을 기반으로 구조화')
  } finally {
    resetRunCodexTurnForRequestDraftTesting()
    resetRunCodexTurnForRequestScreeningTesting()
  }
})

test('client request draft route rejects empty intake input', async () => {
  const response = await requestClientDraft({
    requester: 'Product Manager',
    title: '   ',
    template: {
      problem: '  ',
      desiredOutcome: '',
      userScenarios: '',
      constraints: '',
      nonGoals: '',
      openQuestions: '',
    },
    projectId: 'intentlane-codex',
    categoryId: 'feature',
  })

  assert.equal(response.status, 400)
  const payload = await response.json()
  assert.equal(payload.code, 'INVALID_REQUEST_DRAFT_INPUT')
})

test('client request draft route rejects unknown project and category', async () => {
  const unknownProjectResponse = await requestClientDraft({
    requester: 'Product Manager',
    title: 'Need request assist',
    template: {
      problem: '사용자가 작성에 어려움을 겪는다.',
      desiredOutcome: '',
      userScenarios: '',
      constraints: '',
      nonGoals: '',
      openQuestions: '',
    },
    projectId: 'missing-project',
    categoryId: 'feature',
  })

  assert.equal(unknownProjectResponse.status, 400)
  assert.equal((await unknownProjectResponse.json()).code, 'UNKNOWN_PROJECT')

  const unknownCategoryResponse = await requestClientDraft({
    requester: 'Product Manager',
    title: 'Need request assist',
    template: {
      problem: '사용자가 작성에 어려움을 겪는다.',
      desiredOutcome: '',
      userScenarios: '',
      constraints: '',
      nonGoals: '',
      openQuestions: '',
    },
    projectId: 'intentlane-codex',
    categoryId: 'missing-category',
  })

  assert.equal(unknownCategoryResponse.status, 400)
  assert.equal((await unknownCategoryResponse.json()).code, 'UNKNOWN_CATEGORY')
})

test('client request draft route surfaces draft generation failures', async () => {
  stubValidRequestScreening()
  setRunCodexTurnForRequestDraftTesting(async () => {
    throw new Error('draft bridge failed')
  })

  try {
    const response = await requestClientDraft({
      requester: 'Product Manager',
      title: 'Need request assist',
      template: {
        problem: '사용자가 작성에 어려움을 겪는다.',
        desiredOutcome: '',
        userScenarios: '',
        constraints: '',
        nonGoals: '',
        openQuestions: '',
      },
      projectId: 'intentlane-codex',
      categoryId: 'feature',
    })

    assert.equal(response.status, 502)
    const payload = await response.json()
    assert.equal(payload.code, 'REQUEST_DRAFT_FAILED')
    assert.equal(payload.error, 'draft bridge failed')
  } finally {
    resetRunCodexTurnForRequestDraftTesting()
    resetRunCodexTurnForRequestScreeningTesting()
  }
})

test('client request draft route rejects malformed tool output', async () => {
  stubValidRequestScreening()
  setRunCodexTurnForRequestDraftTesting(async (opts) => {
    await opts.onEvent?.({
      type: 'tool_result',
      data: {
        id: 'tool-1',
        server: 'request_intake',
        tool: REQUEST_DRAFT_TOOL_NAME,
        input: { title: 'Draft' },
        result: {
          title: 'Broken draft',
          categoryId: 'feature',
          template: {
            problem: '문제만 있다.',
            desiredOutcome: '',
            userScenarios: '',
          },
        },
      },
    })

    return { threadId: null, finalResponse: '' }
  })

  try {
    const response = await requestClientDraft({
      requester: 'Product Manager',
      title: 'Need request assist',
      template: {
        problem: '사용자가 작성에 어려움을 겪는다.',
        desiredOutcome: '',
        userScenarios: '',
        constraints: '',
        nonGoals: '',
        openQuestions: '',
      },
      projectId: 'intentlane-codex',
      categoryId: 'feature',
    })

    assert.equal(response.status, 502)
    const payload = await response.json()
    assert.equal(payload.code, 'REQUEST_DRAFT_FAILED')
    assert.equal(payload.error, 'Codex did not return a valid request draft')
  } finally {
    resetRunCodexTurnForRequestDraftTesting()
    resetRunCodexTurnForRequestScreeningTesting()
  }
})

test('client request draft route rejects noisy intake input before draft generation', async () => {
  const response = await requestClientDraft({
    requester: 'Product Manager',
    title: 'ㅁㄴㅇ',
    template: {
      problem: '',
      desiredOutcome: '',
      userScenarios: '',
      constraints: '',
      nonGoals: '',
      openQuestions: '',
    },
    projectId: 'intentlane-codex',
    categoryId: 'feature',
  })

  assert.equal(response.status, 400)
  const payload = await response.json()
  assert.equal(payload.code, 'REQUEST_INPUT_TOO_NOISY')
})

test('manual client request create rejects noisy intake input', async () => {
  const app = new Hono()
  app.route('/api', clientRequestRoutes)

  const response = await app.request('http://localhost/api/client-requests', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requester: 'Manual User',
      title: 'asdf',
      template: {
        problem: 'asdf',
        desiredOutcome: 'asdf',
        userScenarios: 'asdf',
      },
      projectId: 'intentlane-codex',
      categoryId: 'feature',
    }),
  })

  assert.equal(response.status, 400)
  const payload = await response.json()
  assert.equal(payload.code, 'REQUEST_INPUT_TOO_NOISY')
})

test('manual client request create rejects vague intake input from screening model', async () => {
  setRunCodexTurnForRequestScreeningTesting(async <T = unknown>() => ({
    threadId: null,
    finalResponse: '',
    parsedOutput: {
      verdict: 'needs_more_detail',
      reason: '요청이 너무 짧습니다.',
      confidence: 0.74,
    } as T,
  }))

  try {
    const app = new Hono()
    app.route('/api', clientRequestRoutes)

    const response = await app.request('http://localhost/api/client-requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requester: 'Manual User',
        title: '변경 요청',
        template: {
          problem: '좀 바꿔줘.',
          desiredOutcome: '좋아졌으면 좋겠다.',
          userScenarios: '사용자가 그냥 더 편했으면 한다.',
        },
        projectId: 'intentlane-codex',
        categoryId: 'feature',
      }),
    })

    assert.equal(response.status, 400)
    const payload = await response.json()
    assert.equal(payload.code, 'REQUEST_INPUT_TOO_VAGUE')
  } finally {
    resetRunCodexTurnForRequestScreeningTesting()
  }
})

test('create-ticket from client request maps the structured template into ticket description', async () => {
  stubValidRequestScreening()
  setRunCodexTurnForTesting(async () => {
    throw new Error('stop queued workflow in test')
  })

  try {
    const app = new Hono()
    app.route('/api', clientRequestRoutes)

    const createResponse = await app.request('http://localhost/api/client-requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requester: 'Manual User',
        title: 'Structured request',
        template: {
          problem: '사용자는 구조화된 요청을 티켓으로 넘기고 싶다.',
          desiredOutcome: 'request 템플릿이 ticket planning 입력으로 변환되어야 한다.',
          userScenarios: '운영자가 request에서 바로 ticket을 생성한다.',
          constraints: '기존 category flow를 유지한다.',
          nonGoals: 'Explain 단계에서 구현 계획을 작성하지 않는다.',
          openQuestions: '추가 정책 결정은 ticket planning에서 드러날 수 있다.',
        },
        projectId: 'intentlane-codex',
        categoryId: 'feature',
      }),
    })

    assert.equal(createResponse.status, 200)
    const request = await createResponse.json()

    const ticketResponse = await app.request(`http://localhost/api/client-requests/${request.id}/create-ticket`, {
      method: 'POST',
    })

    assert.equal(ticketResponse.status, 200)
    const payload = await ticketResponse.json()
    const ticket = getTicket(payload.ticket.id)

    assert.match(ticket?.description || '', /## Problem/)
    assert.match(ticket?.description || '', /## Desired Outcome/)
    assert.match(ticket?.description || '', /## User Scenarios/)
    assert.match(ticket?.description || '', /## Ticket Planning Notes/)
    assert.equal(getClientRequest(request.id)?.linkedTicketId, payload.ticket.id)

    deleteTicket(payload.ticket.id)
    deleteClientRequest(request.id)
  } finally {
    resetRunCodexTurnForTesting()
    resetRunCodexTurnForRequestScreeningTesting()
  }
})

test('direct ticket creation with linked request enforces request readiness and mapping', async () => {
  stubValidRequestScreening()
  setRunCodexTurnForTesting(async () => {
    throw new Error('stop queued workflow in test')
  })

  try {
    const app = new Hono()
    app.route('/api', clientRequestRoutes)
    app.route('/api', ticketRoutes)

    const createResponse = await app.request('http://localhost/api/client-requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requester: 'Manual User',
        title: 'Structured request via tickets route',
        template: {
          problem: 'request 링크로도 같은 매핑을 강제해야 한다.',
          desiredOutcome: 'linkedRequestId가 있으면 /tickets도 request mapping을 사용해야 한다.',
          userScenarios: '운영자가 내부 API로 직접 ticket 생성 요청을 보낸다.',
        },
        projectId: 'intentlane-codex',
        categoryId: 'feature',
      }),
    })

    assert.equal(createResponse.status, 200)
    const request = await createResponse.json()

    const ticketResponse = await app.request('http://localhost/api/tickets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'ignored',
        description: 'ignored',
        projectId: 'intentlane-codex',
        categoryId: 'feature',
        linkedRequestId: request.id,
      }),
    })

    assert.equal(ticketResponse.status, 200)
    const payload = await ticketResponse.json()
    const ticket = getTicket(payload.ticket.id)

    assert.equal(ticket?.title, request.title)
    assert.match(ticket?.description || '', /request 링크로도 같은 매핑을 강제해야 한다/)

    deleteTicket(payload.ticket.id)
    deleteClientRequest(request.id)
  } finally {
    resetRunCodexTurnForTesting()
    resetRunCodexTurnForRequestScreeningTesting()
  }
})

test('client request delete removes an unlinked request', async () => {
  stubValidRequestScreening()

  try {
    const app = new Hono()
    app.route('/api', clientRequestRoutes)

    const createResponse = await app.request('http://localhost/api/client-requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requester: 'Manual User',
        title: 'Delete me',
        template: {
          problem: '삭제 가능한 request가 필요하다.',
          desiredOutcome: 'request를 직접 제거할 수 있어야 한다.',
          userScenarios: '운영자가 requests 목록에서 삭제한다.',
        },
        projectId: 'intentlane-codex',
        categoryId: 'feature',
      }),
    })

    assert.equal(createResponse.status, 200)
    const request = await createResponse.json()

    const deleteResponse = await app.request(`http://localhost/api/client-requests/${request.id}`, {
      method: 'DELETE',
    })

    assert.equal(deleteResponse.status, 200)
    assert.equal(getClientRequest(request.id), undefined)
  } finally {
    resetRunCodexTurnForRequestScreeningTesting()
  }
})

test('client request list clears stale linked ticket ids when the ticket is missing', async () => {
  stubValidRequestScreening()

  try {
    const app = new Hono()
    app.route('/api', clientRequestRoutes)

    const createResponse = await app.request('http://localhost/api/client-requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requester: 'Manual User',
        title: 'Stale linked request',
        template: {
          problem: '삭제된 ticket id가 request에 남아 있을 수 있다.',
          desiredOutcome: 'requests 목록을 읽을 때 stale link를 자동 정리해야 한다.',
          userScenarios: '운영자가 requests 화면을 열었는데 이미 ticket은 사라진 상태다.',
        },
        projectId: 'intentlane-codex',
        categoryId: 'feature',
      }),
    })

    assert.equal(createResponse.status, 200)
    const request = await createResponse.json()

    linkRequestToTicket(request.id, 'TKT-stale-link')
    assert.equal(getClientRequest(request.id)?.linkedTicketId, 'TKT-stale-link')

    const listResponse = await app.request('http://localhost/api/client-requests?projectId=intentlane-codex')
    assert.equal(listResponse.status, 200)

    const requests = await listResponse.json()
    const refreshedRequest = requests.find((entry: { id: string }) => entry.id === request.id)

    assert.equal(refreshedRequest?.linkedTicketId, undefined)
    assert.equal(refreshedRequest?.status, 'new')
    assert.equal(getClientRequest(request.id)?.linkedTicketId, undefined)

    deleteClientRequest(request.id)
  } finally {
    resetRunCodexTurnForRequestScreeningTesting()
  }
})

test('client request delete ignores stale linked ticket ids when the ticket is missing', async () => {
  stubValidRequestScreening()

  try {
    const app = new Hono()
    app.route('/api', clientRequestRoutes)

    const createResponse = await app.request('http://localhost/api/client-requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requester: 'Manual User',
        title: 'Delete stale linked request',
        template: {
          problem: '없는 ticket id 때문에 request 삭제가 막히면 안 된다.',
          desiredOutcome: '실제 ticket이 없으면 request를 바로 삭제할 수 있어야 한다.',
          userScenarios: '운영자가 stale link가 붙은 request를 목록에서 제거한다.',
        },
        projectId: 'intentlane-codex',
        categoryId: 'feature',
      }),
    })

    assert.equal(createResponse.status, 200)
    const request = await createResponse.json()

    linkRequestToTicket(request.id, 'TKT-missing-before-delete')
    assert.equal(getClientRequest(request.id)?.linkedTicketId, 'TKT-missing-before-delete')

    const deleteResponse = await app.request(`http://localhost/api/client-requests/${request.id}`, {
      method: 'DELETE',
    })

    assert.equal(deleteResponse.status, 200)
    assert.equal(getClientRequest(request.id), undefined)
  } finally {
    resetRunCodexTurnForRequestScreeningTesting()
  }
})

test('client request delete refuses linked requests', async () => {
  stubValidRequestScreening()
  setRunCodexTurnForTesting(async () => {
    throw new Error('stop queued workflow in test')
  })

  try {
    const app = new Hono()
    app.route('/api', clientRequestRoutes)
    app.route('/api', ticketRoutes)

    const createResponse = await app.request('http://localhost/api/client-requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requester: 'Manual User',
        title: 'Linked request delete guard',
        template: {
          problem: 'linked request 삭제를 막아야 한다.',
          desiredOutcome: 'linked ticket가 있으면 request 삭제가 거절되어야 한다.',
          userScenarios: '운영자가 이미 ticket이 연결된 request를 삭제하려고 한다.',
        },
        projectId: 'intentlane-codex',
        categoryId: 'feature',
      }),
    })

    assert.equal(createResponse.status, 200)
    const request = await createResponse.json()

    const ticketResponse = await app.request(`http://localhost/api/client-requests/${request.id}/create-ticket`, {
      method: 'POST',
    })

    assert.equal(ticketResponse.status, 200)
    const payload = await ticketResponse.json()

    const deleteResponse = await app.request(`http://localhost/api/client-requests/${request.id}`, {
      method: 'DELETE',
    })

    assert.equal(deleteResponse.status, 400)
    assert.equal(getClientRequest(request.id)?.linkedTicketId, payload.ticket.id)

    deleteTicket(payload.ticket.id)
    deleteClientRequest(request.id)
  } finally {
    resetRunCodexTurnForTesting()
    resetRunCodexTurnForRequestScreeningTesting()
  }
})

test('ticket hard delete unlinks the linked client request', async () => {
  stubValidRequestScreening()
  setRunAutomaticTicketWorkflowForTesting(async () => {})

  try {
    const app = new Hono()
    app.route('/api', clientRequestRoutes)
    app.route('/api', ticketRoutes)

    const createResponse = await app.request('http://localhost/api/client-requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requester: 'Manual User',
        title: 'Linked request reset after ticket delete',
        template: {
          problem: 'ticket 삭제 후 request를 다시 사용할 수 있어야 한다.',
          desiredOutcome: 'ticket 삭제 시 linked request가 다시 new 상태가 되어야 한다.',
          userScenarios: '운영자가 잘못 만든 ticket을 지우고 같은 request로 다시 ticket을 만든다.',
        },
        projectId: 'intentlane-codex',
        categoryId: 'feature',
      }),
    })

    assert.equal(createResponse.status, 200)
    const request = await createResponse.json()

    const ticketResponse = await app.request(`http://localhost/api/client-requests/${request.id}/create-ticket`, {
      method: 'POST',
    })

    assert.equal(ticketResponse.status, 200)
    const payload = await ticketResponse.json()

    for (let attempt = 0; attempt < 20 && isTicketRunActive(payload.ticket.id); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    setTicketRunState(payload.ticket.id, 'failed')

    const deleteTicketResponse = await app.request(`http://localhost/api/tickets/${payload.ticket.id}`, {
      method: 'DELETE',
    })

    assert.equal(deleteTicketResponse.status, 200)
    assert.equal(getTicket(payload.ticket.id), undefined)
    assert.equal(getClientRequest(request.id)?.linkedTicketId, undefined)
    assert.equal(getClientRequest(request.id)?.status, 'new')

    deleteClientRequest(request.id)
  } finally {
    resetRunAutomaticTicketWorkflowForTesting()
    resetRunCodexTurnForTesting()
    resetRunCodexTurnForRequestScreeningTesting()
  }
})

test('ticket delete failure keeps the linked client request attached', async () => {
  stubValidRequestScreening()

  setRunAutomaticTicketWorkflowForTesting(
    (async ({ ticketId, signal }) => {
      updateStepStatus(ticketId, 'analyze', 'running')

      await new Promise<void>((_resolve, reject) => {
        const onAbort = () => {
          const error = new Error('Workflow aborted')
          error.name = 'AbortError'
          reject(error)
        }

        if (signal?.aborted) {
          onAbort()
          return
        }

        signal?.addEventListener('abort', onAbort, { once: true })
      })
    }) as Parameters<typeof setRunAutomaticTicketWorkflowForTesting>[0]
  )

  try {
    const app = new Hono()
    app.route('/api', clientRequestRoutes)
    app.route('/api', ticketRoutes)

    const createResponse = await app.request('http://localhost/api/client-requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requester: 'Manual User',
        title: 'Linked request must survive failed delete',
        template: {
          problem: '삭제가 실패하면 request unlink도 되면 안 된다.',
          desiredOutcome: 'ticket delete가 거절되면 linked request는 그대로 유지되어야 한다.',
          userScenarios: '운영자가 실행 중인 ticket 삭제를 시도한다.',
        },
        projectId: 'intentlane-codex',
        categoryId: 'feature',
      }),
    })

    assert.equal(createResponse.status, 200)
    const request = await createResponse.json()

    const ticketResponse = await app.request(`http://localhost/api/client-requests/${request.id}/create-ticket`, {
      method: 'POST',
    })

    assert.equal(ticketResponse.status, 200)
    const payload = await ticketResponse.json()
    await new Promise<void>((resolve) => queueMicrotask(resolve))

    const deleteResponse = await app.request(`http://localhost/api/tickets/${payload.ticket.id}`, {
      method: 'DELETE',
    })

    assert.equal(deleteResponse.status, 400)
    assert.equal(getClientRequest(request.id)?.linkedTicketId, payload.ticket.id)
    assert.ok(getTicket(payload.ticket.id))

    await stopTicketRun(payload.ticket.id)
    deleteTicket(payload.ticket.id)
    deleteClientRequest(request.id)
  } finally {
    resetRunAutomaticTicketWorkflowForTesting()
    resetRunCodexTurnForRequestScreeningTesting()
  }
})
