import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createOpenAuthSession } from '../lib/access-policy.js'
import { loadConfig, reloadConfig } from '../lib/config.js'
import { toPublicConfig } from '../lib/projects.js'
import { createClientRequest, deleteClientRequest } from '../services/client-requests.js'
import {
  resetIncidentAutoResolutionEnabledForTesting,
  setIncidentAutoResolutionEnabledForTesting,
} from '../services/incident-resolution.js'
import { deleteIncident, listIncidents } from '../services/incidents.js'
import {
  buildReviewPrompt,
  classifyVerificationFailure,
  getConfiguredStepMaxAttempts,
  normalizeReviewOutput,
  resetRunCodexTurnForTesting,
  runAutomaticTicketWorkflow,
  runTicketWorkflow,
  setRunCodexTurnForTesting,
} from '../services/ticket-orchestrator.js'
import {
  appendStageReview,
  createTicket,
  deleteTicket,
  getTicket,
  replaceStepOutput,
  setTicketPlanningThreadId,
  updateStepStatus,
  type VerificationRun,
} from '../services/tickets.js'

const RUNTIME_SETTINGS_PATH_ENV = 'INTENTLANE_CODEX_RUNTIME_SETTINGS_PATH'

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
  }).trim()
}

function gitCommit(cwd: string, message: string) {
  git(cwd, '-c', 'user.name=Ticket Test', '-c', 'user.email=ticket@example.com', 'commit', '-m', message)
}

function createRepoFixture() {
  const root = mkdtempSync(join(tmpdir(), 'ticket-orchestrator-'))
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

function createGradleProjectFixture() {
  const projectPath = mkdtempSync(join(tmpdir(), 'ticket-orchestrator-gradle-'))
  writeFileSync(join(projectPath, 'settings.gradle'), "rootProject.name = 'fixture'\n", 'utf8')
  writeFileSync(join(projectPath, 'build.gradle'), 'plugins {}\n', 'utf8')
  writeFileSync(join(projectPath, 'gradlew'), '#!/bin/sh\nexit 0\n', 'utf8')
  return projectPath
}

function extractCoordinatorSection(prompt: string, startMarker: string, endMarker: string) {
  const startIndex = prompt.indexOf(startMarker)
  if (startIndex < 0) {
    return ''
  }

  const sectionStart = startIndex + startMarker.length
  const endIndex = prompt.indexOf(endMarker, sectionStart)
  return (endIndex >= 0 ? prompt.slice(sectionStart, endIndex) : prompt.slice(sectionStart)).trim()
}

function buildCoordinatorStubDecision(prompt: string) {
  const failureSummary = extractCoordinatorSection(prompt, 'Latest failure summary:\n', '\n\nEvidence:')
  const evidence = extractCoordinatorSection(prompt, 'Evidence:\n', '\n\nExisting planning block:')
  const signalText = [failureSummary, evidence].filter(Boolean).join('\n')
  const remediationNotes = failureSummary || evidence || '실패 근거를 반영해 다음 단계를 진행하세요.'
  const clarificationSignal =
    /clarification|ambiguous|contradict|scenario|non-goal|open question|요구사항 설명|요구사항 보완|시나리오|비목표|모호|상충|추가 설명/i.test(
      signalText
    )
  const decisionSignal = /정책|결정|선택|trade-?off|either|어느 쪽|둘 중|판단/i.test(signalText)
  const planSignal =
    /acceptance criteria mismatch|acceptance|criterion|criteria|scope|범위|request|spec|설계|interface|contract|계획/i.test(
      signalText
    )

  if (prompt.includes('Trigger: plan_review_failed')) {
    if (clarificationSignal) {
      return {
        kind: 'needs_request_clarification',
        rationale: '요구사항 설명 보완이 먼저 필요합니다.',
        remediationNotes,
        confidence: 'high' as const,
      }
    }

    if (decisionSignal) {
      return {
        kind: 'needs_decision',
        rationale: '사람의 정책 결정 없이는 계획 방향을 확정할 수 없습니다.',
        remediationNotes,
        confidence: 'high' as const,
      }
    }

    return {
      kind: 'retry_plan',
      rationale: '계획을 보완해 같은 planning thread에서 다시 시도할 수 있습니다.',
      remediationNotes,
      confidence: 'medium' as const,
    }
  }

  if (clarificationSignal) {
    return {
      kind: 'needs_request_clarification',
      rationale: '요구사항 설명 보완이 먼저 필요합니다.',
      remediationNotes,
      confidence: 'high' as const,
    }
  }

  if (decisionSignal) {
    return {
      kind: 'needs_decision',
      rationale: '구현 보완과 계획 재정렬 중 어느 경로가 맞는지 사람이 선택해야 합니다.',
      remediationNotes,
      confidence: 'high' as const,
    }
  }

  if (planSignal) {
    return {
      kind: 'restart_plan',
      rationale: '요구사항 또는 완료기준 정렬 문제라 계획부터 다시 잡아야 합니다.',
      remediationNotes,
      confidence: 'medium' as const,
    }
  }

  return {
    kind: 'restart_implement',
    rationale: '승인된 계획을 유지한 새 run에서 implement부터 다시 시작합니다.',
    remediationNotes,
    confidence: 'medium' as const,
  }
}

function maybeBuildCoordinatorStubResult(opts: { prompt: string; promptFile?: string }) {
  if (opts.promptFile !== 'prompts/ticket-coordinator.txt') {
    return null
  }

  const decision = buildCoordinatorStubDecision(opts.prompt)
  return {
    threadId: 'thread-test',
    finalResponse: JSON.stringify(decision),
    parsedOutput: decision,
  }
}

function makeStubbedTurnRunner(responses: unknown[], prompts: string[]) {
  return async (opts: { prompt: string; promptFile?: string }) => {
    const coordinatorResult = maybeBuildCoordinatorStubResult(opts)
    if (coordinatorResult) {
      return coordinatorResult
    }

    prompts.push(opts.prompt)
    const response = responses.shift()
    if (!response) {
      throw new Error('No stubbed Codex response left')
    }

    return {
      threadId: 'thread-test',
      finalResponse: JSON.stringify(response),
      parsedOutput: response,
    }
  }
}

function cleanupIncidents(ticketId: string, projectId = 'intentlane-codex') {
  for (const incident of listIncidents(projectId, ticketId)) {
    deleteIncident(incident.id)
  }
}

test('ticket flow keeps maxAttempts in private config only', () => {
  const config = loadConfig()
  const analyzeStep = config.flows.ticket.steps.find((step) => step.id === 'analyze')
  const planStep = config.flows.ticket.steps.find((step) => step.id === 'plan')
  const implementStep = config.flows.ticket.steps.find((step) => step.id === 'implement')
  const publicConfig = toPublicConfig(config, createOpenAuthSession())
  const publicAnalyzeStep = publicConfig.flows.ticket.categories
    .flatMap((category) => category.steps)
    .find((step) => step.id === 'analyze')

  assert.equal(analyzeStep?.maxAttempts, 3)
  assert.equal(planStep?.maxAttempts, 3)
  assert.equal(implementStep?.maxAttempts, 3)
  assert.equal(getConfiguredStepMaxAttempts(analyzeStep!), 3)
  assert.equal(publicAnalyzeStep && 'maxAttempts' in publicAnalyzeStep, false)
  assert.equal(publicAnalyzeStep?.agent?.displayName, 'Prometheus')
})

test('classifyVerificationFailure detects dependency and tooling setup issues as environment failures', () => {
  const run: VerificationRun = {
    attempt: 1,
    status: 'failed',
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    commands: [
      {
        id: 'typecheck',
        label: 'Typecheck',
        command: 'pnpm typecheck',
        required: true,
        status: 'failed',
        output: [
          'sh: 1: vite: not found',
          'Local package.json exists, but node_modules missing, did you mean to install?',
        ].join('\n'),
        exitCode: 1,
        durationMs: 10,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      },
    ],
  }

  const classification = classifyVerificationFailure(run)

  assert.equal(classification.kind, 'verification_environment_failed')
  assert.equal(classification.signals.includes('프로젝트 의존성이 설치되지 않았습니다.'), true)
  assert.equal(classification.signals.includes('검증 명령이 필요한 로컬 도구를 찾지 못했습니다.'), true)
})

test('classifyVerificationFailure detects Gradle wrapper path issues as environment failures', () => {
  const run: VerificationRun = {
    attempt: 1,
    status: 'failed',
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    commands: [
      {
        id: 'test',
        label: 'Test',
        command: './gradlew test',
        required: true,
        status: 'failed',
        output: [
          '/bin/sh: 1: ./gradlew: not found',
          "./gradlew: Permission denied",
          "Directory '/tmp/worktree-root' does not contain a Gradle build.",
        ].join('\n'),
        exitCode: 1,
        durationMs: 10,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      },
    ],
  }

  const classification = classifyVerificationFailure(run)

  assert.equal(classification.kind, 'verification_environment_failed')
  assert.equal(classification.signals.includes('Gradle wrapper를 찾지 못했습니다.'), true)
  assert.equal(classification.signals.includes('Gradle wrapper 실행 권한 또는 경로가 잘못되었습니다.'), true)
  assert.equal(classification.signals.includes('검증 명령을 Gradle 프로젝트 루트가 아닌 위치에서 실행했습니다.'), true)
})

test('runTicketWorkflow retries analyze with stage review feedback and verification command grounding', async () => {
  const ticket = createTicket({
    title: 'Analyze retry test',
    description: '분석 재시도 동작을 확인한다.',
    projectId: 'intentlane-codex',
    projectPath: process.cwd(),
    categoryId: 'feature',
    flowStepIds: ['analyze', 'plan', 'implement', 'verify', 'review', 'ready'],
  })

  const prompts: string[] = []
  setRunCodexTurnForTesting(
    makeStubbedTurnRunner(
      [
        {
          summary: '첫 분석',
          affectedAreas: [],
          risks: ['검증 범위 불명확'],
          proposedChecks: ['임의 검증'],
        },
        {
          verdict: 'fail',
          summary: '실제 자동 검증 명령과 맞지 않습니다.',
          blockingFindings: ['실제 자동 검증 명령과 맞지 않는 검증 제안'],
          residualRisks: [],
        },
        {
          summary: '두 번째 분석',
          affectedAreas: [],
          risks: [],
          proposedChecks: ['pnpm typecheck', 'pnpm test'],
        },
        {
          verdict: 'pass',
          summary: '분석이 보완되었습니다.',
          blockingFindings: [],
          residualRisks: [],
        },
      ],
      prompts
    ) as typeof setRunCodexTurnForTesting extends (fn: infer T) => void ? T : never
  )

  try {
    await runTicketWorkflow({
      ticketId: ticket.id,
      stepId: 'analyze',
    })

    const updated = getTicket(ticket.id)
    const analyzeReviews = updated?.stageReviews.filter((review) => review.subjectStepId === 'analyze') ?? []

    assert.equal(analyzeReviews.length, 2)
    assert.equal(analyzeReviews.at(-1)?.verdict, 'pass')
    assert.match(prompts[0] || '', /pnpm typecheck/)
    assert.match(prompts[0] || '', /pnpm test/)
    assert.match(prompts[2] || '', /이전 분석 리뷰 피드백:/)
    assert.match(prompts[2] || '', /실제 자동 검증 명령과 맞지 않는 검증 제안/)
  } finally {
    resetRunCodexTurnForTesting()
    deleteTicket(ticket.id)
  }
})

test('runTicketWorkflow captures verification environment failures as dedicated incidents and stops retrying', async () => {
  const fixture = createRepoFixture()
  const ticket = createTicket({
    title: 'Verification environment incident test',
    description: '검증 환경 실패는 별도 incident kind로 분류해야 한다.',
    projectId: 'intentlane-codex',
    projectPath: fixture.repoPath,
    categoryId: 'feature',
    flowStepIds: ['analyze', 'plan', 'implement', 'verify', 'review', 'ready'],
  })
  const now = new Date().toISOString()

  writeFileSync(
    join(fixture.repoPath, 'package.json'),
    JSON.stringify(
      {
        name: 'ticket-workflow-fixture',
        private: true,
        scripts: {
          typecheck: 'sh -c "echo Local package.json exists, but node_modules missing, did you mean to install?; exit 1"',
          test: "sh -c \"echo TS2307: Cannot find module 'react'; exit 1\"",
          build: 'sh -c "echo sh: 1: vite: not found; exit 1"',
        },
      },
      null,
      2
    ),
    'utf8'
  )
  git(fixture.repoPath, 'add', 'package.json')
  gitCommit(fixture.repoPath, 'fixture package manifest')

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
    startedAt: now,
    completedAt: now,
  })

  setRunCodexTurnForTesting(
    makeStubbedTurnRunner([{}], []) as Parameters<typeof setRunCodexTurnForTesting>[0]
  )

  try {
    setIncidentAutoResolutionEnabledForTesting(false)

    await runTicketWorkflow({
      ticketId: ticket.id,
      stepId: 'implement',
    })

    const incident = listIncidents(ticket.projectId, ticket.id).find(
      (entry) => entry.trigger.kind === 'verification_environment_failed'
    )
    const updated = getTicket(ticket.id)

    assert.ok(incident)
    assert.equal(updated?.attemptCount, 1)
    assert.equal(updated?.runState, 'failed')
    assert.equal(updated?.reviewRuns.length, 0)
    assert.equal(updated?.verificationRuns.length, 1)
    assert.match(incident?.trigger.message ?? '', /검증 환경 문제로 분류/)
    assert.match(incident?.trigger.message ?? '', /node_modules missing/)
  } finally {
    resetIncidentAutoResolutionEnabledForTesting()
    resetRunCodexTurnForTesting()
    cleanupIncidents(ticket.id)
    deleteTicket(ticket.id)
    fixture.cleanup()
  }
})

test('runAutomaticTicketWorkflow preflights normalized Gradle wrapper commands and stops on missing wrapper', async () => {
  const previousRuntimeSettingsPath = process.env[RUNTIME_SETTINGS_PATH_ENV]
  const runtimeDir = mkdtempSync(join(tmpdir(), 'ticket-orchestrator-gradle-runtime-'))
  const runtimeSettingsPath = join(runtimeDir, 'runtime.settings.json')
  const gradleProjectPath = mkdtempSync(join(tmpdir(), 'ticket-orchestrator-gradle-missing-'))
  process.env[RUNTIME_SETTINGS_PATH_ENV] = runtimeSettingsPath

  writeFileSync(join(gradleProjectPath, 'settings.gradle'), "rootProject.name = 'fixture'\n", 'utf8')
  writeFileSync(join(gradleProjectPath, 'build.gradle'), 'plugins {}\n', 'utf8')
  writeFileSync(
    runtimeSettingsPath,
    JSON.stringify(
      {
        projects: [
          {
            id: 'backend',
            label: 'backend',
            path: gradleProjectPath,
            verificationCommands: [{ id: 'test', label: 'Test', command: './gradlew test' }],
          },
        ],
      },
      null,
      2
    ),
    'utf8'
  )
  reloadConfig()

  const ticket = createTicket({
    title: 'Gradle wrapper preflight test',
    description: 'verify 전에 gradle wrapper preflight가 실행되어야 한다.',
    projectId: 'backend',
    projectPath: gradleProjectPath,
    categoryId: 'feature',
    flowStepIds: ['analyze', 'plan', 'implement', 'verify', 'review', 'ready'],
  })
  const now = new Date().toISOString()

  replaceStepOutput(ticket.id, 'analyze', '## 분석 결과\n\nGradle 검증')
  replaceStepOutput(ticket.id, 'plan', '## 구현 계획\n\nGradle 계획')
  updateStepStatus(ticket.id, 'analyze', 'done')
  updateStepStatus(ticket.id, 'plan', 'done')
  appendStageReview(ticket.id, {
    id: 'gradle-preflight-analyze-pass',
    subjectStepId: 'analyze',
    label: '분석',
    attempt: 1,
    verdict: 'pass',
    summary: '분석 통과',
    blockingFindings: [],
    residualRisks: [],
    output: '분석 통과',
    startedAt: now,
    completedAt: now,
  })
  appendStageReview(ticket.id, {
    id: 'gradle-preflight-plan-pass',
    subjectStepId: 'plan',
    label: '계획',
    attempt: 1,
    verdict: 'pass',
    summary: '계획 통과',
    blockingFindings: [],
    residualRisks: [],
    output: '계획 통과',
    startedAt: now,
    completedAt: now,
  })

  setRunCodexTurnForTesting(
    (async () => {
      throw new Error('Coordinator should not run for verification environment failures')
    }) as Parameters<typeof setRunCodexTurnForTesting>[0]
  )

  try {
    setIncidentAutoResolutionEnabledForTesting(false)

    await runAutomaticTicketWorkflow({
      ticketId: ticket.id,
      startStepId: 'verify',
    })

    const updated = getTicket(ticket.id)
    const incident = listIncidents(ticket.projectId, ticket.id).find(
      (entry) => entry.trigger.kind === 'verification_environment_failed'
    )

    assert.equal(updated?.runState, 'failed')
    assert.equal(updated?.verificationRuns.length, 1)
    assert.equal(updated?.verificationRuns[0]?.commands[0]?.command, 'sh ./gradlew test')
    assert.match(updated?.verificationRuns[0]?.commands[0]?.output ?? '', /\.\/gradlew: not found/)
    assert.ok(incident)
  } finally {
    resetIncidentAutoResolutionEnabledForTesting()
    resetRunCodexTurnForTesting()
    cleanupIncidents(ticket.id, ticket.projectId)
    deleteTicket(ticket.id)
    if (previousRuntimeSettingsPath === undefined) {
      delete process.env[RUNTIME_SETTINGS_PATH_ENV]
    } else {
      process.env[RUNTIME_SETTINGS_PATH_ENV] = previousRuntimeSettingsPath
    }
    reloadConfig()
    rmSync(runtimeDir, { recursive: true, force: true })
    rmSync(gradleProjectPath, { recursive: true, force: true })
  }
})

test('runAutomaticTicketWorkflow marks later verification commands as skipped after the first required failure', async () => {
  const fixture = createRepoFixture()
  const ticket = createTicket({
    title: 'Verification fail-fast test',
    description: '첫 필수 검증 실패 후 나머지 검증은 skipped로 남겨야 한다.',
    projectId: 'intentlane-codex',
    projectPath: fixture.repoPath,
    categoryId: 'feature',
    flowStepIds: ['analyze', 'plan', 'implement', 'verify', 'review', 'ready'],
  })

  mkdirSync(join(fixture.repoPath, 'node_modules'), { recursive: true })
  writeFileSync(
    join(fixture.repoPath, 'package.json'),
    JSON.stringify(
      {
        name: 'verification-fail-fast-fixture',
        private: true,
        scripts: {
          typecheck: "node -e \"console.error('Typecheck broke intentionally'); process.exit(1)\"",
          test: "node -e \"require('node:fs').writeFileSync('test-ran.txt', 'ran')\"",
          build: "node -e \"require('node:fs').writeFileSync('build-ran.txt', 'ran')\"",
        },
      },
      null,
      2
    ),
    'utf8'
  )

  setRunCodexTurnForTesting(
    (async (opts) => {
      if (opts.promptFile !== 'prompts/ticket-coordinator.txt') {
        throw new Error(`Unexpected prompt file: ${opts.promptFile}`)
      }

      const decision = {
        kind: 'needs_decision' as const,
        rationale: '검증 실패를 같은 run 수선으로 볼지 계획 재정렬로 볼지 선택이 필요합니다.',
        remediationNotes: '첫 필수 검증 실패만 반영해 다음 경로를 선택하세요.',
        confidence: 'high' as const,
      }
      return {
        threadId: 'thread-test',
        finalResponse: JSON.stringify(decision),
        parsedOutput: decision,
      }
    }) as Parameters<typeof setRunCodexTurnForTesting>[0]
  )

  try {
    await runAutomaticTicketWorkflow({
      ticketId: ticket.id,
      startStepId: 'verify',
    })

    const updated = getTicket(ticket.id)
    assert.equal(updated?.runState, 'needs_decision')
    assert.equal(updated?.verificationRuns.length, 1)
    assert.deepEqual(
      updated?.verificationRuns[0]?.commands.map((command) => command.status),
      ['failed', 'skipped', 'skipped']
    )
    assert.equal(updated?.verificationRuns[0]?.commands[1]?.output, '앞선 필수 검증이 실패해 실행하지 않았습니다.')
  } finally {
    resetRunCodexTurnForTesting()
    deleteTicket(ticket.id)
    fixture.cleanup()
  }
})

test('runTicketWorkflow retries plan with stage review feedback and verification command grounding', async () => {
  const ticket = createTicket({
    title: 'Plan retry test',
    description: '계획 재시도 동작을 확인한다.',
    projectId: 'intentlane-codex',
    projectPath: process.cwd(),
    categoryId: 'feature',
    flowStepIds: ['analyze', 'plan', 'implement', 'verify', 'review', 'ready'],
  })

  const prompts: string[] = []
  setRunCodexTurnForTesting(
    makeStubbedTurnRunner(
      [
        {
          summary: '첫 계획',
          changes: [],
          order: ['1'],
          acceptanceCriteria: ['goalAssessment가 포함된다'],
          verificationPlan: ['느린 통합 테스트만 수행한다'],
        },
        {
          verdict: 'fail',
          summary: '자동 검증과 맞지 않는 계획입니다.',
          blockingFindings: ['실제 자동 검증에서 실행되지 않는 테스트만 검증 계획에 포함되어 있습니다.'],
          residualRisks: [],
        },
        {
          summary: '두 번째 계획',
          changes: [],
          order: ['1'],
          acceptanceCriteria: ['goalAssessment가 포함된다'],
          verificationPlan: ['pnpm typecheck', 'pnpm test', 'pnpm build'],
        },
        {
          verdict: 'pass',
          summary: '계획이 보완되었습니다.',
          blockingFindings: [],
          residualRisks: [],
        },
      ],
      prompts
    ) as typeof setRunCodexTurnForTesting extends (fn: infer T) => void ? T : never
  )

  try {
    replaceStepOutput(
      ticket.id,
      'analyze',
      ['## 분석 결과', '', '기존 분석', '', '### 영향 범위', '- 없음', '', '### 주요 리스크', '- 없음', '', '### 추천 검증', '- pnpm test', ''].join('\n')
    )
    updateStepStatus(ticket.id, 'analyze', 'done')

    await runTicketWorkflow({
      ticketId: ticket.id,
      stepId: 'plan',
    })

    const updated = getTicket(ticket.id)
    const planReviews = updated?.stageReviews.filter((review) => review.subjectStepId === 'plan') ?? []

    assert.equal(planReviews.length, 2)
    assert.equal(planReviews.at(-1)?.verdict, 'pass')
    assert.match(prompts[0] || '', /pnpm typecheck/)
    assert.match(prompts[0] || '', /pnpm build/)
    assert.match(prompts[2] || '', /이전 계획 리뷰 피드백:/)
    assert.match(prompts[2] || '', /실제 자동 검증에서 실행되지 않는 테스트만 검증 계획에 포함되어 있습니다\./)
  } finally {
    resetRunCodexTurnForTesting()
    deleteTicket(ticket.id)
  }
})

test('runTicketWorkflow reuses the persisted coordinator thread across repeated plan-review coordination', async () => {
  const ticket = createTicket({
    title: 'Coordinator thread reuse test',
    description: '계획 리뷰 실패를 여러 번 조율할 때 coordinator thread를 이어서 사용해야 한다.',
    projectId: 'intentlane-codex',
    projectPath: process.cwd(),
    categoryId: 'feature',
    flowStepIds: ['analyze', 'plan', 'implement', 'verify', 'review', 'ready'],
  })

  const coordinatorThreadIds: Array<string | undefined> = []
  let coordinatorCalls = 0
  const responses = [
    {
      summary: '첫 계획',
      changes: [],
      order: ['1'],
      acceptanceCriteria: ['goalAssessment가 포함된다'],
      verificationPlan: ['느린 통합 테스트만 수행한다'],
    },
    {
      verdict: 'fail' as const,
      summary: '자동 검증과 맞지 않는 계획입니다.',
      blockingFindings: ['실제 자동 검증에서 실행되지 않는 테스트만 검증 계획에 포함되어 있습니다.'],
      residualRisks: [],
    },
    {
      summary: '두 번째 계획',
      changes: [],
      order: ['1'],
      acceptanceCriteria: ['goalAssessment가 포함된다'],
      verificationPlan: ['pnpm typecheck', 'pnpm test', 'pnpm build'],
    },
    {
      verdict: 'fail' as const,
      summary: '여전히 계획 방향을 자동으로 확정하기 어렵습니다.',
      blockingFindings: ['구현 보완으로 갈지 계획을 다시 잡을지 사람이 선택해야 합니다.'],
      residualRisks: [],
    },
  ]

  setRunCodexTurnForTesting(
    (async (opts) => {
      if (opts.promptFile === 'prompts/ticket-coordinator.txt') {
        coordinatorThreadIds.push(opts.threadId)
        coordinatorCalls += 1
        const decision =
          coordinatorCalls === 1
            ? {
                kind: 'retry_plan' as const,
                rationale: '같은 coordinator thread에서 계획 보완 방향을 이어갑니다.',
                remediationNotes: '자동 검증과 맞는 검증 계획으로 다시 작성하세요.',
                confidence: 'medium' as const,
              }
            : {
                kind: 'needs_decision' as const,
                rationale: '더 이상 자동으로는 계획 방향을 확정할 수 없습니다.',
                remediationNotes: '구현 보완과 계획 재정렬 중 경로를 선택하세요.',
                confidence: 'high' as const,
              }

        return {
          threadId: 'thread-coordinator',
          finalResponse: JSON.stringify(decision),
          parsedOutput: decision,
        }
      }

      const response = responses.shift()
      if (!response) {
        throw new Error(`No stubbed Codex response left for ${opts.promptFile}`)
      }

      return {
        threadId: 'thread-test',
        finalResponse: JSON.stringify(response),
        parsedOutput: response,
      }
    }) as Parameters<typeof setRunCodexTurnForTesting>[0]
  )

  try {
    replaceStepOutput(
      ticket.id,
      'analyze',
      ['## 분석 결과', '', '기존 분석', '', '### 영향 범위', '- 없음', '', '### 주요 리스크', '- 없음', '', '### 추천 검증', '- pnpm test', ''].join('\n')
    )
    updateStepStatus(ticket.id, 'analyze', 'done')

    await runTicketWorkflow({
      ticketId: ticket.id,
      stepId: 'plan',
    })

    const updated = getTicket(ticket.id)

    assert.deepEqual(coordinatorThreadIds, [undefined, 'thread-coordinator'])
    assert.equal(updated?.coordinatorThreadId, 'thread-coordinator')
    assert.equal(updated?.runState, 'needs_decision')
    assert.equal(updated?.planningBlock?.source, 'plan_review')
  } finally {
    resetRunCodexTurnForTesting()
    deleteTicket(ticket.id)
  }
})

test('runTicketWorkflow records a planning session recovery event when resume fallback starts a fresh thread', async () => {
  const ticket = createTicket({
    title: 'Planning session recovery test',
    description: 'planning thread resume 실패 시 새 세션으로 이어간 사실을 timeline에 남겨야 한다.',
    projectId: 'intentlane-codex',
    projectPath: process.cwd(),
    categoryId: 'feature',
    flowStepIds: ['analyze', 'plan', 'implement', 'verify', 'review', 'ready'],
  })

  setTicketPlanningThreadId(ticket.id, 'stale-plan-thread')
  let callCount = 0
  const planOutput = {
    summary: '복구된 세션에서 다시 계획을 정리했습니다.',
    changes: [],
    order: ['1'],
    acceptanceCriteria: ['세션 복구 사실이 timeline에 남는다'],
    verificationPlan: ['pnpm typecheck'],
  }

  setRunCodexTurnForTesting(
    (async (opts) => {
      if (opts.promptFile === 'prompts/ticket-stage-review.txt') {
        const review = {
          verdict: 'pass' as const,
          summary: '계획 리뷰 통과',
          blockingFindings: [],
          residualRisks: [],
        }

        return {
          threadId: 'thread-stage-review',
          finalResponse: JSON.stringify(review),
          parsedOutput: review,
        }
      }

      if (opts.promptFile !== 'prompts/ticket-plan.txt') {
        return {
          threadId: 'thread-other',
          finalResponse: JSON.stringify({
            summary: '기본 응답',
            affectedAreas: [],
            risks: [],
            proposedChecks: [],
          }),
          parsedOutput: {
            summary: '기본 응답',
            affectedAreas: [],
            risks: [],
            proposedChecks: [],
          },
        }
      }

      callCount += 1
      if (callCount === 1) {
        assert.equal(opts.threadId, 'stale-plan-thread')
        return {
          threadId: 'stale-plan-thread',
          finalResponse: '',
        }
      }

      assert.equal(opts.threadId, undefined)
      await opts.onEvent?.({
        type: 'init',
        data: { threadId: 'fresh-plan-thread' },
      })

      return {
        threadId: 'fresh-plan-thread',
        finalResponse: JSON.stringify(planOutput),
        parsedOutput: planOutput,
      }
    }) as Parameters<typeof setRunCodexTurnForTesting>[0]
  )

  try {
    replaceStepOutput(
      ticket.id,
      'analyze',
      ['## 분석 결과', '', '기존 분석', '', '### 영향 범위', '- 없음', '', '### 주요 리스크', '- 없음', '', '### 추천 검증', '- pnpm typecheck', ''].join('\n')
    )
    updateStepStatus(ticket.id, 'analyze', 'done')

    await runTicketWorkflow({
      ticketId: ticket.id,
      stepId: 'plan',
    })

    const updated = getTicket(ticket.id)

    assert.equal(callCount, 2)
    assert.equal(updated?.planningThreadId, 'fresh-plan-thread')
    assert.equal(
      updated?.timeline.some((entry) => entry.type === 'system' && entry.title.includes('계획 세션을 복구하지 못해 새 세션에서 이어갑니다.')),
      true
    )
  } finally {
    resetRunCodexTurnForTesting()
    deleteTicket(ticket.id)
  }
})

test('runTicketWorkflow grounds runtime Gradle projects with inferred verification commands', async () => {
  const previousRuntimeSettingsPath = process.env[RUNTIME_SETTINGS_PATH_ENV]
  const runtimeDir = mkdtempSync(join(tmpdir(), 'ticket-orchestrator-runtime-'))
  const runtimeSettingsPath = join(runtimeDir, 'runtime.settings.json')
  const gradleProjectPath = createGradleProjectFixture()
  process.env[RUNTIME_SETTINGS_PATH_ENV] = runtimeSettingsPath
  writeFileSync(
    runtimeSettingsPath,
    JSON.stringify(
      {
        projects: [
          {
            id: 'backend',
            label: 'backend',
            path: gradleProjectPath,
          },
        ],
      },
      null,
      2
    ),
    'utf8'
  )
  reloadConfig()

  const ticket = createTicket({
    title: 'Runtime project plan grounding test',
    description: 'runtime project의 검증 명령 추론을 확인한다.',
    projectId: 'backend',
    projectPath: gradleProjectPath,
    categoryId: 'feature',
    flowStepIds: ['analyze', 'plan', 'implement', 'verify', 'review', 'ready'],
  })

  const prompts: string[] = []
  setRunCodexTurnForTesting(
    makeStubbedTurnRunner(
      [
        {
          summary: 'Gradle 계획',
          changes: [],
          order: ['1'],
          acceptanceCriteria: ['Gradle 검증 명령이 유지된다'],
          verificationPlan: ['./gradlew test', './gradlew build'],
        },
        {
          verdict: 'pass',
          summary: '계획이 적절합니다.',
          blockingFindings: [],
          residualRisks: [],
        },
      ],
      prompts
    ) as typeof setRunCodexTurnForTesting extends (fn: infer T) => void ? T : never
  )

  try {
    replaceStepOutput(
      ticket.id,
      'analyze',
      ['## 분석 결과', '', '기존 분석', '', '### 영향 범위', '- 없음', '', '### 주요 리스크', '- 없음', '', '### 추천 검증', '- ./gradlew test', ''].join('\n')
    )
    updateStepStatus(ticket.id, 'analyze', 'done')

    await runTicketWorkflow({
      ticketId: ticket.id,
      stepId: 'plan',
    })

    assert.match(prompts[0] || '', /Test: `sh \.\/gradlew test`/)
    assert.match(prompts[0] || '', /Build: `sh \.\/gradlew build`/)
    assert.doesNotMatch(prompts[0] || '', /pnpm typecheck/)
  } finally {
    resetRunCodexTurnForTesting()
    deleteTicket(ticket.id)
    if (previousRuntimeSettingsPath === undefined) {
      delete process.env[RUNTIME_SETTINGS_PATH_ENV]
    } else {
      process.env[RUNTIME_SETTINGS_PATH_ENV] = previousRuntimeSettingsPath
    }
    reloadConfig()
    rmSync(runtimeDir, { recursive: true, force: true })
    rmSync(gradleProjectPath, { recursive: true, force: true })
  }
})

test('runAutomaticTicketWorkflow grounds implement prompts with analysis, approved plan, and verification context', async () => {
  const fixture = createRepoFixture()
  const ticket = createTicket({
    title: 'Implement prompt grounding test',
    description: 'implement 프롬프트에 plan과 verify 컨텍스트가 포함되어야 한다.',
    projectId: 'intentlane-codex',
    projectPath: fixture.repoPath,
    categoryId: 'feature',
    flowStepIds: ['analyze', 'plan', 'implement', 'verify', 'review', 'ready'],
  })

  writeFileSync(
    join(fixture.repoPath, 'package.json'),
    JSON.stringify(
      {
        name: 'implement-prompt-fixture',
        private: true,
        scripts: {
          typecheck: "node -e \"process.exit(0)\"",
          test: "node -e \"process.exit(0)\"",
          build: "node -e \"process.exit(0)\"",
        },
      },
      null,
      2
    ),
    'utf8'
  )
  git(fixture.repoPath, 'add', 'package.json')
  gitCommit(fixture.repoPath, 'add package manifest for implement prompt test')

  replaceStepOutput(
    ticket.id,
    'analyze',
    [
      '## 분석 결과',
      '',
      '기존 분석',
      '',
      '### 영향 범위',
      '- `tracked.txt`: 구현 대상',
      '',
      '### 주요 리스크',
      '- 없음',
      '',
      '### 추천 검증',
      '- pnpm typecheck',
      '- pnpm test',
      '',
    ].join('\n')
  )
  replaceStepOutput(
    ticket.id,
    'plan',
    [
      '## 구현 계획',
      '',
      'tracked.txt를 갱신한다.',
      '',
      '### 변경 항목',
      '- `tracked.txt`: 문구 갱신 (사용자 노출 변경 반영)',
      '',
      '### 작업 순서',
      '- tracked.txt 수정',
      '- verify/review 확인',
      '',
      '### 완료 기준',
      '- tracked.txt가 갱신된다',
      '',
      '### 검증 계획',
      '- pnpm typecheck',
      '- pnpm test',
      '',
    ].join('\n')
  )
  updateStepStatus(ticket.id, 'analyze', 'done')
  updateStepStatus(ticket.id, 'plan', 'done')
  appendStageReview(ticket.id, {
    id: 'implement-prompt-analyze-pass',
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
    id: 'implement-prompt-plan-pass',
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

  let implementPrompt = ''
  setRunCodexTurnForTesting(
    (async (opts) => {
      if (opts.promptFile === 'prompts/ticket-implement.txt') {
        implementPrompt = opts.prompt
        writeFileSync(join(opts.cwd, 'tracked.txt'), 'implemented\n', 'utf8')
        return {
          threadId: 'thread-test',
          finalResponse: 'tracked.txt를 수정했습니다.',
        }
      }

      const review = {
        verdict: 'pass' as const,
        summary: '승인된 계획 범위 안에서 구현이 완료되었습니다.',
        goalAssessment: {
          request: {
            status: 'not_available' as const,
            evidence: [],
          },
          ticket: {
            status: 'aligned' as const,
            evidence: ['tracked.txt 변경만 포함되었습니다.'],
          },
          acceptanceCriteria: [
            {
              criterion: 'tracked.txt가 갱신된다',
              status: 'met' as const,
              evidence: ['tracked.txt가 실제로 갱신되었습니다.'],
            },
          ],
        },
        blockingFindings: [],
        residualRisks: [],
        releaseNotes: ['tracked.txt 수정'],
      }

      return {
        threadId: 'thread-test',
        finalResponse: JSON.stringify(review),
        parsedOutput: review,
      }
    }) as Parameters<typeof setRunCodexTurnForTesting>[0]
  )

  try {
    await runAutomaticTicketWorkflow({
      ticketId: ticket.id,
      startStepId: 'implement',
    })

    assert.match(implementPrompt, /분석 결과:\n## 분석 결과/)
    assert.match(implementPrompt, /승인된 계획:\n## 구현 계획/)
    assert.match(implementPrompt, /완료 기준:\n- tracked\.txt가 갱신된다/)
    assert.match(implementPrompt, /예정된 자동 검증 명령:\n- Typecheck: `pnpm typecheck`/)
    assert.match(implementPrompt, /예정된 자동 검증 명령:[\s\S]*- Test: `pnpm test`/)
    assert.match(implementPrompt, /구현 규칙:/)
    assert.match(implementPrompt, /계획에 없는 경로는 명확한 실패 근거가 없다면 건드리지 않는다/)
  } finally {
    resetRunCodexTurnForTesting()
    deleteTicket(ticket.id)
    fixture.cleanup()
  }
})

test('buildReviewPrompt and normalizeReviewOutput enforce request, ticket, and acceptance-criteria goal checks', () => {
  const request = createClientRequest({
    requester: 'tester',
    title: 'Request origin',
    template: {
      problem: '기존 request 목표를 유지해야 한다.',
      desiredOutcome: 'request 목표가 그대로 충족되어야 한다.',
      userScenarios: '운영자가 최종 리뷰에서 linked request 기준을 확인한다.',
    },
    projectId: 'intentlane-codex',
    categoryId: 'feature',
  })
  const ticket = createTicket({
    title: 'Goal assessment ticket',
    description: 'ticket 목표가 최종 리뷰에서 검증되어야 한다.',
    projectId: 'intentlane-codex',
    projectPath: process.cwd(),
    categoryId: 'feature',
    flowStepIds: ['analyze', 'plan', 'implement', 'verify', 'review', 'ready'],
    linkedRequestId: request.id,
  })

  try {
    replaceStepOutput(
      ticket.id,
      'plan',
      [
        '## 구현 계획',
        '',
        '목표 기반 계획',
        '',
        '### 변경 항목',
        '- `src/server/services/ticket-orchestrator.ts`: goal assessment 추가 (최종 리뷰 강화)',
        '',
        '### 작업 순서',
        '- 리뷰 프롬프트 확장',
        '',
        '### 완료 기준',
        '- goalAssessment가 최종 리포트에 포함된다',
        '- linked request 기준 충족 여부를 확인한다',
        '',
        '### 검증 계획',
        '- pnpm typecheck',
        '',
      ].join('\n')
    )

    const prompt = buildReviewPrompt(ticket, undefined, 'Diff stat:\n src/server/services/ticket-orchestrator.ts | 12 ++++++')
    assert.match(prompt, /Request origin/)
    assert.match(prompt, /request 목표가 그대로 충족되어야 한다\./)
    assert.match(prompt, /Desired outcome:/)
    assert.match(prompt, /User scenarios:/)
    assert.match(prompt, /goalAssessment가 최종 리포트에 포함된다/)
    assert.match(prompt, /linked request 기준 충족 여부를 확인한다/)

    const normalized = normalizeReviewOutput(
      {
        verdict: 'pass',
        summary: '일부 goal은 아직 미충족입니다.',
        goalAssessment: {
          request: {
            status: 'partial',
            evidence: ['request 조건 일부만 반영되었습니다.'],
          },
          ticket: {
            status: 'aligned',
            evidence: ['ticket 요구사항은 반영되었습니다.'],
          },
          acceptanceCriteria: [
            {
              criterion: 'goalAssessment가 최종 리포트에 포함된다',
              status: 'met',
              evidence: ['FinalReport 타입에 필드를 추가했습니다.'],
            },
          ],
        },
        blockingFindings: [],
        residualRisks: [],
        releaseNotes: ['goal assessment 추가'],
      },
      {
        expectedAcceptanceCriteria: [
          'goalAssessment가 최종 리포트에 포함된다',
          'linked request 기준 충족 여부를 확인한다',
        ],
        hasLinkedRequest: true,
      }
    )

    assert.equal(normalized.verdict, 'fail')
    assert.ok(
      normalized.blockingFindings.some((finding) => finding.includes('연결된 request 충족 판정이 partial입니다.'))
    )
    assert.ok(
      normalized.blockingFindings.some((finding) => finding.includes('linked request 기준 충족 여부를 확인한다'))
    )
    assert.equal(normalized.goalAssessment.acceptanceCriteria.length, 2)
    assert.equal(normalized.goalAssessment.acceptanceCriteria[1]?.status, 'unmet')
  } finally {
    deleteTicket(ticket.id)
    deleteClientRequest(request.id)
  }
})

test('runTicketWorkflow classifies repeated plan-review failures as planning blocks', async () => {
  const ticket = createTicket({
    title: 'Plan block test',
    description: '계획 단계에서 정책 결정 필요 상태를 확인한다.',
    projectId: 'intentlane-codex',
    projectPath: process.cwd(),
    categoryId: 'feature',
    flowStepIds: ['analyze', 'plan', 'implement', 'verify', 'review', 'ready'],
  })

  setRunCodexTurnForTesting(
    makeStubbedTurnRunner([
      {
        summary: '첫 계획',
        changes: [],
        order: ['1'],
        acceptanceCriteria: ['정책 결정 필요'],
        verificationPlan: ['pnpm typecheck'],
      },
      {
        verdict: 'fail',
        summary: '정책 결정이 먼저 필요합니다.',
        blockingFindings: ['잘못된 입력을 400으로 볼지 기존 정책을 유지할지 결정이 필요합니다.'],
        residualRisks: ['검증 명령 매핑도 함께 확정되어야 합니다.'],
      },
      {
        summary: '두 번째 계획',
        changes: [],
        order: ['1'],
        acceptanceCriteria: ['정책 결정 필요'],
        verificationPlan: ['pnpm typecheck'],
      },
      {
        verdict: 'fail',
        summary: '정책 결정이 먼저 필요합니다.',
        blockingFindings: ['잘못된 입력을 400으로 볼지 기존 정책을 유지할지 결정이 필요합니다.'],
        residualRisks: ['검증 명령 매핑도 함께 확정되어야 합니다.'],
      },
      {
        summary: '세 번째 계획',
        changes: [],
        order: ['1'],
        acceptanceCriteria: ['정책 결정 필요'],
        verificationPlan: ['pnpm typecheck'],
      },
      {
        verdict: 'fail',
        summary: '정책 결정이 먼저 필요합니다.',
        blockingFindings: ['잘못된 입력을 400으로 볼지 기존 정책을 유지할지 결정이 필요합니다.'],
        residualRisks: ['검증 명령 매핑도 함께 확정되어야 합니다.'],
      },
    ], []) as typeof setRunCodexTurnForTesting extends (fn: infer T) => void ? T : never
  )

  try {
    replaceStepOutput(
      ticket.id,
      'analyze',
      ['## 분석 결과', '', '기존 분석', '', '### 영향 범위', '- 없음', '', '### 주요 리스크', '- 없음', '', '### 추천 검증', '- pnpm typecheck', ''].join('\n')
    )
    updateStepStatus(ticket.id, 'analyze', 'done')

    await runTicketWorkflow({
      ticketId: ticket.id,
      stepId: 'plan',
    })

    const updated = getTicket(ticket.id)
    assert.equal(updated?.runState, 'needs_decision')
    assert.equal(updated?.planningBlock?.kind, 'needs_decision')
    assert.match(updated?.planningBlock?.summary || '', /정책 결정/)
  } finally {
    resetRunCodexTurnForTesting()
    deleteTicket(ticket.id)
  }
})

test('runTicketWorkflow can classify repeated plan-review failures as request clarification', async () => {
  const ticket = createTicket({
    title: 'Request clarification block test',
    description: '계획 단계에서 request clarification 상태를 확인한다.',
    projectId: 'intentlane-codex',
    projectPath: process.cwd(),
    categoryId: 'feature',
    flowStepIds: ['analyze', 'plan', 'implement', 'verify', 'review', 'ready'],
  })

  setRunCodexTurnForTesting(
    makeStubbedTurnRunner([
      {
        summary: '첫 계획',
        changes: [],
        order: ['1'],
        acceptanceCriteria: ['request clarification 필요'],
        verificationPlan: ['pnpm typecheck'],
      },
      {
        verdict: 'fail',
        summary: '요구사항 설명이 더 필요합니다.',
        blockingFindings: ['대표 사용자 시나리오가 부족해 구현 범위를 확정할 수 없습니다.'],
        residualRisks: ['비목표가 비어 있어 범위가 넓어질 수 있습니다.'],
      },
      {
        summary: '두 번째 계획',
        changes: [],
        order: ['1'],
        acceptanceCriteria: ['request clarification 필요'],
        verificationPlan: ['pnpm typecheck'],
      },
      {
        verdict: 'fail',
        summary: '요구사항 설명이 더 필요합니다.',
        blockingFindings: ['대표 사용자 시나리오가 부족해 구현 범위를 확정할 수 없습니다.'],
        residualRisks: ['비목표가 비어 있어 범위가 넓어질 수 있습니다.'],
      },
      {
        summary: '세 번째 계획',
        changes: [],
        order: ['1'],
        acceptanceCriteria: ['request clarification 필요'],
        verificationPlan: ['pnpm typecheck'],
      },
      {
        verdict: 'fail',
        summary: '요구사항 설명이 더 필요합니다.',
        blockingFindings: ['대표 사용자 시나리오가 부족해 구현 범위를 확정할 수 없습니다.'],
        residualRisks: ['비목표가 비어 있어 범위가 넓어질 수 있습니다.'],
      },
    ], []) as typeof setRunCodexTurnForTesting extends (fn: infer T) => void ? T : never
  )

  try {
    replaceStepOutput(
      ticket.id,
      'analyze',
      ['## 분석 결과', '', '기존 분석', '', '### 영향 범위', '- 없음', '', '### 주요 리스크', '- 없음', '', '### 추천 검증', '- pnpm typecheck', ''].join('\n')
    )
    updateStepStatus(ticket.id, 'analyze', 'done')

    await runTicketWorkflow({
      ticketId: ticket.id,
      stepId: 'plan',
    })

    const updated = getTicket(ticket.id)
    assert.equal(updated?.runState, 'needs_request_clarification')
    assert.equal(updated?.planningBlock?.kind, 'needs_request_clarification')
    assert.match(updated?.planningBlock?.summary || '', /요구사항 설명/)
  } finally {
    resetRunCodexTurnForTesting()
    deleteTicket(ticket.id)
  }
})

test('runAutomaticTicketWorkflow self-heals review failures by rewinding to plan and produces a final report', async () => {
  const fixture = createRepoFixture()
  const ticket = createTicket({
    title: 'Self-healing workflow test',
    description: 'review 실패 후 plan부터 자동 복구되어야 한다.',
    projectId: 'intentlane-codex',
    projectPath: fixture.repoPath,
    categoryId: 'feature',
    flowStepIds: ['analyze', 'plan', 'implement', 'review', 'ready'],
  })

  replaceStepOutput(ticket.id, 'analyze', '## 분석 결과\n\n기존 분석')
  replaceStepOutput(
    ticket.id,
    'plan',
    [
      '## 구현 계획',
      '',
      '초기 계획',
      '',
      '### 변경 항목',
      '- tracked.txt 수정',
      '',
      '### 작업 순서',
      '- 구현',
      '',
      '### 완료 기준',
      '- 복구 이력이 포함된 최종 보고서가 생성된다',
      '',
      '### 검증 계획',
      '- review only',
      '',
    ].join('\n')
  )
  updateStepStatus(ticket.id, 'analyze', 'done')
  updateStepStatus(ticket.id, 'plan', 'done')
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

  const prompts: string[] = []
  const reviewFailure = {
    verdict: 'fail',
    summary: 'acceptance criteria mismatch',
    goalAssessment: {
      request: {
        status: 'partial',
        evidence: ['request requirement is still missing'],
      },
      ticket: {
        status: 'aligned',
        evidence: ['ticket goal is still partially aligned'],
      },
      acceptanceCriteria: [
        {
          criterion: '복구 이력이 포함된 최종 보고서가 생성된다',
          status: 'unmet',
          evidence: ['복구 이력 섹션이 없다'],
        },
      ],
    },
    blockingFindings: ['계획이 acceptance criteria를 충분히 반영하지 않았다.'],
    residualRisks: [],
    releaseNotes: [],
  }
  const responses = [
    {},
    reviewFailure,
    {
      summary: '보완된 계획',
      changes: [{ path: 'tracked.txt', change: '복구 이력 반영', why: '최종 보고 품질 개선' }],
      order: ['1. 계획 보완', '2. 구현'],
      acceptanceCriteria: ['복구 이력이 포함된 최종 보고서가 생성된다'],
      verificationPlan: ['review only'],
    },
    {
      verdict: 'pass',
      summary: '계획이 복구 요구사항을 반영했다.',
      blockingFindings: [],
      residualRisks: [],
    },
    {},
    {
      verdict: 'pass',
      summary: '복구 후 결과물이 요구사항을 충족한다.',
      goalAssessment: {
        request: {
          status: 'aligned',
          evidence: ['request requirement satisfied'],
        },
        ticket: {
          status: 'aligned',
          evidence: ['ticket goal satisfied'],
        },
        acceptanceCriteria: [
          {
            criterion: '복구 이력이 포함된 최종 보고서가 생성된다',
            status: 'met',
            evidence: ['최종 보고서에 복구 이력이 포함되었다'],
          },
        ],
      },
      blockingFindings: [],
      residualRisks: [],
      releaseNotes: ['tracked.txt'],
    },
  ]

  setRunCodexTurnForTesting(
    (async (opts) => {
      const coordinatorResult = maybeBuildCoordinatorStubResult(opts)
      if (coordinatorResult) {
        return coordinatorResult
      }

      prompts.push(opts.prompt)
      const response = responses.shift()
      if (!response) {
        throw new Error('No stubbed Codex response left')
      }

      if (opts.promptFile === 'prompts/ticket-implement.txt') {
        writeFileSync(join(opts.cwd, 'tracked.txt'), `recovered-${prompts.length}\n`, 'utf8')
        return {
          threadId: 'thread-test',
          finalResponse: 'tracked.txt를 갱신했습니다.',
        }
      }

      return {
        threadId: 'thread-test',
        finalResponse: JSON.stringify(response),
        parsedOutput: response,
      }
    }) as typeof setRunCodexTurnForTesting extends (fn: infer T) => void ? T : never
  )

  try {
    await runAutomaticTicketWorkflow({
      ticketId: ticket.id,
      startStepId: 'implement',
    })

    const updated = getTicket(ticket.id)
    assert.equal(updated?.status, 'awaiting_merge')
    assert.equal(updated?.runSummaries.length, 2)
    assert.equal(updated?.activeRunId, updated?.runSummaries.at(-1)?.id)
    assert.match(updated?.worktree?.branchName ?? '', new RegExp(`${updated?.activeRunId?.toLowerCase()}`))
    assert.equal(updated?.steps.ready?.status, 'done')
    assert.match(updated?.finalReport?.output ?? '', /### 복구 이력/)
    assert.match(updated?.steps.ready?.output ?? '', /## 머지 준비/)
    assert.match(updated?.steps.ready?.output ?? '', /Final Report/)
    assert.doesNotMatch(updated?.steps.ready?.output ?? '', /## 최종 보고/)
    assert.ok(prompts.some((prompt) => prompt.includes('Ticket 자동 복구 지침')))
    assert.equal(listIncidents(ticket.projectId, ticket.id).length, 0)
    assert.ok(
      updated?.timeline.some((entry) => entry.title.includes('자동 복구 판단에 따라 plan 단계부터 새 run을 시작합니다.'))
    )
  } finally {
    resetRunCodexTurnForTesting()
    deleteTicket(ticket.id)
    fixture.cleanup()
  }
})

test('runAutomaticTicketWorkflow rewinds to plan when review failure shows scope drift and missing manual verification evidence', async () => {
  const fixture = createRepoFixture()
  const ticket = createTicket({
    title: 'Review scope drift recovery test',
    description: 'review 실패가 범위 이탈과 수동 검증 누락이면 plan부터 다시 시작해야 한다.',
    projectId: 'intentlane-codex',
    projectPath: fixture.repoPath,
    categoryId: 'feature',
    flowStepIds: ['analyze', 'plan', 'implement', 'review', 'ready'],
  })

  replaceStepOutput(ticket.id, 'analyze', '## 분석 결과\n\n프런트엔드 탭 레이아웃만 조정한다.')
  replaceStepOutput(
    ticket.id,
    'plan',
    [
      '## 구현 계획',
      '',
      'Sidebar 탭 레이아웃만 조정한다.',
      '',
      '### 변경 항목',
      '- `src/web/components/Sidebar.tsx` 업데이트',
      '',
      '### 작업 순서',
      '- Sidebar 레이아웃 조정',
      '- 리뷰',
      '',
      '### 완료 기준',
      '- 초소형 폭에서도 탭 높이가 일정하게 유지된다',
      '',
      '### 검증 계획',
      '- review only',
      '',
    ].join('\n')
  )
  updateStepStatus(ticket.id, 'analyze', 'done')
  updateStepStatus(ticket.id, 'plan', 'done')
  appendStageReview(ticket.id, {
    id: 'scope-drift-analyze-review-pass',
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
    id: 'scope-drift-plan-review-pass',
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

  let implementCount = 0
  const responses = [
    {},
    {
      verdict: 'fail' as const,
      summary: '비범위 변경과 수동 검증 누락으로 완료할 수 없습니다.',
      goalAssessment: {
        request: {
          status: 'aligned' as const,
          evidence: ['request 범위는 프런트엔드 탭 레이아웃 수정입니다.'],
        },
        ticket: {
          status: 'partial' as const,
          evidence: ['현재 diff에 비범위 서버 변경이 포함되고 UI 안정성 증빙이 없습니다.'],
        },
        acceptanceCriteria: [
          {
            criterion: '초소형 폭에서도 탭 높이가 일정하게 유지된다',
            status: 'partial' as const,
            evidence: ['정적 검사로만은 보장되지 않고 수동 검증 결과가 없습니다.'],
          },
        ],
      },
      blockingFindings: [
        '비범위 파일 수정이 포함되어 승인된 계획과 불일치합니다.',
        '정적 검사로만은 보장되지 않아 수동 검증이 필요합니다.',
      ],
      residualRisks: ['브라우저별 레이아웃 안정성은 검증 계획 보완이 필요합니다.'],
      releaseNotes: [],
    },
    {
      summary: '보완된 계획',
      changes: [{ path: 'tracked.txt', change: '범위 내 UI 변경만 유지', why: '비범위 변경 제거' }],
      order: ['1. 범위를 다시 고정한다', '2. UI 검증 전략을 보강한다', '3. 구현한다'],
      acceptanceCriteria: ['초소형 폭에서도 탭 높이가 일정하게 유지된다'],
      verificationPlan: ['브라우저 UI 검증 근거를 남긴다'],
    },
    {
      verdict: 'pass' as const,
      summary: '계획이 범위와 UI 검증 전략을 보완했다.',
      blockingFindings: [],
      residualRisks: [],
    },
    {},
    {
      verdict: 'pass' as const,
      summary: '범위 내 변경과 UI 검증 근거가 반영되었다.',
      goalAssessment: {
        request: {
          status: 'aligned' as const,
          evidence: ['request 범위 내 UI 수정만 남겼습니다.'],
        },
        ticket: {
          status: 'aligned' as const,
          evidence: ['비범위 변경이 제거되고 검증 근거가 추가되었습니다.'],
        },
        acceptanceCriteria: [
          {
            criterion: '초소형 폭에서도 탭 높이가 일정하게 유지된다',
            status: 'met' as const,
            evidence: ['UI 검증 근거가 추가되었습니다.'],
          },
        ],
      },
      blockingFindings: [],
      residualRisks: [],
      releaseNotes: ['tracked.txt'],
    },
  ]

  setRunCodexTurnForTesting(
    (async (opts) => {
      if (opts.promptFile === 'prompts/ticket-coordinator.txt') {
        const decision = {
          kind: 'restart_implement' as const,
          rationale: '승인된 계획을 유지하고 implement부터 다시 시작합니다.',
          remediationNotes: 'review 피드백을 반영해 다시 구현하세요.',
          confidence: 'high' as const,
        }
        return {
          threadId: 'thread-test',
          finalResponse: JSON.stringify(decision),
          parsedOutput: decision,
        }
      }

      const response = responses.shift()
      if (!response) {
        throw new Error('No stubbed Codex response left')
      }

      if (opts.promptFile === 'prompts/ticket-implement.txt') {
        implementCount += 1
        writeFileSync(join(opts.cwd, 'tracked.txt'), implementCount === 1 ? 'out-of-scope-change\n' : 'ui-only-change\n', 'utf8')
        return {
          threadId: 'thread-test',
          finalResponse:
            implementCount === 1
              ? 'Sidebar 외 서버 파일까지 건드렸습니다.'
              : '범위 내 UI 변경과 검증 근거를 반영했습니다.',
        }
      }

      return {
        threadId: 'thread-test',
        finalResponse: JSON.stringify(response),
        parsedOutput: response,
      }
    }) as typeof setRunCodexTurnForTesting extends (fn: infer T) => void ? T : never
  )

  try {
    await runAutomaticTicketWorkflow({
      ticketId: ticket.id,
      startStepId: 'implement',
    })

    const updated = getTicket(ticket.id)
    assert.equal(updated?.status, 'awaiting_merge')
    assert.equal(updated?.runSummaries.length, 2)
    assert.equal(implementCount, 2)
    assert.ok(updated?.timeline.some((entry) => entry.title.includes('plan 단계부터 새 run')))
    assert.ok(updated?.timeline.every((entry) => !entry.title.includes('같은 run에서 수선합니다.')))
    assert.equal(listIncidents(ticket.projectId, ticket.id).length, 0)
  } finally {
    resetRunCodexTurnForTesting()
    deleteTicket(ticket.id)
    fixture.cleanup()
  }
})

test('runAutomaticTicketWorkflow repairs implement in the same run when review is misaligned with the approved plan', async () => {
  const fixture = createRepoFixture()
  const ticket = createTicket({
    title: 'Misaligned review recovery test',
    description: '승인된 계획은 유지하되 implement부터 같은 run으로 복구해야 한다.',
    projectId: 'intentlane-codex',
    projectPath: fixture.repoPath,
    categoryId: 'docs',
    flowStepIds: ['analyze', 'plan', 'implement', 'review', 'ready'],
  })

  replaceStepOutput(ticket.id, 'analyze', '## 분석 결과\n\n문서 산출물을 정리한다.')
  replaceStepOutput(
    ticket.id,
    'plan',
    [
      '## 구현 계획',
      '',
      '문서 산출물을 갱신한다.',
      '',
      '### 변경 항목',
      '- `todo/ticket-flow-architecture.md` 업데이트',
      '- `todo/003-ticket-flow-todo.md` 업데이트',
      '- `README.md` 링크 정리',
      '',
      '### 작업 순서',
      '- 문서 갱신',
      '- 리뷰',
      '',
      '### 완료 기준',
      '- 문서 산출물이 최신 흐름을 반영한다',
      '',
      '### 검증 계획',
      '- review only',
      '',
    ].join('\n')
  )
  updateStepStatus(ticket.id, 'analyze', 'done')
  updateStepStatus(ticket.id, 'plan', 'done')
  appendStageReview(ticket.id, {
    id: 'misaligned-analyze-review-pass',
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
    id: 'misaligned-plan-review-pass',
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

  let implementCount = 0
  let reviewCount = 0
  setRunCodexTurnForTesting(
    (async (opts) => {
      if (opts.promptFile === 'prompts/ticket-coordinator.txt') {
        const decision = {
          kind: 'restart_implement' as const,
          rationale: '승인된 계획을 유지하고 새 run에서 implement부터 다시 시작합니다.',
          remediationNotes: '문서 산출물 중심으로 다시 구현하세요.',
          confidence: 'high' as const,
        }
        return {
          threadId: 'thread-test',
          finalResponse: JSON.stringify(decision),
          parsedOutput: decision,
        }
      }

      if (opts.promptFile === 'prompts/ticket-implement.txt') {
        implementCount += 1
        writeFileSync(
          join(opts.cwd, 'tracked.txt'),
          implementCount === 1 ? 'wrong-code-focused-change\n' : 'documented-flow\n',
          'utf8'
        )
        return {
          threadId: 'thread-test',
          finalResponse:
            implementCount === 1 ? '서버/웹 코드 중심 변경을 반영했습니다.' : '문서 산출물 중심 변경을 반영했습니다.',
        }
      }

      if (opts.promptFile === 'prompts/ticket-review.txt') {
        reviewCount += 1
        const response =
          reviewCount === 1
            ? {
                verdict: 'fail' as const,
                summary: '문서 티켓인데 현재 결과물이 코드 수정 위주라 승인된 계획과 어긋납니다.',
                goalAssessment: {
                  request: {
                    status: 'aligned' as const,
                    evidence: ['request 목적은 유지되고 있습니다.'],
                  },
                  ticket: {
                    status: 'misaligned' as const,
                    evidence: ['티켓 목표는 문서 산출물인데 구현 결과는 코드 수정 위주입니다.'],
                  },
                  acceptanceCriteria: [
                    {
                      criterion: '문서 산출물이 최신 흐름을 반영한다',
                      status: 'unmet' as const,
                      evidence: ['문서 산출물이 갱신되지 않았습니다.'],
                    },
                  ],
                },
                blockingFindings: ['승인된 계획을 유지한 채 문서 산출물 중심으로 다시 구현해야 합니다.'],
                residualRisks: ['문서 없이 기능 의도와 실제 동작 해석이 어긋날 수 있습니다.'],
                releaseNotes: [],
              }
            : {
                verdict: 'pass' as const,
                summary: '문서 산출물 중심 결과물로 승인된 계획과 다시 정렬되었습니다.',
                goalAssessment: {
                  request: {
                    status: 'aligned' as const,
                    evidence: ['request 목적이 그대로 충족됩니다.'],
                  },
                  ticket: {
                    status: 'aligned' as const,
                    evidence: ['문서 산출물이 승인된 계획과 일치합니다.'],
                  },
                  acceptanceCriteria: [
                    {
                      criterion: '문서 산출물이 최신 흐름을 반영한다',
                      status: 'met' as const,
                      evidence: ['문서 산출물이 최신 흐름을 설명합니다.'],
                    },
                  ],
                },
                blockingFindings: [],
                residualRisks: [],
                releaseNotes: ['문서 산출물 갱신'],
              }

        return {
          threadId: 'thread-test',
          finalResponse: JSON.stringify(response),
          parsedOutput: response,
        }
      }

      throw new Error(`Unexpected prompt file: ${opts.promptFile}`)
    }) as Parameters<typeof setRunCodexTurnForTesting>[0]
  )

  try {
    await runAutomaticTicketWorkflow({
      ticketId: ticket.id,
      startStepId: 'implement',
    })

    const updated = getTicket(ticket.id)

    assert.equal(updated?.status, 'awaiting_merge')
    assert.equal(updated?.runSummaries.length, 1)
    assert.equal(updated?.planningBlock, undefined)
    assert.equal(listIncidents(ticket.projectId, ticket.id).length, 0)
    assert.ok(updated?.timeline.some((entry) => entry.title.includes('코드 리뷰 실패를 같은 run에서 수선합니다.')))
    assert.equal(readFileSync(join(updated?.worktree?.worktreePath ?? '', 'tracked.txt'), 'utf8'), 'documented-flow\n')
  } finally {
    resetRunCodexTurnForTesting()
    deleteTicket(ticket.id)
    fixture.cleanup()
  }
})

test('runAutomaticTicketWorkflow stops same-run review repairs after implement maxAttempts', async () => {
  const fixture = createRepoFixture()
  const ticket = createTicket({
    title: 'Same-run repair limit test',
    description: '같은 run 구현/리뷰 자동 수선은 implement maxAttempts까지만 반복해야 한다.',
    projectId: 'intentlane-codex',
    projectPath: fixture.repoPath,
    categoryId: 'docs',
    flowStepIds: ['analyze', 'plan', 'implement', 'review', 'ready'],
  })

  replaceStepOutput(ticket.id, 'analyze', '## 분석 결과\n\n문서 산출물을 정리한다.')
  replaceStepOutput(
    ticket.id,
    'plan',
    [
      '## 구현 계획',
      '',
      '문서 산출물을 갱신한다.',
      '',
      '### 변경 항목',
      '- `tracked.txt` 업데이트',
      '',
      '### 작업 순서',
      '- 구현',
      '- 리뷰',
      '',
      '### 완료 기준',
      '- 문서 산출물이 최신 흐름을 반영한다',
      '',
      '### 검증 계획',
      '- review only',
      '',
    ].join('\n')
  )
  updateStepStatus(ticket.id, 'analyze', 'done')
  updateStepStatus(ticket.id, 'plan', 'done')
  appendStageReview(ticket.id, {
    id: 'same-run-limit-analyze-review-pass',
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
    id: 'same-run-limit-plan-review-pass',
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

  const implementStep = loadConfig().flows.ticket.steps.find((step) => step.id === 'implement')
  const maxImplementAttempts = implementStep ? getConfiguredStepMaxAttempts(implementStep) : 3
  let implementCount = 0
  let reviewCount = 0

  setRunCodexTurnForTesting(
    (async (opts) => {
      if (opts.promptFile === 'prompts/ticket-implement.txt') {
        implementCount += 1
        writeFileSync(join(opts.cwd, 'tracked.txt'), `attempt-${implementCount}\n`, 'utf8')
        return {
          threadId: 'thread-test',
          finalResponse: `문서 산출물을 ${implementCount}차 시도로 다시 정리했습니다.`,
        }
      }

      if (opts.promptFile === 'prompts/ticket-review.txt') {
        reviewCount += 1
        const response = {
          verdict: 'fail' as const,
          summary: '문서 티켓인데 결과물이 승인된 계획과 계속 어긋납니다.',
          goalAssessment: {
            request: {
              status: 'aligned' as const,
              evidence: ['request 목적은 유지되고 있습니다.'],
            },
            ticket: {
              status: 'misaligned' as const,
              evidence: ['문서 산출물이 아니라 임시 흔적만 남았습니다.'],
            },
            acceptanceCriteria: [
              {
                criterion: '문서 산출물이 최신 흐름을 반영한다',
                status: 'unmet' as const,
                evidence: ['문서 산출물 대신 attempt 흔적만 남았습니다.'],
              },
            ],
          },
          blockingFindings: ['승인된 계획을 유지한 채 문서 산출물 중심으로 다시 구현해야 합니다.'],
          residualRisks: ['같은 run에서 같은 방향의 오정렬이 반복되고 있습니다.'],
          releaseNotes: [],
        }

        return {
          threadId: 'thread-test',
          finalResponse: JSON.stringify(response),
          parsedOutput: response,
        }
      }

      throw new Error(`Unexpected prompt file: ${opts.promptFile}`)
    }) as Parameters<typeof setRunCodexTurnForTesting>[0]
  )

  try {
    await runAutomaticTicketWorkflow({
      ticketId: ticket.id,
      startStepId: 'implement',
    })

    const updated = getTicket(ticket.id)

    assert.equal(implementCount, maxImplementAttempts)
    assert.equal(reviewCount, maxImplementAttempts)
    assert.equal(updated?.status, 'needs_decision')
    assert.equal(updated?.runState, 'needs_decision')
    assert.equal(updated?.planningBlock?.source, 'review')
    assert.equal(updated?.planningBlock?.kind, 'needs_decision')
    assert.match(updated?.planningBlock?.summary ?? '', /같은 run에서 구현\/리뷰 자동 수선을 더 진행할 수 없어/)
    assert.ok(updated?.planningBlock?.options?.some((option) => option.startStepId === 'implement'))
    assert.ok(updated?.planningBlock?.options?.some((option) => option.startStepId === 'plan'))
    assert.ok(updated?.timeline.some((entry) => entry.title.includes('같은 run의 구현 자동 수선이 반복 한도에 도달해 추가 재시도를 중단합니다.')))
    assert.equal(listIncidents(ticket.projectId, ticket.id).length, 0)
  } finally {
    resetRunCodexTurnForTesting()
    deleteTicket(ticket.id)
    fixture.cleanup()
  }
})

test('runAutomaticTicketWorkflow creates a mergeable commit before ready', async () => {
  const fixture = createRepoFixture()
  const ticket = createTicket({
    title: 'Mergeable ready state test',
    description: 'ready 단계에 들어가기 전에 merge 가능한 커밋이 생성되어야 한다.',
    projectId: 'intentlane-codex',
    projectPath: fixture.repoPath,
    categoryId: 'docs',
    flowStepIds: ['analyze', 'plan', 'implement', 'review', 'ready'],
  })

  replaceStepOutput(ticket.id, 'analyze', '## 분석 결과\n\ntracked.txt를 수정한다.')
  replaceStepOutput(
    ticket.id,
    'plan',
    [
      '## 구현 계획',
      '',
      'tracked.txt를 갱신한다.',
      '',
      '### 변경 항목',
      '- tracked.txt 수정',
      '',
      '### 작업 순서',
      '- 구현',
      '- 리뷰',
      '',
      '### 완료 기준',
      '- ready 단계에서 merge 가능한 작업 커밋이 생성된다',
      '',
      '### 검증 계획',
      '- review only',
      '',
    ].join('\n')
  )
  updateStepStatus(ticket.id, 'analyze', 'done')
  updateStepStatus(ticket.id, 'plan', 'done')
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

  setRunCodexTurnForTesting(
    (async (opts) => {
      if (opts.promptFile === 'prompts/ticket-implement.txt') {
        writeFileSync(join(opts.cwd, 'tracked.txt'), 'implemented\n', 'utf8')
        return {
          threadId: 'thread-test',
          finalResponse: 'tracked.txt를 수정했습니다.',
        }
      }

      const review = {
        verdict: 'pass' as const,
        summary: '변경이 승인된 범위 내에 있고 merge 가능한 커밋이 준비되었습니다.',
        goalAssessment: {
          request: {
            status: 'not_available' as const,
            evidence: [],
          },
          ticket: {
            status: 'aligned' as const,
            evidence: ['tracked.txt 수정만 포함되어 있습니다.'],
          },
          acceptanceCriteria: [
            {
              criterion: 'ready 단계에서 merge 가능한 작업 커밋이 생성된다',
              status: 'met' as const,
              evidence: ['ready 출력에 base와 다른 작업 커밋이 기록됩니다.'],
            },
          ],
        },
        blockingFindings: [],
        residualRisks: [],
        releaseNotes: ['tracked.txt 수정'],
      }

      return {
        threadId: 'thread-test',
        finalResponse: JSON.stringify(review),
        parsedOutput: review,
      }
    }) as Parameters<typeof setRunCodexTurnForTesting>[0]
  )

  try {
    await runAutomaticTicketWorkflow({
      ticketId: ticket.id,
      startStepId: 'implement',
    })

    const updated = getTicket(ticket.id)
    const worktreePath = updated?.worktree?.worktreePath

    assert.equal(updated?.status, 'awaiting_merge')
    assert.ok(updated?.worktree)
    assert.match(updated?.worktree?.branchName ?? '', new RegExp(`${updated?.activeRunId?.toLowerCase()}`))
    assert.notEqual(updated?.worktree?.headCommit, updated?.worktree?.baseCommit)
    assert.ok(worktreePath)
    assert.equal(git(worktreePath!, 'status', '--short'), '')
    assert.match(updated?.steps.ready?.output ?? '', /Committed diff:/)
  } finally {
    resetRunCodexTurnForTesting()
    deleteTicket(ticket.id)
    fixture.cleanup()
  }
})

test('runAutomaticTicketWorkflow blocks on ambiguous review failures and asks for a recovery choice', async () => {
  const fixture = createRepoFixture()
  const ticket = createTicket({
    title: 'Review choice test',
    description: 'review 실패 시 사람 선택이 필요할 수 있다.',
    projectId: 'intentlane-codex',
    projectPath: fixture.repoPath,
    categoryId: 'feature',
    flowStepIds: ['analyze', 'plan', 'implement', 'review', 'ready'],
  })

  replaceStepOutput(ticket.id, 'analyze', '## 분석 결과\n\n기존 분석')
  replaceStepOutput(ticket.id, 'plan', '## 구현 계획\n\n기존 계획')
  updateStepStatus(ticket.id, 'analyze', 'done')
  updateStepStatus(ticket.id, 'plan', 'done')
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

  setRunCodexTurnForTesting(
    makeStubbedTurnRunner(
      [
        {},
        {
          verdict: 'fail',
          summary: '정책 결정이 먼저 필요합니다.',
          goalAssessment: {
            request: { status: 'aligned', evidence: ['request is still valid'] },
            ticket: { status: 'aligned', evidence: ['ticket is still valid'] },
            acceptanceCriteria: [],
          },
          blockingFindings: ['구현 수정으로 해결할 수도 있고 계획을 다시 잡을 수도 있어 정책 결정이 필요합니다.'],
          residualRisks: ['둘 중 어느 경로를 택할지 판단이 필요합니다.'],
          releaseNotes: [],
        },
      ],
      []
    ) as typeof setRunCodexTurnForTesting extends (fn: infer T) => void ? T : never
  )

  try {
    await runAutomaticTicketWorkflow({
      ticketId: ticket.id,
      startStepId: 'implement',
    })

    const updated = getTicket(ticket.id)
    assert.equal(updated?.runState, 'needs_decision')
    assert.equal(updated?.currentPhase, 'review')
    assert.equal(updated?.planningBlock?.source, 'review')
    assert.equal(updated?.planningBlock?.options?.length, 2)
    assert.deepEqual(
      updated?.planningBlock?.options?.map((option) => ({
        startStepId: option.startStepId,
        executionMode: option.executionMode,
      })),
      [
        { startStepId: 'implement', executionMode: 'same_run' },
        { startStepId: 'plan', executionMode: 'new_run' },
      ]
    )
    assert.equal(updated?.runSummaries.length, 1)
  } finally {
    resetRunCodexTurnForTesting()
    deleteTicket(ticket.id)
    fixture.cleanup()
  }
})

test('runAutomaticTicketWorkflow exposes verify recovery choices as verify-origin planning blocks', async () => {
  const fixture = createRepoFixture()
  const ticket = createTicket({
    title: 'Verify recovery choice test',
    description: '자동 검증 실패가 verify origin planning block으로 노출되어야 한다.',
    projectId: 'intentlane-codex',
    projectPath: fixture.repoPath,
    categoryId: 'feature',
    flowStepIds: ['analyze', 'plan', 'implement', 'verify', 'review', 'ready'],
  })

  mkdirSync(join(fixture.repoPath, 'node_modules'), { recursive: true })
  writeFileSync(
    join(fixture.repoPath, 'package.json'),
    JSON.stringify(
      {
        name: 'verify-recovery-fixture',
        private: true,
        scripts: {
          typecheck: "node -e \"console.error('Typecheck broke intentionally'); process.exit(1)\"",
          test: "node -e \"process.exit(0)\"",
          build: "node -e \"process.exit(0)\"",
        },
      },
      null,
      2
    ),
    'utf8'
  )

  replaceStepOutput(ticket.id, 'analyze', '## 분석 결과\n\n기존 분석')
  replaceStepOutput(ticket.id, 'plan', '## 구현 계획\n\n기존 계획')
  updateStepStatus(ticket.id, 'analyze', 'done')
  updateStepStatus(ticket.id, 'plan', 'done')
  appendStageReview(ticket.id, {
    id: 'verify-choice-analyze-review-pass',
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
    id: 'verify-choice-plan-review-pass',
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

  setRunCodexTurnForTesting(
    (async (opts) => {
      if (opts.promptFile !== 'prompts/ticket-coordinator.txt') {
        throw new Error(`Unexpected prompt file: ${opts.promptFile}`)
      }

      const decision = {
        kind: 'needs_decision' as const,
        rationale: '자동 검증 실패를 구현 재시작으로 볼지 계획 재정렬로 볼지 선택이 필요합니다.',
        remediationNotes: '자동 검증 실패 원인을 확인하고 경로를 선택하세요.',
        confidence: 'high' as const,
      }
      return {
        threadId: 'thread-test',
        finalResponse: JSON.stringify(decision),
        parsedOutput: decision,
      }
    }) as Parameters<typeof setRunCodexTurnForTesting>[0]
  )

  try {
    await runAutomaticTicketWorkflow({
      ticketId: ticket.id,
      startStepId: 'verify',
    })

    const updated = getTicket(ticket.id)

    assert.equal(updated?.runState, 'needs_decision')
    assert.equal(updated?.status, 'needs_decision')
    assert.equal(updated?.currentPhase, 'verify')
    assert.equal(updated?.planningBlock?.source, 'verify')
    assert.equal(updated?.planningBlock?.options?.length, 2)
    assert.deepEqual(
      updated?.planningBlock?.options?.map((option) => ({
        startStepId: option.startStepId,
        executionMode: option.executionMode,
      })),
      [
        { startStepId: 'implement', executionMode: 'new_run' },
        { startStepId: 'plan', executionMode: 'new_run' },
      ]
    )
    assert.match(updated?.verificationRuns[0]?.commands[0]?.output ?? '', /Typecheck broke intentionally/)
    assert.equal(updated?.reviewRuns.length, 0)
  } finally {
    resetRunCodexTurnForTesting()
    deleteTicket(ticket.id)
    fixture.cleanup()
  }
})

test('runAutomaticTicketWorkflow stops repeated verify fingerprints and asks for a decision', async () => {
  const fixture = createRepoFixture()
  const ticket = createTicket({
    title: 'Repeated verify fingerprint test',
    description: '같은 verify 실패가 반복되면 자동 수선을 중단해야 한다.',
    projectId: 'intentlane-codex',
    projectPath: fixture.repoPath,
    categoryId: 'feature',
    flowStepIds: ['analyze', 'plan', 'implement', 'verify', 'review', 'ready'],
  })

  writeFileSync(
    join(fixture.repoPath, 'package.json'),
    JSON.stringify(
      {
        name: 'repeated-verify-fingerprint-fixture',
        private: true,
        scripts: {
          typecheck: "node -e \"console.error('Typecheck broke intentionally'); process.exit(1)\"",
          test: "node -e \"process.exit(0)\"",
          build: "node -e \"process.exit(0)\"",
        },
      },
      null,
      2
    ),
    'utf8'
  )
  mkdirSync(join(fixture.repoPath, 'node_modules'), { recursive: true })

  replaceStepOutput(ticket.id, 'analyze', '## 분석 결과\n\n기존 분석')
  replaceStepOutput(ticket.id, 'plan', '## 구현 계획\n\n기존 계획')
  updateStepStatus(ticket.id, 'analyze', 'done')
  updateStepStatus(ticket.id, 'plan', 'done')
  appendStageReview(ticket.id, {
    id: 'repeat-verify-analyze-pass',
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
    id: 'repeat-verify-plan-pass',
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

  try {
    setRunCodexTurnForTesting(
      (async (opts) => {
        if (opts.promptFile !== 'prompts/ticket-coordinator.txt') {
          throw new Error(`Unexpected prompt file: ${opts.promptFile}`)
        }

        const decision = {
          kind: 'needs_decision' as const,
          rationale: '첫 verify 실패에서는 사람이 recovery 경로를 선택할 수 있다.',
          remediationNotes: '첫 verify 실패 원인을 확인하고 경로를 선택하세요.',
          confidence: 'high' as const,
        }
        return {
          threadId: 'thread-test',
          finalResponse: JSON.stringify(decision),
          parsedOutput: decision,
        }
      }) as Parameters<typeof setRunCodexTurnForTesting>[0]
    )

    await runAutomaticTicketWorkflow({
      ticketId: ticket.id,
      startStepId: 'verify',
    })

    const firstRun = getTicket(ticket.id)
    const fingerprint = firstRun?.verificationRuns[0]?.diagnosis?.fingerprint

    assert.equal(firstRun?.runState, 'needs_decision')
    assert.ok(fingerprint)

    setRunCodexTurnForTesting(
      (async () => {
        throw new Error('Coordinator should not run when the verify fingerprint already repeated')
      }) as Parameters<typeof setRunCodexTurnForTesting>[0]
    )

    await runAutomaticTicketWorkflow({
      ticketId: ticket.id,
      startStepId: 'verify',
    })

    const updated = getTicket(ticket.id)

    assert.equal(updated?.runState, 'needs_decision')
    assert.equal(updated?.planningBlock?.source, 'verify')
    assert.equal(updated?.planningBlock?.kind, 'needs_decision')
    assert.deepEqual(
      updated?.planningBlock?.options?.map((option) => ({
        startStepId: option.startStepId,
        executionMode: option.executionMode,
      })),
      [
        { startStepId: 'implement', executionMode: 'new_run' },
        { startStepId: 'plan', executionMode: 'new_run' },
      ]
    )
    assert.equal(updated?.verificationRuns.length, 2)
    assert.equal(updated?.verificationRuns.at(-1)?.diagnosis?.fingerprint, fingerprint)
    assert.match(updated?.planningBlock?.findings?.join('\n') ?? '', new RegExp(fingerprint))
    assert.equal(updated?.reviewRuns.length, 0)
  } finally {
    resetRunCodexTurnForTesting()
    deleteTicket(ticket.id)
    fixture.cleanup()
  }
})

test('runAutomaticTicketWorkflow can require request clarification after a review failure', async () => {
  const fixture = createRepoFixture()
  const ticket = createTicket({
    title: 'Review clarification test',
    description: 'review 실패 후 요구사항 보완이 필요할 수 있다.',
    projectId: 'intentlane-codex',
    projectPath: fixture.repoPath,
    categoryId: 'feature',
    flowStepIds: ['analyze', 'plan', 'implement', 'review', 'ready'],
  })

  replaceStepOutput(ticket.id, 'analyze', '## 분석 결과\n\n기존 분석')
  replaceStepOutput(ticket.id, 'plan', '## 구현 계획\n\n기존 계획')
  updateStepStatus(ticket.id, 'analyze', 'done')
  updateStepStatus(ticket.id, 'plan', 'done')
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

  setRunCodexTurnForTesting(
    makeStubbedTurnRunner(
      [
        {},
        {
          verdict: 'fail',
          summary: '요구사항 설명이 더 필요합니다.',
          goalAssessment: {
            request: { status: 'aligned', evidence: ['request is still partially grounded'] },
            ticket: { status: 'aligned', evidence: ['ticket is still partially grounded'] },
            acceptanceCriteria: [],
          },
          blockingFindings: ['대표 사용자 시나리오가 부족해 어떤 동작을 기대해야 하는지 clarification이 필요합니다.'],
          residualRisks: ['non-goal이 비어 있어 범위가 넓어질 수 있습니다.'],
          releaseNotes: [],
        },
      ],
      []
    ) as typeof setRunCodexTurnForTesting extends (fn: infer T) => void ? T : never
  )

  try {
    await runAutomaticTicketWorkflow({
      ticketId: ticket.id,
      startStepId: 'implement',
    })

    const updated = getTicket(ticket.id)
    assert.equal(updated?.runState, 'needs_request_clarification')
    assert.equal(updated?.currentPhase, 'review')
    assert.equal(updated?.planningBlock?.source, 'review')
    assert.equal(updated?.planningBlock?.options?.[0]?.startStepId, 'plan')
  } finally {
    resetRunCodexTurnForTesting()
    deleteTicket(ticket.id)
    fixture.cleanup()
  }
})
