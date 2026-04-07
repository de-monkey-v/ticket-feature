import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { Hono } from 'hono'
import { resolveRuntimeDataPath } from '../lib/runtime-data-paths.js'
import {
  ensureProjectDependenciesAvailableInWorktree,
  mergeTicketWorktree,
  runAutomaticTicketWorkflow,
  resetRunCodexTurnForTesting,
  setRunCodexTurnForTesting,
} from '../services/ticket-orchestrator.js'
import { ticketRoutes } from '../routes/tickets.js'
import {
  resetRunAutomaticTicketWorkflowForTesting,
  resolveTicketMergeRun,
  retryTicketRun,
  setRunAutomaticTicketWorkflowForTesting,
} from '../services/ticket-runner.js'
import {
  appendStageReview,
  createTicket,
  deleteTicket,
  getTicket,
  setFinalReport,
  setTicketAttemptCount,
  setTicketCurrentPhase,
  setTicketMergeBlock,
  setTicketMergeContext,
  setTicketPlanningBlock,
  setTicketRunState,
  setTicketStatus,
  setTicketWorktree,
  updateStepStatus,
  type Ticket,
} from '../services/tickets.js'

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
  }).trim()
}

function gitCommit(cwd: string, message: string) {
  git(cwd, '-c', 'user.name=Ticket Test', '-c', 'user.email=ticket@example.com', 'commit', '-m', message)
}

async function waitForCondition(predicate: () => boolean, timeoutMs = 3_000) {
  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) {
      return
    }

    await new Promise<void>((resolve) => setTimeout(resolve, 20))
  }

  throw new Error('Timed out waiting for condition')
}

function createRepoFixture() {
  const root = mkdtempSync(join(tmpdir(), 'ticket-worktree-'))
  const repoPath = join(root, 'repo')
  mkdirSync(repoPath, { recursive: true })

  git(repoPath, 'init', '--initial-branch=main')
  writeFileSync(join(repoPath, 'tracked.txt'), 'base\n', 'utf8')
  git(repoPath, 'add', 'tracked.txt')
  gitCommit(repoPath, 'initial commit')

  return {
    root,
    repoPath,
    cleanup() {
      rmSync(root, { recursive: true, force: true })
    },
  }
}

function createTicketWithWorktree(
  repoPath: string,
  opts?: {
    trackedFile?: string
    worktreeContent?: string
    diffSummary?: string
    flowStepIds?: string[]
  }
) {
  const ticket = createTicket({
    title: 'Worktree hardening test',
    description: 'Exercise git worktree hardening paths',
    projectId: 'intentlane-codex',
    projectPath: repoPath,
    categoryId: 'feature',
    flowStepIds: opts?.flowStepIds ?? ['analyze', 'plan', 'implement', 'verify', 'review', 'ready'],
  })

  const baseBranch = git(repoPath, 'branch', '--show-current')
  const baseCommit = git(repoPath, 'rev-parse', 'HEAD')
  const worktreeRoot = resolve(repoPath, '..', '.intentlane-codex-worktrees')
  const branchName = `tickets/${ticket.id.toLowerCase()}-attempt-1`
  const worktreePath = resolve(worktreeRoot, `${ticket.id.toLowerCase()}-attempt-1`)
  const trackedFile = opts?.trackedFile ?? 'tracked.txt'
  const worktreeContent = opts?.worktreeContent ?? 'feature\n'

  mkdirSync(worktreeRoot, { recursive: true })
  git(repoPath, 'worktree', 'add', '-b', branchName, worktreePath, baseBranch)

  mkdirSync(dirname(join(worktreePath, trackedFile)), { recursive: true })
  writeFileSync(join(worktreePath, trackedFile), worktreeContent, 'utf8')
  git(worktreePath, 'add', trackedFile)
  gitCommit(worktreePath, 'feature commit')

  setTicketWorktree(ticket.id, {
    branchName,
    baseBranch,
    baseCommit,
    worktreePath,
    headCommit: git(worktreePath, 'rev-parse', 'HEAD'),
    diffSummary: opts?.diffSummary ?? `Committed diff:\n ${trackedFile} | 1 +`,
    status: 'ready',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  })

  updateStepStatus(ticket.id, 'ready', 'done')
  setTicketStatus(ticket.id, 'awaiting_merge')

  return { ticket, worktreePath, branchName, baseCommit }
}

function markTicketRetryable(ticket: Ticket) {
  updateStepStatus(ticket.id, 'ready', 'pending')
  updateStepStatus(ticket.id, 'analyze', 'done')
  updateStepStatus(ticket.id, 'plan', 'done')
  updateStepStatus(ticket.id, 'implement', 'failed')
  setTicketRunState(ticket.id, 'failed')
  setTicketCurrentPhase(ticket.id, 'review')
  setTicketAttemptCount(ticket.id, 2)
  setFinalReport(ticket.id, {
    summary: 'existing report',
    changedAreas: ['tracked.txt'],
    verificationSummary: ['pending'],
    goalAssessment: {
      request: {
        status: 'not_available',
        evidence: [],
      },
      ticket: {
        status: 'aligned',
        evidence: [],
      },
      acceptanceCriteria: [],
    },
    qualityAssessment: {
      correctness: 'medium',
      maintainability: 'medium',
      testConfidence: 'low',
      risk: 'medium',
    },
    blockingFindings: [],
    residualRisks: [],
    mergeRecommendation: 'hold',
    output: 'report',
    createdAt: new Date().toISOString(),
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
}

test('mergeTicketWorktree rejects a changed target branch before merging', async () => {
  const fixture = createRepoFixture()
  const { ticket } = createTicketWithWorktree(fixture.repoPath)

  try {
    git(fixture.repoPath, 'checkout', '-b', 'other-branch')

    await assert.rejects(
      mergeTicketWorktree(ticket.id),
      /Merge target branch changed since worktree creation/
    )

    const updated = getTicket(ticket.id)
    assert.equal(updated?.status, 'awaiting_merge')
    assert.equal(updated?.worktree?.status, 'ready')
  } finally {
    deleteTicket(ticket.id)
    fixture.cleanup()
  }
})

test('ensureProjectDependenciesAvailableInWorktree links root node_modules into a ticket worktree', () => {
  const fixture = createRepoFixture()

  try {
    const worktreeRoot = resolve(fixture.repoPath, '..', '.intentlane-codex-worktrees')
    const worktreePath = resolve(worktreeRoot, 'dependency-link-test')

    mkdirSync(join(fixture.repoPath, 'node_modules'), { recursive: true })
    mkdirSync(worktreeRoot, { recursive: true })
    git(fixture.repoPath, 'worktree', 'add', '-b', 'tickets/dependency-link-test', worktreePath, 'main')

    ensureProjectDependenciesAvailableInWorktree(fixture.repoPath, worktreePath)

    const linkedPath = join(worktreePath, 'node_modules')
    assert.equal(existsSync(linkedPath), true)
    assert.equal(lstatSync(linkedPath).isSymbolicLink(), true)
    assert.equal(readlinkSync(linkedPath), join(fixture.repoPath, 'node_modules'))
  } finally {
    fixture.cleanup()
  }
})

test('ensureProjectDependenciesAvailableInWorktree links nested node_modules into matching worktree paths', () => {
  const fixture = createRepoFixture()

  try {
    const projectPath = join(fixture.repoPath, 'services', 'backend')
    const worktreeRoot = resolve(fixture.repoPath, '..', '.intentlane-codex-worktrees')
    const worktreePath = resolve(worktreeRoot, 'nested-dependency-link-test')

    mkdirSync(join(fixture.repoPath, 'node_modules'), { recursive: true })
    mkdirSync(join(fixture.repoPath, 'services', 'node_modules'), { recursive: true })
    mkdirSync(join(projectPath, 'node_modules'), { recursive: true })
    mkdirSync(worktreePath, { recursive: true })

    ensureProjectDependenciesAvailableInWorktree(projectPath, worktreePath)

    const rootLinkedPath = join(worktreePath, 'node_modules')
    const servicesLinkedPath = join(worktreePath, 'services', 'node_modules')
    const projectLinkedPath = join(worktreePath, 'services', 'backend', 'node_modules')

    assert.equal(existsSync(rootLinkedPath), true)
    assert.equal(existsSync(servicesLinkedPath), true)
    assert.equal(existsSync(projectLinkedPath), true)
    assert.equal(lstatSync(rootLinkedPath).isSymbolicLink(), true)
    assert.equal(lstatSync(servicesLinkedPath).isSymbolicLink(), true)
    assert.equal(lstatSync(projectLinkedPath).isSymbolicLink(), true)
    assert.equal(readlinkSync(rootLinkedPath), join(fixture.repoPath, 'node_modules'))
    assert.equal(readlinkSync(servicesLinkedPath), join(fixture.repoPath, 'services', 'node_modules'))
    assert.equal(readlinkSync(projectLinkedPath), join(projectPath, 'node_modules'))
  } finally {
    fixture.cleanup()
  }
})

test('mergeTicketWorktree rejects a changed target commit before merging', async () => {
  const fixture = createRepoFixture()
  const { ticket } = createTicketWithWorktree(fixture.repoPath)

  try {
    writeFileSync(join(fixture.repoPath, 'base-only.txt'), 'new base\n', 'utf8')
    git(fixture.repoPath, 'add', 'base-only.txt')
    gitCommit(fixture.repoPath, 'advance base branch')

    await assert.rejects(
      mergeTicketWorktree(ticket.id),
      /Merge target commit changed since worktree creation/
    )

    const updated = getTicket(ticket.id)
    assert.equal(updated?.status, 'awaiting_merge')
    assert.equal(updated?.worktree?.status, 'ready')
  } finally {
    deleteTicket(ticket.id)
    fixture.cleanup()
  }
})

test('merge route returns a merge decision when tracked target changes overlap reviewed ticket files', async () => {
  const fixture = createRepoFixture()
  const { ticket } = createTicketWithWorktree(fixture.repoPath)

  setRunCodexTurnForTesting(async () => {
    throw new Error('merge analysis unavailable')
  })

  try {
    writeFileSync(join(fixture.repoPath, 'tracked.txt'), 'local target change\n', 'utf8')

    const app = new Hono()
    app.route('/api', ticketRoutes)

    const response = await app.request(`http://localhost/api/tickets/${ticket.id}/merge`, {
      method: 'POST',
    })

    assert.equal(response.status, 409)
    const payload = (await response.json()) as {
      code: string
      mergeBlock: {
        issue: string
        conflictFiles: string[]
        options: Array<{ action: string }>
      }
    }

    assert.equal(payload.code, 'MERGE_DECISION_REQUIRED')
    assert.equal(payload.mergeBlock.issue, 'target_worktree_dirty')
    assert.deepEqual(payload.mergeBlock.conflictFiles, ['tracked.txt'])
    assert.ok(payload.mergeBlock.options.some((option) => option.action === 'preserve_target_changes_and_reconcile'))
  } finally {
    resetRunCodexTurnForTesting()
    deleteTicket(ticket.id)
    fixture.cleanup()
  }
})

test('merge route returns a merge decision when untracked target files would be overwritten', async () => {
  const fixture = createRepoFixture()
  const { ticket } = createTicketWithWorktree(fixture.repoPath, {
    trackedFile: 'summary.txt',
    worktreeContent: 'ticket-created file\n',
    diffSummary: 'Committed diff:\n summary.txt | 1 +',
  })

  setRunCodexTurnForTesting(async () => {
    throw new Error('merge analysis unavailable')
  })

  try {
    writeFileSync(join(fixture.repoPath, 'summary.txt'), 'local untracked content\n', 'utf8')

    const app = new Hono()
    app.route('/api', ticketRoutes)

    const response = await app.request(`http://localhost/api/tickets/${ticket.id}/merge`, {
      method: 'POST',
    })

    assert.equal(response.status, 409)
    const payload = (await response.json()) as {
      code: string
      mergeBlock: {
        issue: string
        conflictFiles: string[]
      }
    }

    assert.equal(payload.code, 'MERGE_DECISION_REQUIRED')
    assert.equal(payload.mergeBlock.issue, 'target_worktree_dirty')
    assert.deepEqual(payload.mergeBlock.conflictFiles, ['summary.txt'])
  } finally {
    resetRunCodexTurnForTesting()
    deleteTicket(ticket.id)
    fixture.cleanup()
  }
})

test('mergeTicketWorktree ignores unrelated target dirty files and still merges', async () => {
  const fixture = createRepoFixture()
  const { ticket } = createTicketWithWorktree(fixture.repoPath)

  try {
    writeFileSync(join(fixture.repoPath, 'unrelated.txt'), 'local only\n', 'utf8')

    await mergeTicketWorktree(ticket.id)

    const updated = getTicket(ticket.id)
    assert.equal(updated?.status, 'completed')
    assert.equal(git(fixture.repoPath, 'show', 'HEAD:tracked.txt').trim(), 'feature')
    assert.equal(readFileSync(join(fixture.repoPath, 'unrelated.txt'), 'utf8'), 'local only\n')
  } finally {
    deleteTicket(ticket.id)
    fixture.cleanup()
  }
})

test('merge route auto-starts rebase and revalidation when the base commit changed cleanly', async () => {
  const fixture = createRepoFixture()
  const { ticket } = createTicketWithWorktree(fixture.repoPath)
  let observedStartStepId: string | null = null

  const mergeDecision = {
    summary: '기준 브랜치가 전진해 직접 merge 전에 정렬이 필요합니다.',
    findings: ['현재 main HEAD가 ticket의 기준 커밋보다 앞서 있습니다.'],
    recommendedAction: 'rebase_and_revalidate',
    options: [
      {
        action: 'rebase_and_revalidate',
        rationale: '현재 작업을 유지하면서 최신 main 기준으로 다시 검증하는 것이 가장 비용이 낮습니다.',
      },
      {
        action: 'restart_from_plan',
        rationale: '드리프트가 크다고 판단되면 새 run으로 다시 시작할 수 있습니다.',
      },
    ],
  }

  setRunCodexTurnForTesting(async <T>() => ({
    threadId: null,
    finalResponse: JSON.stringify(mergeDecision),
    parsedOutput: mergeDecision as T,
  }))
  setRunAutomaticTicketWorkflowForTesting(
    (async ({ startStepId }) => {
      observedStartStepId = startStepId ?? null
    }) as Parameters<typeof setRunAutomaticTicketWorkflowForTesting>[0]
  )

  try {
    writeFileSync(join(fixture.repoPath, 'base-only.txt'), 'new base\n', 'utf8')
    git(fixture.repoPath, 'add', 'base-only.txt')
    gitCommit(fixture.repoPath, 'advance base branch')

    const app = new Hono()
    app.route('/api', ticketRoutes)

    const response = await app.request(`http://localhost/api/tickets/${ticket.id}/merge`, {
      method: 'POST',
    })

    assert.equal(response.status, 200)
    const payload = (await response.json()) as {
      ok: boolean
      warning?: string
    }
    assert.equal(payload.ok, true)
    assert.match(payload.warning ?? '', /자동 rebase\/revalidate/)
    assert.equal(observedStartStepId, 'verify')
    assert.equal(getTicket(ticket.id)?.mergeBlock, undefined)
  } finally {
    resetRunCodexTurnForTesting()
    resetRunAutomaticTicketWorkflowForTesting()
    deleteTicket(ticket.id)
    fixture.cleanup()
  }
})

test('merge resolve route rebases the worktree and queues validation from verify', async () => {
  const fixture = createRepoFixture()
  const { ticket, worktreePath } = createTicketWithWorktree(fixture.repoPath)
  let observedStartStepId: string | null = null

  setRunAutomaticTicketWorkflowForTesting(
    (async ({ startStepId }) => {
      observedStartStepId = startStepId ?? null
    }) as Parameters<typeof setRunAutomaticTicketWorkflowForTesting>[0]
  )

  try {
    writeFileSync(join(fixture.repoPath, 'base-only.txt'), 'new base\n', 'utf8')
    git(fixture.repoPath, 'add', 'base-only.txt')
    gitCommit(fixture.repoPath, 'advance base branch')

    setTicketMergeBlock(ticket.id, {
      issue: 'base_commit_changed',
      errorMessage: 'Merge target commit changed since worktree creation. Re-run the ticket from the latest base commit.',
      summary: '현재 기준 브랜치가 전진해 rebase 후 재검증이 필요합니다.',
      findings: ['main이 ticket 생성 시점보다 앞서 있습니다.'],
      conflictFiles: [],
      options: [
        {
          id: 'merge-rebase-and-revalidate',
          label: '현재 기준 브랜치로 rebase 후 재검증',
          action: 'rebase_and_revalidate',
          rationale: '현재 작업을 유지하면서 최신 main 기준으로 다시 검증합니다.',
          recommended: true,
        },
      ],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })

    const app = new Hono()
    app.route('/api', ticketRoutes)

    const response = await app.request(`http://localhost/api/tickets/${ticket.id}/merge/resolve`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ optionId: 'merge-rebase-and-revalidate' }),
    })

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { ok: true })

    await new Promise<void>((resolve) => queueMicrotask(resolve))

    const updated = getTicket(ticket.id)
    assert.equal(observedStartStepId, 'verify')
    assert.equal(updated?.currentPhase, 'verify')
    assert.equal(updated?.runState, 'queued')
    assert.equal(updated?.mergeBlock, undefined)
    assert.equal(updated?.worktree?.baseCommit, git(fixture.repoPath, 'rev-parse', 'HEAD'))
    assert.equal(updated?.worktree?.headCommit, git(worktreePath, 'rev-parse', 'HEAD'))
  } finally {
    resetRunAutomaticTicketWorkflowForTesting()
    deleteTicket(ticket.id)
    fixture.cleanup()
  }
})

test('merge route keeps conflict-specific decisions when rebase would hit text conflicts', async () => {
  const fixture = createRepoFixture()
  let codexCallCount = 0

  writeFileSync(join(fixture.repoPath, 'README.md'), 'intro\nshared\nfooter\n', 'utf8')
  git(fixture.repoPath, 'add', 'README.md')
  gitCommit(fixture.repoPath, 'add readme')

  const { ticket } = createTicketWithWorktree(fixture.repoPath, {
    trackedFile: 'README.md',
    worktreeContent: 'intro\nfeature change\nfooter\n',
    diffSummary: 'Committed diff:\n README.md | 2 +-',
  })

  setRunCodexTurnForTesting(async () => {
    codexCallCount += 1
    throw new Error('merge analysis unavailable')
  })

  try {
    writeFileSync(join(fixture.repoPath, 'README.md'), 'intro\nmain change\nfooter\n', 'utf8')
    git(fixture.repoPath, 'add', 'README.md')
    gitCommit(fixture.repoPath, 'advance main readme')

    const app = new Hono()
    app.route('/api', ticketRoutes)

    const firstResponse = await app.request(`http://localhost/api/tickets/${ticket.id}/merge`, {
      method: 'POST',
    })

    assert.equal(firstResponse.status, 409)
    const firstPayload = (await firstResponse.json()) as {
      code: string
      mergeBlock: {
        issue: string
        conflictFiles: string[]
        options: Array<{ action: string }>
      }
    }

    assert.equal(firstPayload.code, 'MERGE_DECISION_REQUIRED')
    assert.equal(firstPayload.mergeBlock.issue, 'rebase_conflict_text')
    assert.ok(firstPayload.mergeBlock.conflictFiles.includes('README.md'))
    assert.ok(firstPayload.mergeBlock.options.some((option) => option.action === 'reapply_on_latest_base'))
    assert.equal(firstPayload.mergeBlock.options.some((option) => option.action === 'rebase_and_revalidate'), false)
    assert.equal(codexCallCount, 1)

    const secondResponse = await app.request(`http://localhost/api/tickets/${ticket.id}/merge`, {
      method: 'POST',
    })

    assert.equal(secondResponse.status, 409)
    const secondPayload = (await secondResponse.json()) as {
      code: string
      mergeBlock: {
        issue: string
        conflictFiles: string[]
      }
    }

    assert.equal(secondPayload.code, 'MERGE_DECISION_REQUIRED')
    assert.equal(secondPayload.mergeBlock.issue, 'rebase_conflict_text')
    assert.ok(secondPayload.mergeBlock.conflictFiles.includes('README.md'))
    assert.equal(codexCallCount, 1)
  } finally {
    resetRunCodexTurnForTesting()
    deleteTicket(ticket.id)
    fixture.cleanup()
  }
})

test('merge resolve route starts a new implement run when reapplying on the latest base', async () => {
  const fixture = createRepoFixture()
  const { ticket, worktreePath } = createTicketWithWorktree(fixture.repoPath)
  const sourceRunId = ticket.activeRunId
  let observedStartStepId: string | null = null

  updateStepStatus(ticket.id, 'analyze', 'done')
  updateStepStatus(ticket.id, 'plan', 'done')
  setFinalReport(ticket.id, {
    summary: 'reviewed result',
    changedAreas: ['tracked.txt'],
    verificationSummary: ['verify pending'],
    goalAssessment: {
      request: {
        status: 'not_available',
        evidence: [],
      },
      ticket: {
        status: 'aligned',
        evidence: ['tracked.txt 변경이 review를 통과했습니다.'],
      },
      acceptanceCriteria: [],
    },
    qualityAssessment: {
      correctness: 'high',
      maintainability: 'medium',
      testConfidence: 'medium',
      risk: 'medium',
    },
    blockingFindings: [],
    residualRisks: [],
    mergeRecommendation: 'merge',
    output: '최종 보고',
    createdAt: new Date().toISOString(),
  })
  appendStageReview(ticket.id, {
    id: 'analyze-review-pass',
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
    id: 'plan-review-pass',
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

  setTicketMergeBlock(ticket.id, {
    issue: 'rebase_conflict_text',
    errorMessage: 'Rebase conflict detected while preparing the ticket worktree: README.md',
    summary: 'README.md 충돌 때문에 최신 기준 브랜치에서 변경 재적용이 필요합니다.',
    findings: ['README.md 충돌을 자동 rebase로 풀 수 없습니다.'],
    conflictFiles: ['README.md'],
    options: [
      {
        id: 'merge-reapply-on-latest-base',
        label: '최신 기준 브랜치에서 변경 재적용',
        action: 'reapply_on_latest_base',
        rationale: '기존 reviewed 변경 의도를 최신 기준으로 다시 적용합니다.',
        recommended: true,
      },
    ],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  })

  setRunAutomaticTicketWorkflowForTesting(
    (async ({ startStepId }) => {
      observedStartStepId = startStepId ?? null
    }) as Parameters<typeof setRunAutomaticTicketWorkflowForTesting>[0]
  )

  try {
    const app = new Hono()
    app.route('/api', ticketRoutes)

    const response = await app.request(`http://localhost/api/tickets/${ticket.id}/merge/resolve`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ optionId: 'merge-reapply-on-latest-base' }),
    })

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { ok: true })

    await new Promise<void>((resolve) => queueMicrotask(resolve))

    const updated = getTicket(ticket.id)
    assert.equal(observedStartStepId, 'implement')
    assert.equal(updated?.currentPhase, 'implement')
    assert.equal(updated?.runState, 'queued')
    assert.equal(updated?.mergeBlock, undefined)
    assert.equal(updated?.runSummaries.length, 2)
    assert.notEqual(updated?.activeRunId, sourceRunId)
    assert.equal(updated?.mergeContext?.mode, 'reapply_on_latest_base')
    assert.equal(updated?.mergeContext?.sourceRunId, sourceRunId)
    assert.equal(updated?.mergeContext?.supersededWorktree?.worktreePath, worktreePath)
    assert.equal(updated?.mergeContext?.lastAttemptedAction, 'reapply_on_latest_base')
  } finally {
    resetRunAutomaticTicketWorkflowForTesting()
    setTicketMergeContext(ticket.id, undefined)
    deleteTicket(ticket.id)
    fixture.cleanup()
  }
})

test('merge resolve route preserves target changes on a safety branch before starting reconcile', async () => {
  const fixture = createRepoFixture()
  const { ticket, worktreePath } = createTicketWithWorktree(fixture.repoPath)
  const sourceRunId = ticket.activeRunId
  const sourceReviewedBaseCommit = ticket.worktree?.baseCommit
  const sourceReviewedHeadCommit = ticket.worktree?.headCommit
  let observedStartStepId: string | null = null

  updateStepStatus(ticket.id, 'analyze', 'done')
  updateStepStatus(ticket.id, 'plan', 'done')
  setFinalReport(ticket.id, {
    summary: 'reviewed result',
    changedAreas: ['tracked.txt'],
    verificationSummary: ['verify pending'],
    goalAssessment: {
      request: {
        status: 'not_available',
        evidence: [],
      },
      ticket: {
        status: 'aligned',
        evidence: ['tracked.txt 변경이 review를 통과했습니다.'],
      },
      acceptanceCriteria: [],
    },
    qualityAssessment: {
      correctness: 'high',
      maintainability: 'medium',
      testConfidence: 'medium',
      risk: 'medium',
    },
    blockingFindings: [],
    residualRisks: [],
    mergeRecommendation: 'merge',
    output: '최종 보고',
    createdAt: new Date().toISOString(),
  })
  appendStageReview(ticket.id, {
    id: 'analyze-review-pass',
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
    id: 'plan-review-pass',
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

  setTicketMergeBlock(ticket.id, {
    issue: 'target_worktree_dirty',
    errorMessage: 'Merge target worktree has local changes overlapping reviewed ticket files: tracked.txt',
    summary: 'merge target의 로컬 변경을 보존한 뒤 reconcile이 필요합니다.',
    findings: ['tracked.txt에 merge를 막는 로컬 변경이 있습니다.'],
    conflictFiles: ['tracked.txt'],
    options: [
      {
        id: 'merge-preserve-target-and-reconcile',
        label: '대상 로컬 변경 보존 후 reconcile',
        action: 'preserve_target_changes_and_reconcile',
        rationale: '로컬 변경을 safety branch에 보존한 뒤 reviewed 결과와 다시 통합합니다.',
        recommended: true,
      },
    ],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  })

  writeFileSync(join(fixture.repoPath, 'tracked.txt'), 'local target change\n', 'utf8')

  setRunAutomaticTicketWorkflowForTesting(
    (async ({ startStepId }) => {
      observedStartStepId = startStepId ?? null
    }) as Parameters<typeof setRunAutomaticTicketWorkflowForTesting>[0]
  )

  try {
    const app = new Hono()
    app.route('/api', ticketRoutes)

    const response = await app.request(`http://localhost/api/tickets/${ticket.id}/merge/resolve`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ optionId: 'merge-preserve-target-and-reconcile' }),
    })

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { ok: true })

    await new Promise<void>((resolve) => queueMicrotask(resolve))

    const updated = getTicket(ticket.id)
    assert.equal(observedStartStepId, 'implement')
    assert.equal(updated?.currentPhase, 'implement')
    assert.equal(updated?.runState, 'queued')
    assert.equal(updated?.mergeBlock, undefined)
    assert.equal(updated?.runSummaries.length, 2)
    assert.notEqual(updated?.activeRunId, sourceRunId)
    assert.equal(updated?.mergeContext?.mode, 'reconcile_target_worktree')
    assert.equal(updated?.mergeContext?.sourceRunId, sourceRunId)
    assert.equal(updated?.mergeContext?.supersededWorktree?.worktreePath, worktreePath)
    assert.equal(updated?.mergeContext?.lastAttemptedAction, 'preserve_target_changes_and_reconcile')
    assert.equal(updated?.mergeContext?.sourceReviewedBaseCommit, sourceReviewedBaseCommit)
    assert.equal(updated?.mergeContext?.sourceReviewedHeadCommit, sourceReviewedHeadCommit)
    assert.ok(updated?.mergeContext?.safetyBranchName)
    assert.ok(updated?.mergeContext?.safetyCommit)
    assert.equal(git(fixture.repoPath, 'status', '--short'), '')
    assert.notEqual(git(fixture.repoPath, 'branch', '--list', updated?.mergeContext?.safetyBranchName ?? ''), '')
  } finally {
    resetRunAutomaticTicketWorkflowForTesting()
    setTicketMergeContext(ticket.id, undefined)
    deleteTicket(ticket.id)
    fixture.cleanup()
  }
})

test('reconcile run pre-seeds reviewed ticket changes into the fresh worktree before implement', async () => {
  const fixture = createRepoFixture()
  const { ticket } = createTicketWithWorktree(fixture.repoPath, {
    flowStepIds: ['analyze', 'plan', 'implement', 'review', 'ready'],
  })
  let implementHeadContent = ''
  let implementPrompt = ''

  updateStepStatus(ticket.id, 'analyze', 'done')
  updateStepStatus(ticket.id, 'plan', 'done')
  setFinalReport(ticket.id, {
    summary: 'reviewed result',
    changedAreas: ['tracked.txt'],
    verificationSummary: ['review pending'],
    goalAssessment: {
      request: {
        status: 'not_available',
        evidence: [],
      },
      ticket: {
        status: 'aligned',
        evidence: ['tracked.txt 변경이 review를 통과했습니다.'],
      },
      acceptanceCriteria: [],
    },
    qualityAssessment: {
      correctness: 'high',
      maintainability: 'medium',
      testConfidence: 'medium',
      risk: 'medium',
    },
    blockingFindings: [],
    residualRisks: [],
    mergeRecommendation: 'merge',
    output: '최종 보고',
    createdAt: new Date().toISOString(),
  })
  appendStageReview(ticket.id, {
    id: 'analyze-review-pass',
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
    id: 'plan-review-pass',
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

  setTicketMergeBlock(ticket.id, {
    issue: 'target_worktree_dirty',
    errorMessage: 'Merge target worktree has local changes overlapping reviewed ticket files: tracked.txt',
    summary: 'merge target의 로컬 변경을 보존한 뒤 reconcile이 필요합니다.',
    findings: ['tracked.txt에 merge를 막는 로컬 변경이 있습니다.'],
    conflictFiles: ['tracked.txt'],
    options: [
      {
        id: 'merge-preserve-target-and-reconcile',
        label: '대상 로컬 변경 보존 후 reconcile',
        action: 'preserve_target_changes_and_reconcile',
        rationale: '로컬 변경을 safety branch에 보존한 뒤 reviewed 결과와 다시 통합합니다.',
        recommended: true,
      },
    ],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  })

  writeFileSync(join(fixture.repoPath, 'tracked.txt'), 'local target change\n', 'utf8')

  setRunCodexTurnForTesting(
    (async (opts) => {
      if (opts.promptFile === 'prompts/ticket-implement.txt') {
        implementPrompt = opts.prompt
        implementHeadContent = git(opts.cwd, 'show', 'HEAD:tracked.txt').trim()
        return {
          threadId: 'reconcile-thread',
          finalResponse: 'reconcile complete',
        }
      }

      const review = {
        verdict: 'pass' as const,
        summary: 'reviewed ticket 변경이 새 reconcile worktree에 선적용된 상태로 다시 검토되었습니다.',
        goalAssessment: {
          request: {
            status: 'not_available' as const,
            evidence: [],
          },
          ticket: {
            status: 'aligned' as const,
            evidence: ['tracked.txt가 reviewed 결과를 유지합니다.'],
          },
          acceptanceCriteria: [],
        },
        blockingFindings: [],
        residualRisks: [],
        releaseNotes: ['tracked.txt 유지'],
      }

      return {
        threadId: 'reconcile-thread',
        finalResponse: JSON.stringify(review),
        parsedOutput: review,
      }
    }) as Parameters<typeof setRunCodexTurnForTesting>[0]
  )
  setRunAutomaticTicketWorkflowForTesting(
    (async (opts) => {
      await runAutomaticTicketWorkflow(opts)
    }) as Parameters<typeof setRunAutomaticTicketWorkflowForTesting>[0]
  )

  try {
    await resolveTicketMergeRun(ticket.id, 'merge-preserve-target-and-reconcile')

    await waitForCondition(() => getTicket(ticket.id)?.status === 'awaiting_merge')

    assert.equal(implementHeadContent, 'feature')
    assert.match(implementPrompt, /merge target의 로컬 변경을 안전하게 보존한 뒤 reviewed ticket 결과와 통합하는 reconcile 작업/)
    assert.match(implementPrompt, /현재 새 worktree에는 review를 통과한 ticket 변경이 이미 선적용되어 있다/)
    assert.match(implementPrompt, /보존된 target 변경 브랜치:/)
  } finally {
    resetRunAutomaticTicketWorkflowForTesting()
    resetRunCodexTurnForTesting()
    setTicketMergeContext(ticket.id, undefined)
    deleteTicket(ticket.id)
    fixture.cleanup()
  }
})

test('merge route returns success with warning when merge completes but cleanup fails', async () => {
  const fixture = createRepoFixture()
  const { ticket, worktreePath, branchName } = createTicketWithWorktree(fixture.repoPath)

  try {
    git(fixture.repoPath, 'worktree', 'lock', worktreePath)

    const app = new Hono()
    app.route('/api', ticketRoutes)

    const response = await app.request(`http://localhost/api/tickets/${ticket.id}/merge`, {
      method: 'POST',
    })

    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.equal(payload.ok, true)
    assert.match(payload.warning, /Merged successfully, but cleanup failed:/)

    const updated = getTicket(ticket.id)
    assert.equal(updated?.status, 'completed')
    assert.equal(updated?.worktree?.status, 'cleanup_failed')
    assert.equal(git(fixture.repoPath, 'rev-parse', 'HEAD'), updated?.worktree?.mergeCommit)
    assert.equal(git(fixture.repoPath, 'show', 'HEAD:tracked.txt').trim(), 'feature')
    assert.notEqual(git(fixture.repoPath, 'branch', '--list', branchName), '')
  } finally {
    deleteTicket(ticket.id)
    fixture.cleanup()
  }
})

test('retryTicketRun preserves ticket state when worktree cleanup fails', async () => {
  const fixture = createRepoFixture()
  const { ticket, worktreePath } = createTicketWithWorktree(fixture.repoPath)

  try {
    markTicketRetryable(ticket)
    setTicketRunState(ticket.id, 'needs_decision')
    setTicketPlanningBlock(ticket.id, {
      kind: 'needs_decision',
      source: 'review',
      summary: '새 run 재시작과 같은 run 수선 중 선택이 필요합니다.',
      findings: ['worktree를 정리한 뒤 새 run으로 implement를 다시 시작합니다.'],
      options: [
        {
          id: 'cleanup-restart-implement',
          label: '새 run으로 구현 다시',
          startStepId: 'implement',
          executionMode: 'new_run',
          sessionMode: 'new_thread',
        },
      ],
    })
    git(fixture.repoPath, 'worktree', 'lock', worktreePath)

    await assert.rejects(retryTicketRun(ticket.id, 'cleanup-restart-implement'))

    const updated = getTicket(ticket.id)
    assert.equal(updated?.runState, 'needs_decision')
    assert.equal(updated?.currentPhase, 'review')
    assert.equal(updated?.attemptCount, 2)
    assert.equal(updated?.finalReport?.summary, 'existing report')
    assert.equal(updated?.worktree?.status, 'cleanup_failed')
    assert.equal(updated?.worktree?.worktreePath, worktreePath)
  } finally {
    deleteTicket(ticket.id)
    fixture.cleanup()
  }
})

test('delete ticket returns an error when worktree cleanup fails', async () => {
  const fixture = createRepoFixture()
  const { ticket, worktreePath } = createTicketWithWorktree(fixture.repoPath)

  try {
    setTicketRunState(ticket.id, 'failed')
    git(fixture.repoPath, 'worktree', 'lock', worktreePath)

    const app = new Hono()
    app.route('/api', ticketRoutes)

    const response = await app.request(`http://localhost/api/tickets/${ticket.id}`, {
      method: 'DELETE',
    })

    assert.equal(response.status, 400)
    assert.equal(existsSync(resolveRuntimeDataPath('tickets', ticket.projectId, ticket.id, 'ticket.json')), true)
    assert.ok(getTicket(ticket.id))
  } finally {
    deleteTicket(ticket.id)
    fixture.cleanup()
  }
})

test('delete ticket retries cleanup for completed tickets with cleanup_failed worktrees', async () => {
  const fixture = createRepoFixture()
  const { ticket, worktreePath, branchName } = createTicketWithWorktree(fixture.repoPath)

  try {
    setTicketStatus(ticket.id, 'completed')
    setTicketWorktree(ticket.id, {
      ...getTicket(ticket.id)!.worktree!,
      status: 'cleanup_failed',
      updatedAt: new Date().toISOString(),
    })

    const app = new Hono()
    app.route('/api', ticketRoutes)

    const response = await app.request(`http://localhost/api/tickets/${ticket.id}`, {
      method: 'DELETE',
    })

    assert.equal(response.status, 200)
    assert.equal(getTicket(ticket.id), undefined)
    assert.equal(existsSync(worktreePath), false)
    assert.match(git(fixture.repoPath, 'branch', '--list', branchName), /^$/)
  } finally {
    deleteTicket(ticket.id)
    fixture.cleanup()
  }
})

test('delete ticket reconciles missing worktree paths before deleting ticket metadata', async () => {
  const fixture = createRepoFixture()
  const { ticket, worktreePath, branchName } = createTicketWithWorktree(fixture.repoPath)

  try {
    rmSync(worktreePath, { recursive: true, force: true })

    const app = new Hono()
    app.route('/api', ticketRoutes)

    const response = await app.request(`http://localhost/api/tickets/${ticket.id}`, {
      method: 'DELETE',
    })

    assert.equal(response.status, 200)
    assert.equal(getTicket(ticket.id), undefined)
    assert.match(git(fixture.repoPath, 'branch', '--list', branchName), /^$/)
  } finally {
    deleteTicket(ticket.id)
    fixture.cleanup()
  }
})
