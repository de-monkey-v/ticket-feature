import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RUNTIME_DATA_DIR_ENV, resolveRuntimeDataPath } from '../lib/runtime-data-paths.js'
import {
  appendTicketClarification,
  appendTimelineEvent,
  appendVerificationRun,
  appendStepOutput,
  appendStageReview,
  approveStep,
  createTicket,
  deleteTicket,
  emitTicketEvent,
  getNextStep,
  getTicket,
  listTickets,
  markRecoverableTicketsFromStartup,
  prepareTicketForRetry,
  readTicketEventJournal,
  rejectStep,
  reloadTicketsFromDisk,
  setTicketAttemptCount,
  setTicketCoordinatorThreadId,
  setTicketCurrentPhase,
  setTicketImplementationThreadId,
  setTicketPlanningBlock,
  setTicketPlanningThreadId,
  setTicketRunState,
  setTicketWorktree,
  toPublicTicketRun,
  updateStepStatus,
} from '../services/tickets.js'

test('approve step becomes first-class gate before implement', () => {
  const ticket = createTicket({
    title: 'Approval flow test',
    description: 'Verify explicit approve step',
    projectId: 'intentlane-codex',
    projectPath: '/tmp/intentlane-codex',
    categoryId: 'feature',
    flowStepIds: ['analyze', 'plan', 'approve', 'implement', 'review', 'ready'],
  })

  try {
    updateStepStatus(ticket.id, 'plan', 'done')
    updateStepStatus(ticket.id, 'approve', 'awaiting_approval')

    assert.equal(approveStep(ticket.id, 'approve'), true)
    assert.equal(getNextStep(ticket.id, 'approve', ticket.flowStepIds), 'implement')

    const updated = getTicket(ticket.id)
    assert.equal(updated?.steps.approve?.status, 'approved')
    assert.match(updated?.steps.approve?.output || '', /승인되었습니다\./)
  } finally {
    deleteTicket(ticket.id)
  }
})

test('reject step records rejection reason on explicit approve step', () => {
  const ticket = createTicket({
    title: 'Approval rejection test',
    description: 'Verify explicit approve rejection',
    projectId: 'intentlane-codex',
    projectPath: '/tmp/intentlane-codex',
    categoryId: 'feature',
    flowStepIds: ['analyze', 'plan', 'approve', 'implement', 'review', 'ready'],
  })

  try {
    updateStepStatus(ticket.id, 'plan', 'done')
    updateStepStatus(ticket.id, 'approve', 'awaiting_approval')

    assert.equal(rejectStep(ticket.id, 'approve', '계획 수정 필요'), true)

    const updated = getTicket(ticket.id)
    assert.equal(updated?.steps.approve?.status, 'rejected')
    assert.match(updated?.steps.approve?.output || '', /계획 수정 필요/)
  } finally {
    deleteTicket(ticket.id)
  }
})

test('prepareTicketForRetry resumes from implement when analyze and plan reviews already passed', () => {
  const ticket = createTicket({
    title: 'Retry flow test',
    description: 'Retry should resume from implement safely',
    projectId: 'intentlane-codex',
    projectPath: '/tmp/intentlane-codex',
    categoryId: 'feature',
    flowStepIds: ['analyze', 'plan', 'implement', 'verify', 'review', 'ready'],
  })

  try {
    updateStepStatus(ticket.id, 'analyze', 'done')
    updateStepStatus(ticket.id, 'plan', 'done')
    updateStepStatus(ticket.id, 'implement', 'failed')
    setTicketRunState(ticket.id, 'needs_decision')
    setTicketCurrentPhase(ticket.id, 'review')
    setTicketPlanningBlock(ticket.id, {
      kind: 'needs_decision',
      source: 'plan_review',
      summary: '정책 결정 필요',
      findings: ['입력 오류 정책 결정 필요'],
    })

    appendStageReview(ticket.id, {
      id: 'analyze-review-1',
      subjectStepId: 'analyze',
      label: '분석',
      attempt: 1,
      verdict: 'pass',
      summary: '분석 통과',
      blockingFindings: [],
      residualRisks: [],
      output: '분석 통과',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    })
    appendStageReview(ticket.id, {
      id: 'plan-review-1',
      subjectStepId: 'plan',
      label: '계획',
      attempt: 1,
      verdict: 'pass',
      summary: '계획 통과',
      blockingFindings: [],
      residualRisks: [],
      output: '계획 통과',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    })

    const reset = prepareTicketForRetry(ticket.id)
    assert.deepEqual(reset, {
      id: 'default-retry',
      label: '마지막 안전 지점부터 다시 시작',
      startStepId: 'implement',
      executionMode: 'same_run',
      sessionMode: 'reuse_thread',
      shouldCleanupWorktree: false,
    })

    const updated = getTicket(ticket.id)
    assert.equal(updated?.runState, 'created')
    assert.equal(updated?.currentPhase, 'implement')
    assert.equal(updated?.planningBlock, undefined)
    assert.equal(updated?.steps.plan?.status, 'done')
    assert.equal(updated?.steps.implement?.status, 'pending')
    assert.equal(updated?.steps.verify?.status, 'pending')
    assert.equal(updated?.steps.review?.status, 'pending')
    assert.equal(updated?.steps.ready?.status, 'pending')
  } finally {
    deleteTicket(ticket.id)
  }
})

test('ticket persistence preserves an externally requested stop while the run is still active', () => {
  const previousDataDir = process.env[RUNTIME_DATA_DIR_ENV]
  const tempDir = mkdtempSync(join(tmpdir(), 'intentlane-codex-stop-request-test-'))
  process.env[RUNTIME_DATA_DIR_ENV] = tempDir

  const ticket = createTicket({
    title: 'Stop request persistence test',
    description: '외부 프로세스가 기록한 stop 요청이 worker 저장으로 사라지면 안 된다.',
    projectId: 'intentlane-codex',
    projectPath: '/tmp/intentlane-codex',
    categoryId: 'feature',
    flowStepIds: ['analyze', 'plan', 'implement', 'verify', 'review', 'ready'],
  })

  try {
    updateStepStatus(ticket.id, 'analyze', 'running')

    const summaryPath = resolveRuntimeDataPath('tickets', ticket.projectId, ticket.id, 'ticket.json')
    const persisted = JSON.parse(readFileSync(summaryPath, 'utf-8')) as { stopRequestedAt?: string }
    persisted.stopRequestedAt = '2026-03-31T00:00:00.000Z'
    writeFileSync(summaryPath, JSON.stringify(persisted, null, 2), 'utf-8')

    assert.equal(getTicket(ticket.id)?.stopRequestedAt, undefined)

    appendStepOutput(ticket.id, 'analyze', 'still streaming')

    const refreshed = JSON.parse(readFileSync(summaryPath, 'utf-8')) as { stopRequestedAt?: string }
    assert.equal(refreshed.stopRequestedAt, '2026-03-31T00:00:00.000Z')
  } finally {
    deleteTicket(ticket.id)

    if (previousDataDir === undefined) {
      delete process.env[RUNTIME_DATA_DIR_ENV]
    } else {
      process.env[RUNTIME_DATA_DIR_ENV] = previousDataDir
    }

    rmSync(tempDir, { recursive: true, force: true })
  }
})

test('prepareTicketForRetry can resume review recovery in the same run and preserve implementation thread context', () => {
  const ticket = createTicket({
    title: 'Review same-run retry test',
    description: 'Review decision should allow same-run implement retry.',
    projectId: 'intentlane-codex',
    projectPath: '/tmp/intentlane-codex',
    categoryId: 'feature',
    flowStepIds: ['analyze', 'plan', 'implement', 'verify', 'review', 'ready'],
  })

  try {
    updateStepStatus(ticket.id, 'analyze', 'done')
    updateStepStatus(ticket.id, 'plan', 'done')
    updateStepStatus(ticket.id, 'implement', 'done')
    updateStepStatus(ticket.id, 'review', 'failed')
    setTicketRunState(ticket.id, 'needs_decision')
    setTicketCurrentPhase(ticket.id, 'review')
    setTicketAttemptCount(ticket.id, 2)
    setTicketPlanningThreadId(ticket.id, 'thread-plan')
    setTicketImplementationThreadId(ticket.id, 'thread-review')
    setTicketCoordinatorThreadId(ticket.id, 'thread-coordinator')
    setTicketPlanningBlock(ticket.id, {
      kind: 'needs_decision',
      source: 'review',
      summary: '구현 보완과 계획 재정렬 중 선택이 필요합니다.',
      findings: ['구현 수정으로 해결할 수도 있고 계획을 다시 잡을 수도 있습니다.'],
      options: [
        {
          id: 'review-retry-implement',
          label: '같은 run으로 구현만 다시 시도',
          startStepId: 'implement',
          executionMode: 'same_run',
          sessionMode: 'reuse_thread',
        },
      ],
    })

    const reset = prepareTicketForRetry(ticket.id)
    assert.deepEqual(reset, {
      id: 'review-retry-implement',
      label: '같은 run으로 구현만 다시 시도',
      startStepId: 'implement',
      executionMode: 'same_run',
      sessionMode: 'reuse_thread',
      shouldCleanupWorktree: false,
    })

    const updated = getTicket(ticket.id)
    assert.equal(updated?.activeRunId, ticket.activeRunId)
    assert.equal(updated?.runSummaries.length, 1)
    assert.equal(updated?.planningThreadId, 'thread-plan')
    assert.equal(updated?.implementationThreadId, 'thread-review')
    assert.equal(updated?.coordinatorThreadId, 'thread-coordinator')
    assert.equal(updated?.attemptCount, 2)
    assert.equal(updated?.planningBlock, undefined)
    assert.equal(updated?.currentPhase, 'implement')
    assert.equal(updated?.steps.review?.status, 'pending')
  } finally {
    deleteTicket(ticket.id)
  }
})

test('appendTicketClarification records the user clarification in description and timeline', () => {
  const ticket = createTicket({
    title: 'Clarification append test',
    description: '기존 티켓 설명',
    projectId: 'intentlane-codex',
    projectPath: '/tmp/intentlane-codex',
    categoryId: 'feature',
    flowStepIds: ['analyze', 'plan', 'implement', 'verify', 'review', 'ready'],
  })

  try {
    appendTicketClarification(ticket.id, 'terms 관련 API 후보를 먼저 정리해 주세요.')

    const updated = getTicket(ticket.id)
    assert.match(updated?.description ?? '', /기존 티켓 설명/)
    assert.match(updated?.description ?? '', /사용자 보완 답변/)
    assert.match(updated?.description ?? '', /terms 관련 API 후보를 먼저 정리해 주세요\./)
    assert.equal(updated?.timeline.at(-1)?.title, '사용자 보완 답변이 추가되었습니다.')
    assert.equal(updated?.timeline.at(-1)?.body, 'terms 관련 API 후보를 먼저 정리해 주세요.')
  } finally {
    deleteTicket(ticket.id)
  }
})

test('prepareTicketForRetry can restart from plan in a new run and preserve only planning thread context', () => {
  const ticket = createTicket({
    title: 'Review new-run plan retry test',
    description: 'Review recovery should keep planning context but reset implementation context.',
    projectId: 'intentlane-codex',
    projectPath: '/tmp/intentlane-codex',
    categoryId: 'feature',
    flowStepIds: ['analyze', 'plan', 'implement', 'verify', 'review', 'ready'],
  })

  try {
    updateStepStatus(ticket.id, 'analyze', 'done')
    updateStepStatus(ticket.id, 'plan', 'done')
    updateStepStatus(ticket.id, 'implement', 'done')
    updateStepStatus(ticket.id, 'review', 'failed')
    setTicketRunState(ticket.id, 'needs_decision')
    setTicketCurrentPhase(ticket.id, 'review')
    setTicketPlanningThreadId(ticket.id, 'thread-plan')
    setTicketImplementationThreadId(ticket.id, 'thread-implement')
    setTicketCoordinatorThreadId(ticket.id, 'thread-coordinator')
    setTicketPlanningBlock(ticket.id, {
      kind: 'needs_decision',
      source: 'review',
      summary: '구현 보완과 계획 재정렬 중 선택이 필요합니다.',
      findings: ['계획 단계에서 acceptance criteria를 다시 맞춰야 합니다.'],
      options: [
        {
          id: 'review-restart-plan',
          label: '새 run으로 계획부터 다시 시작',
          startStepId: 'plan',
          executionMode: 'new_run',
          sessionMode: 'new_thread',
        },
      ],
    })

    const reset = prepareTicketForRetry(ticket.id)
    assert.deepEqual(reset, {
      id: 'review-restart-plan',
      label: '새 run으로 계획부터 다시 시작',
      startStepId: 'plan',
      executionMode: 'new_run',
      sessionMode: 'new_thread',
      shouldCleanupWorktree: false,
    })

    const updated = getTicket(ticket.id)
    assert.equal(updated?.activeRunId, 'run-002')
    assert.equal(updated?.runSummaries.length, 2)
    assert.equal(updated?.planningThreadId, 'thread-plan')
    assert.equal(updated?.implementationThreadId, null)
    assert.equal(updated?.coordinatorThreadId, 'thread-coordinator')
    assert.equal(updated?.currentPhase, 'plan')
    assert.equal(updated?.steps.analyze?.status, 'done')
    assert.equal(updated?.steps.plan?.status, 'pending')
    assert.equal(updated?.steps.implement?.status, 'pending')
  } finally {
    deleteTicket(ticket.id)
  }
})

test('markRecoverableTicketsFromStartup marks interrupted running tickets as retryable failures', () => {
  const ticket = createTicket({
    title: 'Recovery flow test',
    description: 'Startup recovery should flag interrupted runs',
    projectId: 'intentlane-codex',
    projectPath: '/tmp/intentlane-codex',
    categoryId: 'feature',
    flowStepIds: ['analyze', 'plan', 'implement', 'verify', 'review', 'ready'],
  })

  try {
    setTicketRunState(ticket.id, 'running')
    setTicketCurrentPhase(ticket.id, 'implement')

    markRecoverableTicketsFromStartup()

    const updated = getTicket(ticket.id)
    assert.equal(updated?.runState, 'failed')
    assert.equal(updated?.recoveryRequired, true)
    assert.equal(updated?.currentPhase, 'implement')
  } finally {
    deleteTicket(ticket.id)
  }
})

test('listTickets scopes tickets by projectId', () => {
  const matchingTicket = createTicket({
    title: 'Intentlane ticket',
    description: 'Matches selected project',
    projectId: 'intentlane-codex',
    projectPath: '/tmp/intentlane-codex',
    categoryId: 'feature',
    flowStepIds: ['analyze', 'plan', 'implement', 'verify', 'review', 'ready'],
  })

  const otherTicket = createTicket({
    title: 'Other project ticket',
    description: 'Should be filtered out',
    projectId: 'other-project',
    projectPath: '/tmp/other-project',
    categoryId: 'feature',
    flowStepIds: ['analyze', 'plan', 'implement', 'verify', 'review', 'ready'],
  })

  try {
    const tickets = listTickets('intentlane-codex')

    assert.ok(tickets.some((ticket) => ticket.id === matchingTicket.id))
    assert.ok(tickets.every((ticket) => ticket.projectId === 'intentlane-codex'))
    assert.equal(tickets.some((ticket) => ticket.id === otherTicket.id), false)
  } finally {
    deleteTicket(matchingTicket.id)
    deleteTicket(otherTicket.id)
  }
})

test('ticket stream events persist to the active run journal', () => {
  const ticket = createTicket({
    title: 'Journal persistence test',
    description: 'run journal should survive reloads',
    projectId: 'intentlane-codex',
    projectPath: '/tmp/intentlane-codex',
    categoryId: 'feature',
    flowStepIds: ['analyze', 'plan', 'implement', 'verify', 'review', 'ready'],
  })

  try {
    emitTicketEvent(ticket.id, {
      type: 'delta',
      data: {
        runId: ticket.activeRunId,
        stepId: 'analyze',
        text: 'persisted delta',
      },
    })

    reloadTicketsFromDisk()

    const events = readTicketEventJournal(ticket.id, 'run-001')
    assert.equal(events.some((event) => event.type === 'delta' && event.data.text === 'persisted delta'), true)
  } finally {
    deleteTicket(ticket.id)
  }
})

test('toPublicTicketRun exposes verification diagnosis and sanitized output excerpts', () => {
  const projectPath = '/tmp/private-project'
  const worktreePath = '/tmp/private-project/.worktrees/ticket-verify'
  const ticket = createTicket({
    title: 'Public verify output test',
    description: 'verify 상세는 실패 원인을 보여줘야 한다.',
    projectId: 'intentlane-codex',
    projectPath,
    categoryId: 'feature',
    flowStepIds: ['analyze', 'plan', 'implement', 'verify', 'review', 'ready'],
  })
  const now = new Date().toISOString()

  try {
    setTicketWorktree(ticket.id, {
      branchName: 'tickets/public-verify-output',
      baseBranch: 'main',
      baseCommit: 'abc123',
      worktreePath,
      status: 'ready',
      createdAt: now,
      updatedAt: now,
    })
    appendVerificationRun(ticket.id, {
      attempt: 1,
      status: 'failed',
      startedAt: now,
      completedAt: now,
      diagnosis: {
        kind: 'test_regression',
        fingerprint: 'abc123def456',
        summary: `Terms filter가 ${worktreePath} 기준으로 전역 403을 발생시킵니다.`,
        failingTests: [
          {
            suite: 'AdminUserControllerIntegrationTest',
            name: 'AdminUserSearchTest',
            message: `expected 200 but was 403 at ${projectPath}`,
            path: '/api/v1/user-server/admin/users',
          },
        ],
        failingCommands: [
          {
            id: 'test',
            command: 'sh ./gradlew test',
            exitCode: 1,
            logPath: 'diagnostics/verify/1-test.log',
          },
        ],
        suspectedAreas: ['src/main/java/com/example/TermsAgreementFilter.java'],
        recommendedRecovery: 'new_run_implement',
      },
      commands: [
        {
          id: 'test',
          label: 'Test',
          command: 'sh ./gradlew test',
          required: true,
          status: 'failed',
          output: `Request failed at ${worktreePath}\nproject=${projectPath}\nTERM_ACCESS_BLOCKED`,
          exitCode: 1,
          durationMs: 99181,
          startedAt: now,
          completedAt: now,
        },
      ],
    })
    appendTimelineEvent(ticket.id, {
      type: 'system',
      title: '자동 검증 실패를 바탕으로 다음 경로를 판단합니다.',
      body: `worktree=${worktreePath}\nproject=${projectPath}\nTERM_ACCESS_BLOCKED`,
    })

    const detail = toPublicTicketRun(ticket.id, ticket.activeRunId ?? 'run-001')

    assert.ok(detail)
    assert.match(detail?.steps.verify?.output ?? '', /### 실패 진단/)
    assert.match(detail?.steps.verify?.output ?? '', /요약: Terms filter가 \[worktree\] 기준으로 전역 403을 발생시킵니다\./)
    assert.match(detail?.steps.verify?.output ?? '', /AdminUserControllerIntegrationTest :: AdminUserSearchTest/)
    assert.match(detail?.steps.verify?.output ?? '', /TERM_ACCESS_BLOCKED/)
    assert.equal(detail?.steps.verify?.output.includes(projectPath), false)
    assert.equal(detail?.steps.verify?.output.includes(worktreePath), false)
    assert.equal(detail?.verificationRuns[0]?.diagnosis?.summary.includes(worktreePath), false)
    assert.equal(detail?.verificationRuns[0]?.commands[0]?.outputExcerpt?.includes(projectPath) ?? false, false)
    assert.match(detail?.verificationRuns[0]?.commands[0]?.outputExcerpt ?? '', /\[worktree\]/)
    const sanitizedTimelineBody = detail?.timeline.find((entry) => (entry.body ?? '').includes('TERM_ACCESS_BLOCKED'))?.body ?? ''
    assert.equal(sanitizedTimelineBody.includes(projectPath), false)
    assert.equal(sanitizedTimelineBody.includes(worktreePath), false)
    assert.match(sanitizedTimelineBody, /project=\[project\]/)
    assert.match(sanitizedTimelineBody, /worktree=\[worktree\]/)
  } finally {
    deleteTicket(ticket.id)
  }
})

test('toPublicTicketRun keeps skipped verification commands distinct from failures', () => {
  const ticket = createTicket({
    title: 'Public skipped verify output test',
    description: 'skip된 verify 명령은 FAIL처럼 보이면 안 된다.',
    projectId: 'intentlane-codex',
    projectPath: '/tmp/public-skipped-project',
    categoryId: 'feature',
    flowStepIds: ['analyze', 'plan', 'implement', 'verify', 'review', 'ready'],
  })
  const now = new Date().toISOString()

  try {
    appendVerificationRun(ticket.id, {
      attempt: 1,
      status: 'failed',
      startedAt: now,
      completedAt: now,
      commands: [
        {
          id: 'test',
          label: 'Test',
          command: 'pnpm test',
          required: true,
          status: 'failed',
          output: 'test failed',
          exitCode: 1,
          durationMs: 100,
          startedAt: now,
          completedAt: now,
        },
        {
          id: 'build',
          label: 'Build',
          command: 'pnpm build',
          required: true,
          status: 'skipped',
          output: '앞선 필수 검증이 실패해 실행하지 않았습니다.',
          durationMs: 0,
          startedAt: now,
          completedAt: now,
        },
      ],
    })

    const detail = toPublicTicketRun(ticket.id, ticket.activeRunId ?? 'run-001')

    assert.ok(detail)
    assert.match(detail?.steps.verify?.output ?? '', /### Test \[FAIL\]/)
    assert.match(detail?.steps.verify?.output ?? '', /### Build \[SKIPPED\]/)
    assert.doesNotMatch(detail?.steps.verify?.output ?? '', /### Build \[FAIL\]/)
  } finally {
    deleteTicket(ticket.id)
  }
})
