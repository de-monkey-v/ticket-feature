import test from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { incidentRoutes } from '../routes/incidents.js'
import {
  resetRunCodexTurnForIncidentAnalysisTesting,
  setRunCodexTurnForIncidentAnalysisTesting,
} from '../services/incident-analysis.js'
import {
  resetIncidentAutoResolutionEnabledForTesting,
  resolveIncidentAutomatically,
  setIncidentAutoResolutionEnabledForTesting,
} from '../services/incident-resolution.js'
import {
  createTicketIncident,
  deleteIncident,
  listIncidents,
  toPublicIncidentDetail,
} from '../services/incidents.js'
import {
  resetTicketSelfHealingEnabledForTesting,
  resetRunCodexTurnForTesting,
  runTicketWorkflow,
  setTicketSelfHealingEnabledForTesting,
  setRunCodexTurnForTesting,
} from '../services/ticket-orchestrator.js'
import {
  isTicketRunActive,
  queueTicketRun,
  resetRunAutomaticTicketWorkflowForTesting,
  setRunAutomaticTicketWorkflowForTesting,
} from '../services/ticket-runner.js'
import {
  getTicket,
  appendReviewRun,
  appendStageReview,
  appendTimelineEvent,
  appendVerificationRun,
  createTicket,
  deleteTicket,
  replaceStepOutput,
  setTicketWorktree,
  type GoalAssessment,
} from '../services/tickets.js'

function cleanupIncidents(ticketId: string, projectId = 'intentlane-codex') {
  for (const incident of listIncidents(projectId, ticketId)) {
    deleteIncident(incident.id)
  }
}

async function waitFor(assertion: () => boolean, timeoutMs = 1_000) {
  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    if (assertion()) {
      return
    }

    await new Promise<void>((resolve) => setTimeout(resolve, 10))
  }

  throw new Error('Timed out waiting for condition')
}

function makeGoalAssessment(): GoalAssessment {
  return {
    request: { status: 'aligned', evidence: [] },
    ticket: { status: 'aligned', evidence: [] },
    acceptanceCriteria: [],
  }
}

function makeStubbedTurnRunner(responses: unknown[]) {
  return async () => {
    const response = responses.shift()
    if (!response) {
      throw new Error('No stubbed Codex response left')
    }

    return {
      threadId: 'thread-incident-test',
      finalResponse: JSON.stringify(response),
      parsedOutput: response,
    }
  }
}

test('incident detail hides local paths and raw verification commands', () => {
  const projectPath = '/tmp/private-project'
  const worktreePath = '/tmp/private-project/.worktrees/ticket-123'
  const ticket = createTicket({
    title: 'Incident serialization test',
    description: `사용자에게 ${projectPath} 와 ${worktreePath} 를 노출하면 안 된다.`,
    projectId: 'intentlane-codex',
    projectPath,
    categoryId: 'feature',
    flowStepIds: ['analyze', 'plan', 'implement', 'verify', 'review', 'ready'],
  })
  const now = new Date().toISOString()

  try {
    replaceStepOutput(ticket.id, 'implement', `실패 로그: ${projectPath}\nworktree: ${worktreePath}`)
    appendVerificationRun(ticket.id, {
      attempt: 1,
      status: 'failed',
      startedAt: now,
      completedAt: now,
      commands: [
        {
          id: 'verify-1',
          label: 'Typecheck',
          command: 'pnpm secret:test',
          stage: 'project',
          required: true,
          status: 'failed',
          output: `ENOENT at ${worktreePath}\nrepo=${projectPath}`,
          exitCode: 1,
          durationMs: 321,
          startedAt: now,
          completedAt: now,
        },
      ],
    })
    appendReviewRun(ticket.id, {
      attempt: 1,
      verdict: 'fail',
      summary: `리뷰가 ${projectPath} 참조를 발견했다.`,
      goalAssessment: makeGoalAssessment(),
      blockingFindings: [`민감한 경로 ${worktreePath} 노출`],
      residualRisks: [],
      releaseNotes: [],
      output: `검토 출력: ${projectPath}\n${worktreePath}`,
      startedAt: now,
      completedAt: now,
    })
    appendStageReview(ticket.id, {
      id: 'stage-review-1',
      subjectStepId: 'plan',
      label: '계획',
      attempt: 1,
      verdict: 'fail',
      summary: `${projectPath} 를 제거해야 한다.`,
      blockingFindings: [`${worktreePath} 노출`],
      residualRisks: [],
      output: `${projectPath}\n${worktreePath}`,
      startedAt: now,
      completedAt: now,
    })
    appendTimelineEvent(ticket.id, {
      type: 'system',
      title: '민감한 경로를 포함한 로그가 기록되었습니다.',
      body: `${projectPath}\n${worktreePath}`,
    })
    setTicketWorktree(ticket.id, {
      branchName: 'tickets/test-branch',
      baseBranch: 'main',
      baseCommit: 'abc123',
      worktreePath,
      diffSummary: `diff path: ${projectPath}\nwt path: ${worktreePath}`,
      status: 'ready',
      createdAt: now,
      updatedAt: now,
    })

    const incident = createTicketIncident(ticket.id, {
      kind: 'verify_failed',
      message: `검증 실패: ${worktreePath}`,
      phase: 'verify',
      attempt: 1,
    })
    const detail = toPublicIncidentDetail(incident)
    const serialized = JSON.stringify(detail)

    assert.equal('projectPath' in detail.bundle.ticket, false)
    assert.equal('threadId' in detail.bundle.ticket, false)
    assert.equal(detail.bundle.worktree && 'worktreePath' in detail.bundle.worktree, false)
    assert.equal(serialized.includes(projectPath), false)
    assert.equal(serialized.includes(worktreePath), false)
    assert.equal(serialized.includes('pnpm secret:test'), false)
    assert.match(detail.trigger.message, /\[worktree\]/)
    assert.match(detail.bundle.steps[0]?.outputExcerpt ?? '', /\[worktree\]/)
    assert.match(detail.bundle.verificationRuns[0]?.commands[0]?.outputExcerpt ?? '', /\[worktree\]/)
    assert.match(detail.bundle.worktree?.diffSummaryExcerpt ?? '', /\[worktree\]/)
  } finally {
    cleanupIncidents(ticket.id)
    deleteTicket(ticket.id)
  }
})

test('incident routes list detail analyze and delete incidents', async () => {
  const ticket = createTicket({
    title: 'Incident route test',
    description: 'incident routes를 검증한다.',
    projectId: 'intentlane-codex',
    projectPath: process.cwd(),
    categoryId: 'feature',
    flowStepIds: ['analyze', 'plan', 'implement', 'verify', 'review', 'ready'],
  })
  const incident = createTicketIncident(ticket.id, {
    kind: 'runner_exception',
    message: 'Unexpected workflow failure',
    phase: 'implement',
    attempt: 2,
  })

  setRunCodexTurnForIncidentAnalysisTesting(
    (async () => ({
      threadId: 'incident-analysis-thread',
      finalResponse: '{}',
      parsedOutput: {
        summary: '분석 요약',
        likelyRootCause: '테스트용 원인',
        evidence: ['증거 1'],
        impactedAreas: ['src/server/services/ticket-runner.ts'],
        nextActions: ['로그 보강'],
        missingSignals: [],
        confidence: 'medium',
        recommendedAction: {
          type: 'manual_intervention',
          startStepId: null,
          rationale: 'runner 예외는 자동 재실행보다 로그 보강이 먼저다.',
        },
        resolution: {
          type: 'manual_intervention',
          startStepId: null,
          rationale: 'runner 예외는 자동 재실행보다 로그 보강이 먼저다.',
        },
      },
    })) as Parameters<typeof setRunCodexTurnForIncidentAnalysisTesting>[0]
  )

  try {
    const app = new Hono()
    app.route('/api', incidentRoutes)

    const listResponse = await app.request(
      `http://localhost/api/incidents?projectId=intentlane-codex&ticketId=${ticket.id}`
    )
    assert.equal(listResponse.status, 200)
    const listPayload = await listResponse.json()
    assert.ok(Array.isArray(listPayload))
    assert.ok(listPayload.some((entry) => entry.id === incident.id))

    const detailResponse = await app.request(`http://localhost/api/incidents/${incident.id}`)
    assert.equal(detailResponse.status, 200)
    const detailPayload = await detailResponse.json()
    assert.equal(detailPayload.id, incident.id)
    assert.equal(detailPayload.analysis, undefined)

    const analyzeResponse = await app.request(`http://localhost/api/incidents/${incident.id}/analyze`, {
      method: 'POST',
    })
    assert.equal(analyzeResponse.status, 200)
    const analyzePayload = await analyzeResponse.json()
    assert.equal(analyzePayload.status, 'analyzed')
    assert.equal(analyzePayload.analysis.summary, '분석 요약')
    assert.equal(analyzePayload.analysis.likelyRootCause, '테스트용 원인')

    const deleteResponse = await app.request(`http://localhost/api/incidents/${incident.id}`, {
      method: 'DELETE',
    })
    assert.equal(deleteResponse.status, 200)
    assert.deepEqual(await deleteResponse.json(), { ok: true })

    const missingResponse = await app.request(`http://localhost/api/incidents/${incident.id}`)
    assert.equal(missingResponse.status, 404)
  } finally {
    resetRunCodexTurnForIncidentAnalysisTesting()
    cleanupIncidents(ticket.id)
    deleteTicket(ticket.id)
  }
})

test('runTicketWorkflow captures a final analyze failure as an incident', async () => {
  const ticket = createTicket({
    title: 'Analyze failure incident test',
    description: '분석 단계 최종 실패를 incident로 남긴다.',
    projectId: 'intentlane-codex',
    projectPath: process.cwd(),
    categoryId: 'feature',
    flowStepIds: ['analyze', 'plan', 'implement', 'verify', 'review', 'ready'],
  })

  setRunCodexTurnForTesting(
    makeStubbedTurnRunner([
      { summary: '분석 1', affectedAreas: [], risks: [], proposedChecks: ['pnpm typecheck'] },
      { verdict: 'fail', summary: '분석 미흡 1', blockingFindings: ['증거 부족'], residualRisks: [] },
      { summary: '분석 2', affectedAreas: [], risks: [], proposedChecks: ['pnpm typecheck'] },
      { verdict: 'fail', summary: '분석 미흡 2', blockingFindings: ['증거 부족'], residualRisks: [] },
      { summary: '분석 3', affectedAreas: [], risks: [], proposedChecks: ['pnpm typecheck'] },
      { verdict: 'fail', summary: '분석 미흡 3', blockingFindings: ['증거 부족'], residualRisks: [] },
    ]) as Parameters<typeof setRunCodexTurnForTesting>[0]
  )

  try {
    setIncidentAutoResolutionEnabledForTesting(false)

    setTicketSelfHealingEnabledForTesting(false)

    await runTicketWorkflow({
      ticketId: ticket.id,
      stepId: 'analyze',
    })

    const incidents = listIncidents(ticket.projectId, ticket.id)
    const incident = incidents.find((entry) => entry.trigger.kind === 'analyze_failed')

    assert.ok(incident)
    assert.equal(incident?.trigger.phase, 'analyze')
    assert.equal(incident?.trigger.attempt, 3)
    assert.match(incident?.trigger.message ?? '', /증거 부족/)
  } finally {
    resetIncidentAutoResolutionEnabledForTesting()
    resetTicketSelfHealingEnabledForTesting()
    resetRunCodexTurnForTesting()
    cleanupIncidents(ticket.id)
    deleteTicket(ticket.id)
  }
})

test('queueTicketRun captures unexpected runner exceptions as incidents', async () => {
  const ticket = createTicket({
    title: 'Runner exception incident test',
    description: '자동 실행 예외를 incident로 남긴다.',
    projectId: 'intentlane-codex',
    projectPath: process.cwd(),
    categoryId: 'feature',
    flowStepIds: ['analyze', 'plan', 'implement', 'verify', 'review', 'ready'],
  })

  setRunAutomaticTicketWorkflowForTesting(
    (async () => {
      throw new Error('Unexpected runner failure')
    }) as Parameters<typeof setRunAutomaticTicketWorkflowForTesting>[0]
  )

  try {
    setIncidentAutoResolutionEnabledForTesting(false)

    assert.equal(queueTicketRun(ticket.id), true)

    await waitFor(
      () =>
        listIncidents(ticket.projectId, ticket.id).some((entry) => entry.trigger.kind === 'runner_exception') &&
        !isTicketRunActive(ticket.id) &&
        getTicket(ticket.id)?.runState === 'failed'
    )

    const incident = listIncidents(ticket.projectId, ticket.id).find((entry) => entry.trigger.kind === 'runner_exception')
    const updatedTicket = getTicket(ticket.id)

    assert.ok(incident)
    assert.equal(incident?.trigger.phase, 'analyze')
    assert.match(incident?.trigger.message ?? '', /Unexpected runner failure/)
    assert.equal(updatedTicket?.runState, 'failed')
  } finally {
    resetIncidentAutoResolutionEnabledForTesting()
    resetRunAutomaticTicketWorkflowForTesting()
    cleanupIncidents(ticket.id)
    deleteTicket(ticket.id)
  }
})

test('resolveIncidentAutomatically queues a retry when incident analysis recommends retry_ticket', async () => {
  const ticket = createTicket({
    title: 'Incident auto retry test',
    description: 'incident 분석 결과로 새 run 재시작을 검증한다.',
    projectId: 'intentlane-codex',
    projectPath: process.cwd(),
    categoryId: 'feature',
    flowStepIds: ['analyze', 'plan', 'implement', 'verify', 'review', 'ready'],
  })

  setRunCodexTurnForIncidentAnalysisTesting(
    (async () => ({
      threadId: 'incident-auto-retry-thread',
      finalResponse: '{}',
      parsedOutput: {
        summary: '구현 보완 후 다시 시도하면 수렴 가능하다.',
        likelyRootCause: '검증 실패가 구현 누락에서 발생했다.',
        evidence: ['verify 로그에 구현 누락이 보인다.'],
        impactedAreas: ['src/server/services/ticket-orchestrator.ts'],
        nextActions: ['구현을 보완하고 implement부터 다시 시작한다.'],
        missingSignals: [],
        confidence: 'high',
        recommendedAction: {
          type: 'rerun_from_step',
          startStepId: 'implement',
          rationale: '구현 보완 이슈라 implement부터 새 run을 시작하면 된다.',
        },
        resolution: {
          type: 'retry_ticket',
          startStepId: 'implement',
          rationale: '새 run의 implement부터 다시 시작하는 것이 가장 짧다.',
        },
      },
    })) as Parameters<typeof setRunCodexTurnForIncidentAnalysisTesting>[0]
  )

  try {
    const incident = createTicketIncident(ticket.id, {
      kind: 'verify_failed',
      message: '테스트 실패',
      phase: 'verify',
      attempt: 1,
    })

    await resolveIncidentAutomatically(incident.id)

    const updatedIncident = listIncidents(ticket.projectId, ticket.id).find((entry) => entry.id === incident.id)
    const updatedTicket = getTicket(ticket.id)

    assert.equal(updatedIncident?.status, 'analyzed')
    assert.equal(updatedIncident?.resolution?.status, 'completed')
    assert.equal(updatedIncident?.resolution?.actionType, 'retry_ticket')
    assert.equal(updatedIncident?.resolution?.startStepId, 'implement')
    assert.match(updatedIncident?.resolution?.message ?? '', /자동 재시도를 시작했습니다/)
    assert.equal(updatedTicket?.queuedExecution?.startStepId, 'implement')
    assert.equal(updatedTicket?.queuedExecution?.recoveryNotes, '새 run의 implement부터 다시 시작하는 것이 가장 짧다.')
    assert.equal(updatedTicket?.runState, 'queued')
    assert.equal(updatedTicket?.status, 'queued')
  } finally {
    resetRunCodexTurnForIncidentAnalysisTesting()
    cleanupIncidents(ticket.id)
    deleteTicket(ticket.id)
  }
})

test('resolveIncidentAutomatically keeps clarification guidance on the incident without mutating the ticket', async () => {
  const ticket = createTicket({
    title: 'Incident clarification resolution test',
    description: 'incident 분석 결과를 planning block으로 연결한다.',
    projectId: 'intentlane-codex',
    projectPath: process.cwd(),
    categoryId: 'feature',
    flowStepIds: ['analyze', 'plan', 'implement', 'verify', 'review', 'ready'],
  })

  setRunCodexTurnForIncidentAnalysisTesting(
    (async () => ({
      threadId: 'incident-clarification-thread',
      finalResponse: '{}',
      parsedOutput: {
        summary: '리뷰 결과만으로는 요구사항이 충분히 명확하지 않다.',
        likelyRootCause: '요구사항 설명이 모호해 구현 방향을 확정하기 어렵다.',
        evidence: ['리뷰 피드백에 추가 시나리오 확인이 필요하다고 적혀 있다.'],
        impactedAreas: ['요구사항', '계획'],
        nextActions: ['사용자 시나리오를 보완한 뒤 계획부터 다시 시작한다.'],
        missingSignals: ['엣지 케이스 정의'],
        confidence: 'medium',
        recommendedAction: {
          type: 'manual_intervention',
          startStepId: 'plan',
          rationale: '요구사항을 보완한 뒤 plan부터 다시 시작해야 한다.',
        },
        resolution: {
          type: 'needs_request_clarification',
          startStepId: 'plan',
          rationale: '요구사항을 보완한 뒤 plan부터 다시 시작하게 해야 한다.',
        },
      },
    })) as Parameters<typeof setRunCodexTurnForIncidentAnalysisTesting>[0]
  )

  try {
    const incident = createTicketIncident(ticket.id, {
      kind: 'review_failed',
      message: '추가 요구사항 확인 필요',
      phase: 'review',
      attempt: 2,
    })

    await resolveIncidentAutomatically(incident.id)

    const updatedIncident = listIncidents(ticket.projectId, ticket.id).find((entry) => entry.id === incident.id)
    const updatedTicket = getTicket(ticket.id)

    assert.equal(updatedIncident?.resolution?.status, 'completed')
    assert.equal(updatedIncident?.resolution?.actionType, 'needs_request_clarification')
    assert.equal(updatedIncident?.resolution?.startStepId, 'plan')
    assert.equal(updatedTicket?.runState, 'created')
    assert.equal(updatedTicket?.planningBlock, undefined)
  } finally {
    resetRunCodexTurnForIncidentAnalysisTesting()
    cleanupIncidents(ticket.id)
    deleteTicket(ticket.id)
  }
})
