import test from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { ticketRoutes } from '../routes/tickets.js'
import {
  isTicketRunActive,
  queueTicketRun,
  resetRunAutomaticTicketWorkflowForTesting,
  setRunAutomaticTicketWorkflowForTesting,
  stopTicketRun,
} from '../services/ticket-runner.js'
import { createTicket, deleteTicket, getTicket, updateStepStatus } from '../services/tickets.js'

test('stopTicketRun aborts an active automatic run and marks the ticket as stopped', async () => {
  const ticket = createTicket({
    title: 'Stop run test',
    description: '사용자 요청으로 실행을 중단한다.',
    projectId: 'intentlane-codex',
    projectPath: process.cwd(),
    categoryId: 'feature',
    flowStepIds: ['analyze', 'plan', 'implement', 'verify', 'review', 'ready'],
  })

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
    assert.equal(queueTicketRun(ticket.id), true)
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    assert.equal(isTicketRunActive(ticket.id), true)

    await stopTicketRun(ticket.id)

    const updated = getTicket(ticket.id)
    assert.equal(isTicketRunActive(ticket.id), false)
    assert.equal(updated?.status, 'stopped')
    assert.equal(updated?.runState, 'stopped')
    assert.equal(updated?.currentPhase, 'analyze')
    assert.equal(updated?.steps.analyze?.status, 'failed')
    assert.match(updated?.timeline.at(-1)?.title || '', /사용자 요청으로 자동 실행을 중단했습니다\./)
  } finally {
    resetRunAutomaticTicketWorkflowForTesting()
    deleteTicket(ticket.id)
  }
})

test('stopTicketRun rejects when the ticket is not currently running', async () => {
  const ticket = createTicket({
    title: 'Stop idle run test',
    description: '실행 중이 아닐 때 중단 요청을 거절한다.',
    projectId: 'intentlane-codex',
    projectPath: process.cwd(),
    categoryId: 'feature',
    flowStepIds: ['analyze', 'plan', 'implement', 'verify', 'review', 'ready'],
  })

  try {
    await assert.rejects(stopTicketRun(ticket.id), /Ticket is not running/)
  } finally {
    deleteTicket(ticket.id)
  }
})

test('ticket stop route stops an active automatic run', async () => {
  const ticket = createTicket({
    title: 'Stop route test',
    description: 'stop endpoint가 실행 중인 티켓을 중단한다.',
    projectId: 'intentlane-codex',
    projectPath: process.cwd(),
    categoryId: 'feature',
    flowStepIds: ['analyze', 'plan', 'implement', 'verify', 'review', 'ready'],
  })

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
    assert.equal(queueTicketRun(ticket.id), true)
    await new Promise<void>((resolve) => queueMicrotask(resolve))

    const app = new Hono()
    app.route('/api', ticketRoutes)

    const response = await app.request(`http://localhost/api/tickets/${ticket.id}/stop`, {
      method: 'POST',
    })

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { ok: true })
    assert.equal(getTicket(ticket.id)?.runState, 'stopped')
  } finally {
    resetRunAutomaticTicketWorkflowForTesting()
    deleteTicket(ticket.id)
  }
})

test('ticket retry route requires an explicit option when review recovery has multiple choices', async () => {
  const ticket = createTicket({
    title: 'Retry choice route test',
    description: 'review recovery requires explicit choice.',
    projectId: 'intentlane-codex',
    projectPath: process.cwd(),
    categoryId: 'feature',
    flowStepIds: ['analyze', 'plan', 'implement', 'verify', 'review', 'ready'],
  })

  try {
    updateStepStatus(ticket.id, 'implement', 'done')
    updateStepStatus(ticket.id, 'review', 'failed')
    const { setTicketCurrentPhase, setTicketPlanningBlock, setTicketRunState } = await import('../services/tickets.js')
    setTicketRunState(ticket.id, 'needs_decision')
    setTicketCurrentPhase(ticket.id, 'review')
    setTicketPlanningBlock(ticket.id, {
      kind: 'needs_decision',
      source: 'review',
      summary: '구현 재시도와 계획 재시작 중 선택이 필요합니다.',
      findings: ['두 경로 모두 가능'],
      options: [
        {
          id: 'review-retry-implement',
          label: '같은 run으로 구현만 다시 시도',
          startStepId: 'implement',
          executionMode: 'same_run',
          sessionMode: 'reuse_thread',
        },
        {
          id: 'review-restart-plan',
          label: '새 run으로 계획부터 다시 시작',
          startStepId: 'plan',
          executionMode: 'new_run',
          sessionMode: 'new_thread',
        },
      ],
    })

    const app = new Hono()
    app.route('/api', ticketRoutes)

    const response = await app.request(`http://localhost/api/tickets/${ticket.id}/retry`, {
      method: 'POST',
    })

    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), {
      error: 'Retry option must be selected',
      code: 'RETRY_FAILED',
    })
  } finally {
    deleteTicket(ticket.id)
  }
})

test('ticket retry route requires clarification text for request-clarification tickets', async () => {
  const ticket = createTicket({
    title: 'Clarification required route test',
    description: '추가 설명이 필요한 티켓',
    projectId: 'intentlane-codex',
    projectPath: process.cwd(),
    categoryId: 'feature',
    flowStepIds: ['analyze', 'plan', 'implement', 'verify', 'review', 'ready'],
  })

  try {
    const { setTicketCurrentPhase, setTicketPlanningBlock, setTicketRunState } = await import('../services/tickets.js')
    setTicketRunState(ticket.id, 'needs_request_clarification')
    setTicketCurrentPhase(ticket.id, 'plan')
    setTicketPlanningBlock(ticket.id, {
      kind: 'needs_request_clarification',
      source: 'review',
      summary: '어떤 API를 추가해야 하는지 보완 설명이 필요합니다.',
      findings: ['추가하려는 API 목적과 형태가 빠져 있습니다.'],
      options: [
        {
          id: 'clarification-restart-plan',
          label: '보완 후 계획부터 다시 시작',
          startStepId: 'plan',
          executionMode: 'new_run',
          sessionMode: 'new_thread',
        },
      ],
    })

    const app = new Hono()
    app.route('/api', ticketRoutes)

    const response = await app.request(`http://localhost/api/tickets/${ticket.id}/retry`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    })

    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), {
      error: 'Clarification text is required',
      code: 'RETRY_FAILED',
    })
  } finally {
    deleteTicket(ticket.id)
  }
})

test('ticket retry route appends clarification text before restarting the workflow', async () => {
  const ticket = createTicket({
    title: 'Clarification retry route test',
    description: '초기 티켓 설명',
    projectId: 'intentlane-codex',
    projectPath: process.cwd(),
    categoryId: 'feature',
    flowStepIds: ['analyze', 'plan', 'implement', 'verify', 'review', 'ready'],
  })

  setRunAutomaticTicketWorkflowForTesting(
    (async () => {
      return
    }) as Parameters<typeof setRunAutomaticTicketWorkflowForTesting>[0]
  )

  try {
    const { setTicketCurrentPhase, setTicketPlanningBlock, setTicketRunState } = await import('../services/tickets.js')
    setTicketRunState(ticket.id, 'needs_request_clarification')
    setTicketCurrentPhase(ticket.id, 'plan')
    setTicketPlanningBlock(ticket.id, {
      kind: 'needs_request_clarification',
      source: 'review',
      summary: '어떤 API를 추가해야 하는지 보완 설명이 필요합니다.',
      findings: ['추가하려는 API 목적과 형태가 빠져 있습니다.'],
      options: [
        {
          id: 'clarification-restart-plan',
          label: '보완 후 계획부터 다시 시작',
          startStepId: 'plan',
          executionMode: 'new_run',
          sessionMode: 'new_thread',
        },
      ],
    })

    const app = new Hono()
    app.route('/api', ticketRoutes)

    const response = await app.request(`http://localhost/api/tickets/${ticket.id}/retry`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        clarification: 'terms 관련 API는 사용자용 추천 엔드포인트 위주로 먼저 제안해 주세요.',
      }),
    })

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { ok: true })

    await new Promise<void>((resolve) => queueMicrotask(resolve))

    const updated = getTicket(ticket.id)
    assert.match(updated?.description ?? '', /사용자 보완 답변/)
    assert.match(
      updated?.description ?? '',
      /terms 관련 API는 사용자용 추천 엔드포인트 위주로 먼저 제안해 주세요\./
    )
    assert.equal(updated?.timeline.some((entry) => entry.title === '사용자 보완 답변이 추가되었습니다.'), true)
    assert.equal(updated?.timeline.some((entry) => entry.title === 'Retry 요청으로 실행 상태를 초기화했습니다.'), true)
    assert.equal(updated?.timeline.at(-1)?.title, '자동 실행 대기열에 등록되었습니다.')
  } finally {
    resetRunAutomaticTicketWorkflowForTesting()
    deleteTicket(ticket.id)
  }
})

test('ticket delete route rejects active automatic runs', async () => {
  const ticket = createTicket({
    title: 'Delete active run test',
    description: '실행 중인 티켓 삭제를 막아야 한다.',
    projectId: 'intentlane-codex',
    projectPath: process.cwd(),
    categoryId: 'feature',
    flowStepIds: ['analyze', 'plan', 'implement', 'verify', 'review', 'ready'],
  })

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
    assert.equal(queueTicketRun(ticket.id), true)
    await new Promise<void>((resolve) => queueMicrotask(resolve))

    const app = new Hono()
    app.route('/api', ticketRoutes)

    const response = await app.request(`http://localhost/api/tickets/${ticket.id}`, {
      method: 'DELETE',
    })

    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), {
      error: 'Ticket is already running',
      code: 'DELETE_FAILED',
    })
    assert.ok(getTicket(ticket.id))
  } finally {
    await stopTicketRun(ticket.id)
    resetRunAutomaticTicketWorkflowForTesting()
    deleteTicket(ticket.id)
  }
})
