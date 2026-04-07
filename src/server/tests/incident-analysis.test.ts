import test from 'node:test'
import assert from 'node:assert/strict'
import { buildIncidentAnalysisEvidence } from '../services/incident-analysis.js'
import { createTicketIncident, deleteIncident, listIncidents } from '../services/incidents.js'
import {
  appendReviewRun,
  appendTimelineEvent,
  appendVerificationRun,
  createTicket,
  deleteTicket,
  replaceStepOutput,
  setTicketWorktree,
} from '../services/tickets.js'

function cleanupIncidents(ticketId: string, projectId = 'intentlane-codex') {
  for (const incident of listIncidents(projectId, ticketId)) {
    deleteIncident(incident.id)
  }
}

test('buildIncidentAnalysisEvidence truncates oversized incident bundle fields', () => {
  const ticket = createTicket({
    title: 'Large incident evidence test',
    description: '큰 incident bundle도 compact evidence로 줄여야 한다.',
    projectId: 'intentlane-codex',
    projectPath: process.cwd(),
    categoryId: 'feature',
    flowStepIds: ['analyze', 'plan', 'implement', 'verify', 'review', 'ready'],
  })
  const now = new Date().toISOString()

  try {
    replaceStepOutput(ticket.id, 'implement', `implement-log-${'x'.repeat(4_000)}`)
    appendVerificationRun(ticket.id, {
      attempt: 1,
      status: 'failed',
      startedAt: now,
      completedAt: now,
      commands: [
        {
          id: 'typecheck',
          label: 'Typecheck',
          command: 'pnpm typecheck',
          stage: 'project',
          required: true,
          status: 'failed',
          output: `verify-log-${'y'.repeat(4_000)}`,
          exitCode: 2,
          durationMs: 100,
          startedAt: now,
          completedAt: now,
        },
      ],
    })
    appendReviewRun(ticket.id, {
      attempt: 1,
      verdict: 'fail',
      summary: '리뷰 실패',
      goalAssessment: {
        request: { status: 'aligned', evidence: [] },
        ticket: { status: 'aligned', evidence: [] },
        acceptanceCriteria: [],
      },
      blockingFindings: ['범위 확인 필요'],
      residualRisks: [],
      releaseNotes: [],
      output: `review-log-${'z'.repeat(4_000)}`,
      startedAt: now,
      completedAt: now,
    })
    appendTimelineEvent(ticket.id, {
      type: 'system',
      title: '긴 로그 기록',
      body: `timeline-log-${'q'.repeat(2_000)}`,
    })
    setTicketWorktree(ticket.id, {
      branchName: 'tickets/large-incident',
      baseBranch: 'main',
      baseCommit: 'abc123',
      worktreePath: '/tmp/worktree',
      diffSummary: `diff-log-${'w'.repeat(4_000)}`,
      status: 'ready',
      createdAt: now,
      updatedAt: now,
    })

    const incident = createTicketIncident(ticket.id, {
      kind: 'verify_failed',
      message: `trigger-log-${'m'.repeat(8_000)}`,
      phase: 'verify',
      attempt: 1,
    })

    const evidence = buildIncidentAnalysisEvidence(incident)

    assert.match(evidence.trigger.message, /\[truncated/)
    assert.equal(evidence.steps.some((step) => /\[truncated/.test(step.outputExcerpt)), true)
    assert.equal(
      evidence.verificationRuns.some((run) => run.commands.some((command) => /\[truncated/.test(command.outputExcerpt))),
      true
    )
    assert.match(evidence.latestReview?.outputExcerpt ?? '', /\[truncated/)
    assert.equal(evidence.timeline.some((event) => /\[truncated/.test(event.bodyExcerpt ?? '')), true)
    assert.match(evidence.worktree?.diffSummaryExcerpt ?? '', /\[truncated/)
    assert.equal(JSON.stringify(evidence).length < JSON.stringify(incident.bundle).length, true)
  } finally {
    cleanupIncidents(ticket.id)
    deleteTicket(ticket.id)
  }
})
