import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'
import {
  applyTicketRetryPlan,
  appendReviewRun,
  appendStageReview,
  appendStepOutput,
  appendTimelineEvent,
  appendVerificationRun,
  clearTicketRepairLoop,
  clearTicketWorktree,
  createTicket,
  createDefaultGoalAssessment,
  enqueueTicketExecution,
  getTicket,
  replaceStepOutput,
  setFinalReport,
  setTicketBlockerLink,
  setTicketMergeBlock,
  setTicketMergeContext,
  setTicketAttemptCount,
  setTicketCurrentPhase,
  setTicketCoordinatorThreadId,
  setTicketImplementationThreadId,
  setTicketPlanningBlock,
  setTicketPlanningThreadId,
  setTicketScopedVerification,
  setTicketRunState,
  setTicketStatus,
  setTicketWorktree,
  setTicketRepairLoop,
  prepareTicketForMergeValidation,
  updateStepStatus,
  updateTicketRepairLoop,
  updateTicketWorktree,
  type FinalReport,
  type GoalAssessment,
  type ReviewRun,
  type StageReview,
  type Ticket,
  type TicketMergeBlock,
  type TicketMergeContext,
  type TicketMergeIssueKind,
  type TicketMergeOption,
  type TicketMergeResolutionAction,
  type TicketPlanningBlock,
  type TicketRepairLoop,
  type TicketWorktree,
  type AcceptanceCriterionAssessment,
  type ScopedVerificationPlan,
  type VerificationCommandResult,
  type VerificationDiagnosis,
  type VerificationFailureTestCase,
  type VerificationRun,
} from './tickets.js'
import { loadConfig, type ProjectConfig, type ReasoningEffort, type StepConfig } from '../lib/config.js'
import { resolveReasoningEffortForModel } from '../lib/model-capabilities.js'
import {
  listProjectAncestorsWithinRepository,
  resolveProjectExecutionCwd,
  resolveProjectRepositoryRoot,
  resolveProjectWorktreeRoot,
} from '../lib/project-paths.js'
import { runCodexTurn, runRecoverableCodexTurn, type CodexTurnEvent } from './codex-sdk.js'
import { formatRequestTemplateForPrompt, getClientRequest } from './client-requests.js'
import { captureTicketIncidentWithAutoResolution } from './incident-resolution.js'
import { type IncidentTrigger } from './incidents.js'
import { coordinateTicketFailure, type CoordinatorDecision } from './ticket-coordinator.js'

const DEFAULT_STEP_MAX_ATTEMPTS = 1
const TICKET_REASONING_EFFORT = 'xhigh'
const MAX_TICKET_WORKFLOW_RUNS = 3
const MERGE_DECISION_PROMPT_FILE = 'prompts/ticket-merge-decision.txt'
const VERIFY_SKILL_PROMPT_FILE = 'prompts/ticket-verify.txt'
const PROJECT_SKILLS_DIR = resolve(process.cwd(), '.codex/skills')
const TICKET_ANALYZE_SKILL = 'ticket-analyze'
const TICKET_PLAN_SKILL = 'ticket-plan'
const TICKET_IMPLEMENT_SKILL = 'ticket-implement'
const TICKET_VERIFY_SKILL = 'ticket-verify'
const TICKET_REVIEW_SKILL = 'ticket-review'
const TICKET_STAGE_REVIEW_SKILL = 'ticket-stage-review'
const TICKET_MERGE_DECISION_SKILL = 'ticket-merge-decision'
const TEXT_CONFLICT_FILE_EXTENSIONS = new Set(['.adoc', '.json', '.md', '.rst', '.txt', '.yaml', '.yml'])
let runCodexTurnImpl: typeof runCodexTurn = runCodexTurn
let ticketSelfHealingEnabled = true

export function setRunCodexTurnForTesting(fn: typeof runCodexTurn) {
  runCodexTurnImpl = fn
}

export function resetRunCodexTurnForTesting() {
  runCodexTurnImpl = runCodexTurn
}

export function setTicketSelfHealingEnabledForTesting(enabled: boolean) {
  ticketSelfHealingEnabled = enabled
}

export function resetTicketSelfHealingEnabledForTesting() {
  ticketSelfHealingEnabled = true
}

function getTicketModel(stepConfig: StepConfig) {
  return stepConfig.model ?? loadConfig().flows.explain.model
}

function getTicketReasoningEffort(stepConfig: StepConfig, fallbackReasoningEffort: ReasoningEffort = TICKET_REASONING_EFFORT) {
  return resolveReasoningEffortForModel(getTicketModel(stepConfig), stepConfig.reasoningEffort ?? fallbackReasoningEffort)
}

function getPlanningThreadId(ticket: Ticket) {
  return ticket.planningThreadId || undefined
}

function getImplementationThreadId(ticket: Ticket) {
  return ticket.implementationThreadId || undefined
}

function getCoordinatorThreadId(ticket: Ticket) {
  return ticket.coordinatorThreadId || undefined
}

function appendTicketSessionRecoveryEvent(ticketId: string, label: string, reason?: string) {
  appendTimelineEvent(ticketId, {
    type: 'system',
    title: `${label} 세션을 복구하지 못해 새 세션에서 이어갑니다.`,
    body: reason
      ? `이전 Codex 세션 재개에 실패했습니다. ${reason}`
      : '이전 Codex 세션을 복구하지 못해 저장된 티켓 문맥을 바탕으로 새 세션에서 이어갑니다.',
  })
}

async function runRestartableTicketTurn<T>(params: {
  ticket: Ticket
  stepConfig: StepConfig
  prompt: string
  promptFile: string
  cwd: string
  additionalDirectories?: string[]
  threadId?: string
  stepLabel: string
  signal?: AbortSignal
  outputSchema?: Record<string, unknown>
  onEvent?: (event: CodexTurnEvent) => Promise<void> | void
  onThreadId?: (threadId: string) => void
}) {
  const result = await runRecoverableCodexTurn<T>({
    prompt: params.prompt,
    recoveryStrategy: 'restart',
    onRecoveryState: (_label, _detail, reason) => {
      appendTicketSessionRecoveryEvent(params.ticket.id, params.stepLabel, reason)
    },
    promptFile: params.promptFile,
    cwd: params.cwd,
    additionalDirectories: params.additionalDirectories,
    threadId: params.threadId,
    model: getTicketModel(params.stepConfig),
    reasoningEffort: getTicketReasoningEffort(params.stepConfig),
    serviceTier: loadConfig().flows.explain.serviceTier,
    sandboxMode: params.stepConfig.sandboxMode ?? 'read-only',
    approvalPolicy: params.stepConfig.approvalPolicy ?? 'never',
    networkAccessEnabled: params.stepConfig.networkAccessEnabled ?? false,
    signal: params.signal,
    outputSchema: params.outputSchema,
    runTurn: runCodexTurnImpl,
    onEvent: async (event) => {
      if (event.type === 'init' && typeof event.data.threadId === 'string') {
        params.onThreadId?.(event.data.threadId)
      }
      await params.onEvent?.(event)
    },
  })

  if (result.threadId) {
    params.onThreadId?.(result.threadId)
  }

  return result
}

interface AnalyzeOutput {
  summary: string
  affectedAreas: Array<{
    path: string
    reason: string
  }>
  risks: string[]
  proposedChecks: string[]
}

interface PlanOutput {
  summary: string
  changes: Array<{
    path: string
    change: string
    why: string
  }>
  order: string[]
  acceptanceCriteria: string[]
  verificationPlan: string[]
  scopedVerification?: ScopedVerificationPlan
}

interface ReviewOutput {
  verdict: 'pass' | 'fail'
  summary: string
  goalAssessment: GoalAssessment
  blockingFindings: string[]
  residualRisks: string[]
  releaseNotes: string[]
}

interface VerifySkillOutput {
  summary: string
  recommendedRecovery: VerificationDiagnosis['recommendedRecovery']
}

interface StageReviewOutput {
  verdict: 'pass' | 'fail'
  summary: string
  blockingFindings: string[]
  residualRisks: string[]
}

interface MergeDecisionOutput {
  summary: string
  findings: string[]
  recommendedAction: TicketMergeResolutionAction
  options: Array<{
    action: TicketMergeResolutionAction
    rationale: string
  }>
}

interface VerificationFailureClassification {
  kind: 'verify_failed' | 'verification_environment_failed'
  rationale: string
  signals: string[]
}

interface VerificationPreflightFailure {
  output: string
}

const VERIFICATION_ENVIRONMENT_PATTERNS: Array<{ pattern: RegExp; signal: string }> = [
  {
    pattern: /Local package\.json exists, but node_modules missing, did you mean to install\?/i,
    signal: '프로젝트 의존성이 설치되지 않았습니다.',
  },
  {
    pattern: /ERR_PNPM_NO_IMPORTER_MANIFEST_FOUND/i,
    signal: '워크트리에서 프로젝트 manifest를 찾지 못했습니다.',
  },
  {
    pattern: /(?:sh:\s*\d+:\s*)?(?:vite|tsx|tsc): not found/i,
    signal: '검증 명령이 필요한 로컬 도구를 찾지 못했습니다.',
  },
  {
    pattern: /Cannot find (?:module|package) ['"`](react|react-dom\/client|react-markdown|remark-gfm|mermaid|vite|tsx|typescript)['"`]/i,
    signal: '필수 패키지 해석에 실패했습니다.',
  },
  {
    pattern: /TS2307: Cannot find module ['"`](react|react-dom\/client|react-markdown|remark-gfm|mermaid)['"`]/i,
    signal: '타입체크가 프런트엔드 의존성을 해석하지 못했습니다.',
  },
  {
    pattern: /react\/jsx-runtime/i,
    signal: 'JSX 런타임 패키지를 찾지 못했습니다.',
  },
  {
    pattern: /(?:\/bin\/sh:\s*\d+:\s*)?\.\/gradlew:\s*not found/i,
    signal: 'Gradle wrapper를 찾지 못했습니다.',
  },
  {
    pattern: /gradlew(?::|\s).*Permission denied/i,
    signal: 'Gradle wrapper 실행 권한 또는 경로가 잘못되었습니다.',
  },
  {
    pattern: /does not contain a Gradle build/i,
    signal: '검증 명령을 Gradle 프로젝트 루트가 아닌 위치에서 실행했습니다.',
  },
]

export interface TicketWorkflowEvent {
  type: 'step' | 'delta' | 'done'
  data:
    | {
        runId?: string
        stepId: string
        status: 'running' | 'done' | 'failed'
        attempt?: number
      }
    | {
        runId?: string
        stepId: string
        text: string
        attempt?: number
      }
    | {
        runId?: string
        stepId: string
        status: 'done' | 'completed' | 'failed'
        attempts: number
      }
}

interface RunTicketWorkflowOptions {
  ticketId: string
  stepId: string
  signal?: AbortSignal
  onEvent?: (event: TicketWorkflowEvent) => Promise<void> | void
}

interface RunAutomaticTicketWorkflowOptions {
  ticketId: string
  startStepId?: 'analyze' | 'plan' | 'implement' | 'verify' | 'review'
  recoveryNotes?: string
  signal?: AbortSignal
  onEvent?: (event: TicketWorkflowEvent) => Promise<void> | void
}

const analyzeSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'affectedAreas', 'risks', 'proposedChecks'],
  properties: {
    summary: { type: 'string' },
    affectedAreas: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'reason'],
        properties: {
          path: { type: 'string' },
          reason: { type: 'string' },
        },
      },
    },
    risks: {
      type: 'array',
      items: { type: 'string' },
    },
    proposedChecks: {
      type: 'array',
      items: { type: 'string' },
    },
  },
} as const

const planSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'changes', 'order', 'acceptanceCriteria', 'verificationPlan', 'scopedVerification'],
  properties: {
    summary: { type: 'string' },
    changes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'change', 'why'],
        properties: {
          path: { type: 'string' },
          change: { type: 'string' },
          why: { type: 'string' },
        },
      },
    },
    order: {
      type: 'array',
      items: { type: 'string' },
    },
    acceptanceCriteria: {
      type: 'array',
      items: { type: 'string' },
    },
    verificationPlan: {
      type: 'array',
      items: { type: 'string' },
    },
    scopedVerification: {
      type: ['object', 'null'],
      additionalProperties: false,
      required: ['rationale', 'commands'],
      properties: {
        rationale: { type: 'string' },
        commands: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['label', 'command', 'timeoutMs'],
            properties: {
              label: { type: 'string' },
              command: { type: 'string' },
              timeoutMs: { type: ['integer', 'null'], minimum: 1 },
            },
          },
        },
      },
    },
  },
} as const

const reviewSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'summary', 'goalAssessment', 'blockingFindings', 'residualRisks', 'releaseNotes'],
  properties: {
    verdict: {
      type: 'string',
      enum: ['pass', 'fail'],
    },
    summary: { type: 'string' },
    goalAssessment: {
      type: 'object',
      additionalProperties: false,
      required: ['request', 'ticket', 'acceptanceCriteria'],
      properties: {
        request: {
          type: 'object',
          additionalProperties: false,
          required: ['status', 'evidence'],
          properties: {
            status: {
              type: 'string',
              enum: ['aligned', 'partial', 'misaligned', 'not_available'],
            },
            evidence: {
              type: 'array',
              items: { type: 'string' },
            },
          },
        },
        ticket: {
          type: 'object',
          additionalProperties: false,
          required: ['status', 'evidence'],
          properties: {
            status: {
              type: 'string',
              enum: ['aligned', 'partial', 'misaligned', 'not_available'],
            },
            evidence: {
              type: 'array',
              items: { type: 'string' },
            },
          },
        },
        acceptanceCriteria: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['criterion', 'status', 'evidence'],
            properties: {
              criterion: { type: 'string' },
              status: {
                type: 'string',
                enum: ['met', 'partial', 'unmet'],
              },
              evidence: {
                type: 'array',
                items: { type: 'string' },
              },
            },
          },
        },
      },
    },
    blockingFindings: {
      type: 'array',
      items: { type: 'string' },
    },
    residualRisks: {
      type: 'array',
      items: { type: 'string' },
    },
    releaseNotes: {
      type: 'array',
      items: { type: 'string' },
    },
  },
} as const

const verifySkillSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'recommendedRecovery'],
  properties: {
    summary: { type: 'string' },
    recommendedRecovery: {
      type: 'string',
      enum: ['new_run_implement', 'new_run_plan', 'needs_decision'],
    },
  },
} as const

const stageReviewSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'summary', 'blockingFindings', 'residualRisks'],
  properties: {
    verdict: {
      type: 'string',
      enum: ['pass', 'fail'],
    },
    summary: { type: 'string' },
    blockingFindings: {
      type: 'array',
      items: { type: 'string' },
    },
    residualRisks: {
      type: 'array',
      items: { type: 'string' },
    },
  },
} as const

const mergeDecisionSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'findings', 'recommendedAction', 'options'],
  properties: {
    summary: { type: 'string' },
    findings: {
      type: 'array',
      items: { type: 'string' },
    },
    recommendedAction: {
      type: 'string',
      enum: [
        'rebase_and_revalidate',
        'revalidate_current_worktree',
        'reapply_on_latest_base',
        'preserve_target_changes_and_reconcile',
        'restart_from_plan',
        'discard_worktree',
      ],
    },
    options: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['action', 'rationale'],
        properties: {
          action: {
            type: 'string',
            enum: [
              'rebase_and_revalidate',
              'revalidate_current_worktree',
              'reapply_on_latest_base',
              'preserve_target_changes_and_reconcile',
              'restart_from_plan',
              'discard_worktree',
            ],
          },
          rationale: { type: 'string' },
        },
      },
    },
  },
} as const

function getTicketOrThrow(ticketId: string): Ticket {
  const ticket = getTicket(ticketId)
  if (!ticket) {
    throw new Error('Ticket not found')
  }

  return ticket
}

function getProjectConfig(ticket: Ticket): ProjectConfig {
  const config = loadConfig()
  const project = config.projects.find((entry) => entry.id === ticket.projectId)
  if (!project) {
    throw new Error(`Unknown project "${ticket.projectId}"`)
  }

  return project
}

function includesStep(ticket: Ticket, stepId: string) {
  return ticket.flowStepIds.includes(stepId)
}

function getExecutionCwd(ticket: Ticket) {
  return resolveProjectExecutionCwd(ticket.projectPath, ticket.worktree?.worktreePath)
}

function getStepConfig(stepId: string): StepConfig {
  const config = loadConfig()
  const step = config.flows.ticket.steps.find((entry) => entry.id === stepId)
  if (!step) {
    throw new Error(`Unknown step "${stepId}"`)
  }

  return step
}

function captureIncidentSafely(ticketId: string, trigger: IncidentTrigger) {
  try {
    captureTicketIncidentWithAutoResolution(ticketId, trigger)
  } catch (error) {
    console.error(`Failed to capture incident for ${ticketId}:`, error)
  }
}

export function getConfiguredStepMaxAttempts(stepConfig: StepConfig) {
  return stepConfig.maxAttempts ?? DEFAULT_STEP_MAX_ATTEMPTS
}

function formatVerificationCommandCatalog(project: ProjectConfig) {
  if (project.verificationCommands.length === 0) {
    return '- 없음'
  }

  return project.verificationCommands
    .map(
      (command) =>
        `- ${command.label}: \`${command.command}\`${command.required === false ? ' (optional)' : ' (required)'}`
    )
    .join('\n')
}

function getProjectSkillPath(skillName: string) {
  return resolve(PROJECT_SKILLS_DIR, skillName)
}

function buildSkillInvocation(skillName: string) {
  return `Use $${skillName} at ${getProjectSkillPath(skillName)} for this ticket step.`
}

function getProjectSkillDirectories() {
  if (!existsSync(PROJECT_SKILLS_DIR)) {
    return undefined
  }

  return [PROJECT_SKILLS_DIR]
}

function getTicketSkillDirectories(stepId: string) {
  if (
    stepId === 'analyze' ||
    stepId === 'plan' ||
    stepId === 'implement' ||
    stepId === 'verify' ||
    stepId === 'review' ||
    stepId === 'stage_review'
  ) {
    return getProjectSkillDirectories()
  }

  return undefined
}

function formatEvidenceInline(evidence: string[]) {
  return evidence.length > 0 ? evidence.join(' | ') : '근거 없음'
}

function normalizeGoalCriterionKey(value: string) {
  return value.trim().replace(/\s+/g, ' ').toLowerCase()
}

export function extractAcceptanceCriteriaFromPlanOutput(planOutput: string) {
  const match = planOutput.match(/### 완료 기준\n([\s\S]*?)(?:\n### |\n## |$)/)
  if (!match) {
    return []
  }

  return match[1]
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2).trim())
    .filter((line) => line && line !== '없음')
}

function normalizeGoalAssessment(goalAssessment: GoalAssessment | undefined, hasLinkedRequest: boolean) {
  const fallback = createDefaultGoalAssessment()
  const request = goalAssessment?.request
    ? {
        status: hasLinkedRequest ? goalAssessment.request.status : 'not_available',
        evidence: hasLinkedRequest ? goalAssessment.request.evidence ?? [] : [],
      }
    : fallback.request
  const ticket = goalAssessment?.ticket
    ? {
        status: goalAssessment.ticket.status,
        evidence: goalAssessment.ticket.evidence ?? [],
      }
    : fallback.ticket

  return {
    request,
    ticket,
    acceptanceCriteria:
      goalAssessment?.acceptanceCriteria?.map((criterion) => ({
        criterion: criterion.criterion,
        status: criterion.status,
        evidence: criterion.evidence ?? [],
      })) ?? [],
  } satisfies GoalAssessment
}

function buildGoalAssessmentBlockingFindings(goalAssessment: GoalAssessment, hasLinkedRequest: boolean) {
  const findings: string[] = []

  if (goalAssessment.ticket.status !== 'aligned') {
    findings.push(`티켓 요구사항 충족 판정이 ${goalAssessment.ticket.status}입니다.`)
  }

  if (hasLinkedRequest && goalAssessment.request.status !== 'aligned') {
    findings.push(`연결된 request 충족 판정이 ${goalAssessment.request.status}입니다.`)
  }

  for (const criterion of goalAssessment.acceptanceCriteria) {
    if (criterion.status !== 'met') {
      findings.push(`완료 기준 미충족: ${criterion.criterion} (${criterion.status})`)
    }
  }

  return [...new Set(findings)]
}

export function normalizeReviewOutput(
  output: ReviewOutput,
  opts: { expectedAcceptanceCriteria: string[]; hasLinkedRequest: boolean }
): ReviewOutput {
  const normalizedGoalAssessment = normalizeGoalAssessment(output.goalAssessment, opts.hasLinkedRequest)
  const assessmentByCriterion = new Map(
    normalizedGoalAssessment.acceptanceCriteria.map((criterion) => [normalizeGoalCriterionKey(criterion.criterion), criterion])
  )
  const consumedKeys = new Set<string>()

  const normalizedAcceptanceCriteria: AcceptanceCriterionAssessment[] = opts.expectedAcceptanceCriteria.map((criterion) => {
    const key = normalizeGoalCriterionKey(criterion)
    const matched = assessmentByCriterion.get(key)
    consumedKeys.add(key)

    return (
      matched ?? {
        criterion,
        status: 'unmet' as const,
        evidence: ['리뷰 결과에서 이 완료 기준의 충족 여부가 확인되지 않았습니다.'],
      }
    )
  })

  const extraAcceptanceCriteria = normalizedGoalAssessment.acceptanceCriteria.filter(
    (criterion) => !consumedKeys.has(normalizeGoalCriterionKey(criterion.criterion))
  )
  const goalAssessment: GoalAssessment = {
    ...normalizedGoalAssessment,
    acceptanceCriteria: [...normalizedAcceptanceCriteria, ...extraAcceptanceCriteria],
  }

  const blockingFindings = [
    ...new Set([...output.blockingFindings, ...buildGoalAssessmentBlockingFindings(goalAssessment, opts.hasLinkedRequest)]),
  ]

  return {
    ...output,
    goalAssessment,
    blockingFindings,
    verdict: output.verdict === 'fail' || blockingFindings.length > 0 ? 'fail' : 'pass',
  }
}

function formatGoalAssessment(goalAssessment: GoalAssessment) {
  const lines = [
    '### 목표 충족도',
    `- Linked request: ${goalAssessment.request.status} / ${formatEvidenceInline(goalAssessment.request.evidence)}`,
    `- Ticket: ${goalAssessment.ticket.status} / ${formatEvidenceInline(goalAssessment.ticket.evidence)}`,
  ]

  if (goalAssessment.acceptanceCriteria.length === 0) {
    lines.push('- 완료 기준: 없음')
    lines.push('')
    return lines.join('\n')
  }

  lines.push(
    ...goalAssessment.acceptanceCriteria.map(
      (criterion) =>
        `- 완료 기준 [${criterion.status}] ${criterion.criterion} / ${formatEvidenceInline(criterion.evidence)}`
    )
  )
  lines.push('')

  return lines.join('\n')
}

function buildTicketContext(ticket: Ticket) {
  const linkedRequest = ticket.linkedRequestId ? getClientRequest(ticket.linkedRequestId) : undefined

  return [
    `티켓 제목: ${ticket.title}`,
    '',
    `티켓 설명:\n${ticket.description}`,
    '',
    linkedRequest
      ? `연결된 request:\n- 제목: ${linkedRequest.title}\n${formatRequestTemplateForPrompt(linkedRequest.template)}`
      : '연결된 request: 없음',
    '',
  ].join('\n')
}

function buildAnalyzePrompt(ticket: Ticket, project: ProjectConfig, remediationNotes?: string) {
  const lines = [
    buildSkillInvocation(TICKET_ANALYZE_SKILL),
    '',
    buildTicketContext(ticket),
    '예정된 자동 검증 명령:',
    formatVerificationCommandCatalog(project),
    '',
    '위 요구사항을 구현 가능한 수준으로 분석해줘.',
    '자동 검증에서 실제로 실행될 명령만 기준으로 추천 검증과 리스크를 정리해줘.',
  ]

  if (remediationNotes) {
    lines.push('', '이전 분석 리뷰 피드백:', remediationNotes, '', '이 피드백을 반영해서 분석을 다시 작성해줘.')
  }

  return lines.join('\n')
}

function buildPlanPrompt(ticket: Ticket, project: ProjectConfig, remediationNotes?: string) {
  const lines = [
    buildSkillInvocation(TICKET_PLAN_SKILL),
    '',
    buildTicketContext(ticket),
    `분석 결과:\n${ticket.steps.analyze?.output || '분석 결과 없음'}`,
    '',
    '예정된 자동 검증 명령:',
    formatVerificationCommandCatalog(project),
    '',
    '분석 결과를 바탕으로 구현 계획을 세워줘.',
    '검증 계획은 실제 자동 검증 명령과 모순되지 않게 작성해줘.',
    '가능하면 이번 ticket 범위를 빠르게 확인할 수 있는 범위 검증 명령(scoped verification)도 함께 제안해줘.',
  ]

  if (remediationNotes) {
    lines.push('', '이전 계획 리뷰 피드백:', remediationNotes, '', '이 피드백을 반영해서 계획을 다시 작성해줘.')
  }

  return lines.join('\n')
}

function inferScopedVerificationPrefixes(project: ProjectConfig) {
  const prefixes = new Set<string>()

  for (const command of project.verificationCommands) {
    const trimmed = command.command.trim()
    if (!trimmed) {
      continue
    }

    if (/^sh\s+\.\/gradlew\b/.test(trimmed)) {
      prefixes.add('sh ./gradlew')
      continue
    }

    if (/^\.\/gradlew\b/.test(trimmed)) {
      prefixes.add('./gradlew')
      continue
    }

    if (/^gradle\b/.test(trimmed)) {
      prefixes.add('gradle')
      continue
    }

    if (/^pnpm\b/.test(trimmed)) {
      prefixes.add('pnpm')
      continue
    }

    if (/^npm\b/.test(trimmed)) {
      prefixes.add('npm')
      continue
    }

    if (/^yarn\b/.test(trimmed)) {
      prefixes.add('yarn')
    }
  }

  return [...prefixes]
}

function hasUnsafeShellSyntax(command: string) {
  return /(?:&&|\|\||;|\||>|<|`|\$\()/.test(command)
}

function normalizeScopedVerificationPlan(plan: ScopedVerificationPlan | undefined, project: ProjectConfig) {
  if (!plan?.commands?.length) {
    return undefined
  }

  const allowedPrefixes = inferScopedVerificationPrefixes(project)
  if (allowedPrefixes.length === 0) {
    return undefined
  }

  const commands = plan.commands.flatMap((entry) => {
    const label = entry.label.trim()
    const command = entry.command.trim()
    if (!label || !command || hasUnsafeShellSyntax(command)) {
      return []
    }

    if (!allowedPrefixes.some((prefix) => command === prefix || command.startsWith(`${prefix} `))) {
      return []
    }

    return [
      {
        label,
        command,
        timeoutMs: typeof entry.timeoutMs === 'number' ? entry.timeoutMs : undefined,
      },
    ]
  })

  if (commands.length === 0) {
    return undefined
  }

  return {
    rationale: plan.rationale.trim(),
    commands,
  } satisfies ScopedVerificationPlan
}

function getScopedVerificationPlan(ticket: Ticket, project: ProjectConfig) {
  return normalizeScopedVerificationPlan(ticket.scopedVerification, project)
}

function buildStageReviewFeedback(label: string, review: StageReview) {
  if (review.blockingFindings.length === 0 && review.residualRisks.length === 0) {
    return `${label} 리뷰 ${review.attempt}에서 보완이 필요하다는 판정이 있었지만 세부 피드백이 비어 있습니다.`
  }

  return [
    `${label} 리뷰 ${review.attempt}에서 보완이 필요한 내용:`,
    '',
    '블로킹 이슈:',
    ...review.blockingFindings.map((finding) => `- ${finding}`),
    '',
    '잔여 리스크:',
    ...review.residualRisks.map((risk) => `- ${risk}`),
  ].join('\n')
}

function classifyPlanReviewBlock(review: StageReview): TicketPlanningBlock {
  const findings = [...review.blockingFindings, ...review.residualRisks]
  const combined = findings.join(' ')
  const needsDecision =
    /정책|결정|입력|예외|공개|보안|404|400|500|중복|검증 명령|pnpm|gradle|workflow|파이프라인/i.test(combined)

  return {
    kind: needsDecision ? 'needs_decision' : 'needs_request_clarification',
    source: 'plan_review',
    summary: review.summary,
    findings,
  }
}

function buildRecoveryRetryOptions(ticket: Ticket, source: TicketPlanningBlock['source']): TicketPlanningBlock['options'] {
  const canRetryInSameRun = source === 'review' && canRetryReviewInSameRun(ticket)
  return [
    {
      id: `${source}-${canRetryInSameRun ? 'retry' : 'restart'}-implement`,
      label: canRetryInSameRun ? '같은 run으로 구현 다시' : '새 run으로 구현 다시',
      startStepId: 'implement' as const,
      executionMode: canRetryInSameRun ? ('same_run' as const) : ('new_run' as const),
      sessionMode: canRetryInSameRun ? ('reuse_thread' as const) : ('new_thread' as const),
    },
    {
      id: `${source}-restart-plan`,
      label: '새 run으로 계획 다시',
      startStepId: 'plan' as const,
      executionMode: 'new_run' as const,
      sessionMode: 'new_thread' as const,
    },
  ]
}

function buildSelfHealUnavailablePlanningBlock(
  ticket: Ticket,
  source: 'verify' | 'review',
  summary: string,
  findings: string[]
): TicketPlanningBlock {
  return {
    kind: 'needs_decision',
    source,
    summary,
    findings,
    options: buildRecoveryRetryOptions(ticket, source),
  }
}

function buildCoordinatorPlanningBlock(
  ticket: Ticket,
  source: TicketPlanningBlock['source'],
  decision: CoordinatorDecision,
  summary: string,
  findings: string[]
): TicketPlanningBlock {
  if (decision.kind === 'needs_request_clarification') {
    return {
      kind: 'needs_request_clarification',
      source,
      summary,
      findings,
      options:
        source === 'plan_review'
          ? undefined
          : [
              {
                id: `${source}-restart-plan`,
                label: '요구사항 보완 후 계획부터 다시 시작',
                startStepId: 'plan',
                executionMode: 'new_run',
                sessionMode: 'new_thread',
              },
            ],
    }
  }

  return {
    kind: 'needs_decision',
    source,
    summary,
    findings,
    options: source === 'plan_review' ? undefined : buildRecoveryRetryOptions(ticket, source),
  }
}

function latestStageReviewFailure(ticket: Ticket, subjectStepId: 'analyze' | 'plan') {
  return [...ticket.stageReviews]
    .reverse()
    .find((review) => review.subjectStepId === subjectStepId && review.verdict === 'fail')
}

export function buildReviewPrompt(ticket: Ticket, verificationRun: VerificationRun | undefined, gitSummary: string) {
  const linkedRequest = ticket.linkedRequestId ? getClientRequest(ticket.linkedRequestId) : undefined
  const acceptanceCriteria = extractAcceptanceCriteriaFromPlanOutput(ticket.steps.plan?.output || '')
  const verificationSummary = verificationRun ? formatVerificationRun(verificationRun) : '검증 단계가 없는 카테고리입니다.'

  return [
    buildSkillInvocation(TICKET_REVIEW_SKILL),
    '',
    `Ticket: ${ticket.title}`,
    '',
    `Ticket description:\n${ticket.description}`,
    '',
    linkedRequest
      ? `Linked request:\nTitle: ${linkedRequest.title}\n${formatRequestTemplateForPrompt(linkedRequest.template)}`
      : 'Linked request:\n없음',
    '',
    `Approved plan:\n${ticket.steps.plan?.output || '계획 출력 없음'}`,
    '',
    'Acceptance criteria:',
    acceptanceCriteria.length > 0 ? acceptanceCriteria.map((criterion) => `- ${criterion}`).join('\n') : '- 없음',
    '',
    `Verification summary:\n${verificationSummary}`,
    '',
    `Repository changes:\n${gitSummary}`,
    '',
    '티켓 설명, 연결된 request, 승인된 계획의 완료 기준을 각각 기준으로 충족 여부를 판정해줘.',
    '완료 기준은 항목별 met/partial/unmet로 평가하고, request가 없으면 request 상태는 not_available로 반환해줘.',
    'partial, unmet, misaligned가 있으면 블로킹 이슈로 본다.',
  ].join('\n')
}

function describeMergeResolutionAction(action: TicketMergeResolutionAction) {
  if (action === 'rebase_and_revalidate') {
    return '현재 worktree 커밋을 보존한 채 현재 기준 브랜치 HEAD 위로 rebase한 뒤 verify/review를 다시 실행한다.'
  }

  if (action === 'revalidate_current_worktree') {
    return '현재 worktree를 그대로 두고 verify/review만 다시 실행한다.'
  }

  if (action === 'reapply_on_latest_base') {
    return '현재 reviewed 결과의 의도를 최신 기준 브랜치에서 새 run으로 다시 적용한 뒤 verify/review/ready까지 자동 진행한다.'
  }

  if (action === 'preserve_target_changes_and_reconcile') {
    return 'merge 대상 브랜치의 로컬 변경을 safety branch에 보존한 뒤, review를 통과한 ticket 결과와 새 run에서 다시 통합한다.'
  }

  if (action === 'restart_from_plan') {
    return '현재 worktree를 정리하고 현재 기준 브랜치에서 새 run으로 plan부터 다시 시작한다.'
  }

  return '현재 worktree를 폐기하고 머지를 포기한다.'
}

function buildMergeDecisionPrompt(
  ticket: Ticket,
  mergeIssueMessage: string,
  evidence: string,
  allowedActions: TicketMergeResolutionAction[]
) {
  return [
    buildSkillInvocation(TICKET_MERGE_DECISION_SKILL),
    '',
    `Ticket: ${ticket.title}`,
    '',
    `Ticket description:\n${ticket.description}`,
    '',
    `Final report:\n${ticket.finalReport?.output || '최종 보고 없음'}`,
    '',
    `Ready output:\n${ticket.steps.ready?.output || 'ready 출력 없음'}`,
    '',
    `Current merge issue:\n${mergeIssueMessage}`,
    '',
    `Merge evidence:\n${evidence}`,
    '',
    'Available automated actions:',
    ...allowedActions.map((action) => `- ${action}: ${describeMergeResolutionAction(action)}`),
    '',
    '위 자동화 액션 중 실제로 합리적인 선택지만 options에 포함해줘.',
    'recommendedAction은 반드시 options 안에 있는 action이어야 한다.',
    '가급적 이미 검토된 작업물을 보존하는 경로를 우선 추천하되, 충돌/드리프트 위험이 크면 restart_from_plan 또는 discard_worktree를 선택할 수 있다.',
  ].join('\n')
}

function formatMergeResolutionLabel(action: TicketMergeResolutionAction) {
  if (action === 'rebase_and_revalidate') {
    return '현재 기준 브랜치로 rebase 후 재검증'
  }

  if (action === 'revalidate_current_worktree') {
    return '현재 worktree 상태로 재검증'
  }

  if (action === 'reapply_on_latest_base') {
    return '최신 기준 브랜치에서 변경 재적용'
  }

  if (action === 'preserve_target_changes_and_reconcile') {
    return '대상 로컬 변경 보존 후 reconcile'
  }

  if (action === 'restart_from_plan') {
    return '새 run으로 계획부터 다시 시작'
  }

  return '현재 worktree 폐기'
}

async function emit(
  onEvent: RunTicketWorkflowOptions['onEvent'],
  event: TicketWorkflowEvent
) {
  await onEvent?.(event)
}

function getWorkflowRunId(ticket: Ticket) {
  return ticket.activeRunId ?? undefined
}

async function emitStep(
  onEvent: RunTicketWorkflowOptions['onEvent'],
  ticket: Ticket,
  stepId: string,
  status: 'running' | 'done' | 'failed',
  attempt?: number
) {
  await emit(onEvent, {
    type: 'step',
    data: { runId: getWorkflowRunId(ticket), stepId, status, attempt },
  })
}

async function emitDelta(
  onEvent: RunTicketWorkflowOptions['onEvent'],
  ticket: Ticket,
  stepId: string,
  text: string,
  attempt?: number
) {
  await emit(onEvent, {
    type: 'delta',
    data: { runId: getWorkflowRunId(ticket), stepId, text, attempt },
  })
}

async function emitDone(
  onEvent: RunTicketWorkflowOptions['onEvent'],
  ticket: Ticket,
  stepId: string,
  status: 'done' | 'completed' | 'failed',
  attempts: number
) {
  await emit(onEvent, {
    type: 'done',
    data: { runId: getWorkflowRunId(ticket), stepId, status, attempts },
  })
}

function ensureAbortSignal(signal?: AbortSignal) {
  if (signal?.aborted) {
    const error = new Error('Operation aborted')
    error.name = 'AbortError'
    throw error
  }
}

function formatList(items: string[]): string {
  if (items.length === 0) {
    return '- 없음'
  }

  return items.map((item) => `- ${item}`).join('\n')
}

function formatAnalyzeOutput(output: AnalyzeOutput): string {
  const affectedAreas =
    output.affectedAreas.length === 0
      ? '- 없음'
      : output.affectedAreas.map((item) => `- \`${item.path}\`: ${item.reason}`).join('\n')

  return [
    '## 분석 결과',
    '',
    output.summary,
    '',
    '### 영향 범위',
    affectedAreas,
    '',
    '### 주요 리스크',
    formatList(output.risks),
    '',
    '### 추천 검증',
    formatList(output.proposedChecks),
    '',
  ].join('\n')
}

function formatPlanOutput(output: PlanOutput): string {
  const changes =
    output.changes.length === 0
      ? '- 없음'
      : output.changes
          .map((item) => `- \`${item.path}\`: ${item.change} (${item.why})`)
          .join('\n')

  return [
    '## 구현 계획',
    '',
    output.summary,
    '',
    '### 변경 항목',
    changes,
    '',
    '### 작업 순서',
    formatList(output.order),
    '',
    '### 완료 기준',
    formatList(output.acceptanceCriteria),
    '',
    ...(output.scopedVerification?.commands?.length
      ? [
          '### 범위 검증',
          output.scopedVerification.rationale,
          '',
          ...output.scopedVerification.commands.map((command) => `- ${command.label}: \`${command.command}\``),
          '',
        ]
      : []),
    '### 검증 계획',
    formatList(output.verificationPlan),
    '',
  ].join('\n')
}

function formatVerificationCommandStatus(status: VerificationCommandResult['status']) {
  if (status === 'passed') return 'PASS'
  if (status === 'skipped') return 'SKIPPED'
  return 'FAIL'
}

function formatVerificationRun(run: VerificationRun): string {
  const diagnosis = run.diagnosis
  const commands = run.commands
    .map((command) => {
      const lines = [
        `### ${command.label} [${formatVerificationCommandStatus(command.status)}]`,
        '',
        `- 단계: ${command.stage === 'scoped' ? '범위 검증' : '프로젝트 검증'}`,
        `- 명령어: \`${command.command}\``,
      ]

      if (command.exitCode != null) {
        lines.push(`- 종료 코드: ${command.exitCode}`)
      }

      lines.push(`- 소요 시간: ${command.durationMs ?? 0}ms`)

      if (command.status !== 'passed') {
        const excerpt = command.output.trim().split('\n').slice(-20).join('\n')
        lines.push('', '```text', excerpt || '(no output)', '```')
      }

      return lines.join('\n')
    })
    .join('\n\n')

  return [
    `## 검증 시도 ${run.attempt}`,
    '',
    `결과: **${run.status === 'passed' ? 'PASS' : 'FAIL'}**`,
    '',
    ...(diagnosis ? ['### 실패 진단', formatVerificationDiagnosisDetails(diagnosis, { includeRecovery: false }), ''] : []),
    commands,
    '',
  ].join('\n')
}

function isGradleWrapperCommand(command: string) {
  return /(?:^|\s)(?:sh\s+)?\.\/gradlew(?:\s|$)/.test(command.trim())
}

function looksLikeGradleBuildDirectory(cwd: string) {
  return [
    'build.gradle',
    'build.gradle.kts',
    'settings.gradle',
    'settings.gradle.kts',
  ].some((filename) => existsSync(resolve(cwd, filename)))
}

function extractRelativeExecutable(command: string) {
  const tokens = command.trim().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) {
    return null
  }

  if (tokens[0] === 'sh' && tokens[1]?.startsWith('./')) {
    return tokens[1]
  }

  return tokens[0]?.startsWith('./') ? tokens[0] : null
}

function preflightVerificationCommand(command: string, cwd: string): VerificationPreflightFailure | null {
  const relativeExecutable = extractRelativeExecutable(command)
  const isGradle = isGradleWrapperCommand(command) || relativeExecutable === './gradlew'

  if (!relativeExecutable) {
    if (isGradle && !looksLikeGradleBuildDirectory(cwd)) {
      return {
        output: `Directory '${cwd}' does not contain a Gradle build.`,
      }
    }
    return null
  }

  const executablePath = resolve(cwd, relativeExecutable)
  if (!existsSync(executablePath)) {
    const lines = [`${relativeExecutable}: not found`]
    if (isGradle) {
      lines.push(`Directory '${cwd}' does not contain a Gradle build.`)
    }
    return { output: lines.join('\n') }
  }

  if (isGradle && !looksLikeGradleBuildDirectory(cwd)) {
    return {
      output: `Directory '${cwd}' does not contain a Gradle build.`,
    }
  }

  const tokens = command.trim().split(/\s+/).filter(Boolean)
  if (tokens[0]?.startsWith('./')) {
    try {
      const executableStat = statSync(executablePath)
      if ((executableStat.mode & 0o111) === 0) {
        return {
          output: `${relativeExecutable}: Permission denied`,
        }
      }
    } catch {
      return {
        output: `${relativeExecutable}: Permission denied`,
      }
    }
  }

  return null
}

function decodeXmlEntities(value: string) {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function normalizeDiagnosticText(value: string) {
  return decodeXmlEntities(value).replace(/\s+/g, ' ').trim()
}

function extractFailurePath(value: string) {
  const directPath =
    value.match(/"path":"([^"]+)"/)?.[1] ??
    value.match(/Request URI = ([^\n]+)/)?.[1] ??
    value.match(/\bpath[=:]\s*([^\s]+)/i)?.[1]

  return directPath?.trim()
}

function collectVerificationReportFiles(rootDir: string) {
  const files: string[] = []
  const queue: Array<{ path: string; depth: number }> = [{ path: rootDir, depth: 0 }]
  const skipDirectories = new Set(['.git', 'node_modules', '.pnpm', '.yarn', '.next', '.turbo'])

  while (queue.length > 0) {
    const current = queue.shift()
    if (!current) {
      break
    }

    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>
    try {
      entries = readdirSync(current.path, { withFileTypes: true, encoding: 'utf8' })
    } catch {
      continue
    }

    for (const entry of entries) {
      const entryPath = resolve(current.path, entry.name)
      if (entry.isDirectory()) {
        if (current.depth >= 6 || skipDirectories.has(entry.name)) {
          continue
        }
        queue.push({ path: entryPath, depth: current.depth + 1 })
        continue
      }

      if (
        entry.isFile() &&
        entry.name.startsWith('TEST-') &&
        entry.name.endsWith('.xml') &&
        entryPath.includes(`${sep}build${sep}test-results${sep}test${sep}`)
      ) {
        files.push(entryPath)
      }
    }
  }

  return files
}

function collectJUnitFailures(cwd: string, maxFailures = 24): VerificationFailureTestCase[] {
  const reportFiles = collectVerificationReportFiles(cwd)
  const failures: VerificationFailureTestCase[] = []

  for (const reportFile of reportFiles) {
    if (failures.length >= maxFailures) {
      break
    }

    let xml = ''
    try {
      xml = readFileSync(reportFile, 'utf-8')
    } catch {
      continue
    }

    const suiteName = decodeXmlEntities(xml.match(/<testsuite[^>]*name="([^"]+)"/)?.[1] ?? reportFile)
    const testcasePattern = /<testcase\b([^>]*)>([\s\S]*?)<\/testcase>/g
    let testcaseMatch: RegExpExecArray | null

    while ((testcaseMatch = testcasePattern.exec(xml)) && failures.length < maxFailures) {
      const attributes = testcaseMatch[1] ?? ''
      const body = testcaseMatch[2] ?? ''
      const failureMatch =
        body.match(/<failure\b[^>]*message="([^"]*)"[^>]*>([\s\S]*?)<\/failure>/) ??
        body.match(/<error\b[^>]*message="([^"]*)"[^>]*>([\s\S]*?)<\/error>/)

      if (!failureMatch) {
        continue
      }

      const testcaseName = decodeXmlEntities(attributes.match(/\bname="([^"]+)"/)?.[1] ?? '(unknown test)')
      const testcaseSuite = decodeXmlEntities(attributes.match(/\bclassname="([^"]+)"/)?.[1] ?? suiteName)
      const detail = normalizeDiagnosticText(`${failureMatch[1] ?? ''} ${failureMatch[2] ?? ''}`) || '(no message)'

      failures.push({
        suite: testcaseSuite,
        name: testcaseName,
        message: detail,
        path: extractFailurePath(`${failureMatch[1] ?? ''}\n${failureMatch[2] ?? ''}`),
      })
    }
  }

  return failures
}

function collectSuspectedAreas(texts: string[]) {
  const matches = new Set<string>()
  const pattern = /(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.(?:java|kt|ts|tsx|js|jsx|json|md|ya?ml|gradle|kts)/g

  for (const text of texts) {
    const found = text.match(pattern) ?? []
    for (const match of found) {
      matches.add(match)
      if (matches.size >= 8) {
        return [...matches]
      }
    }
  }

  return [...matches]
}

function collectCommonFailureSignals(failingTests: VerificationFailureTestCase[], combinedOutput: string) {
  const statusCounts = new Map<string, number>()
  const codeCounts = new Map<string, number>()
  const statusPattern = /Status expected:<\d+> but was:<(\d+)>|Status = (\d+)/g
  const codePattern = /"code"\s*:\s*"([A-Z0-9_]+)"/g

  for (const test of failingTests) {
    let statusMatch: RegExpExecArray | null
    while ((statusMatch = statusPattern.exec(test.message))) {
      const status = statusMatch[1] ?? statusMatch[2]
      if (status) {
        statusCounts.set(status, (statusCounts.get(status) ?? 0) + 1)
      }
    }

    let codeMatch: RegExpExecArray | null
    while ((codeMatch = codePattern.exec(test.message))) {
      const code = codeMatch[1]
      if (code) {
        codeCounts.set(code, (codeCounts.get(code) ?? 0) + 1)
      }
    }
  }

  for (const match of combinedOutput.match(/Status: (\d+)/g) ?? []) {
    const status = /Status: (\d+)/.exec(match)?.[1]
    if (status) {
      statusCounts.set(status, (statusCounts.get(status) ?? 0) + 1)
    }
  }

  return {
    topStatus: [...statusCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0],
    topCode: [...codeCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0],
  }
}

function summarizeVerificationDiagnosis(diagnosis: VerificationDiagnosis) {
  if (diagnosis.failingTests.length === 0) {
    return diagnosis.summary
  }

  const leadingTests = diagnosis.failingTests
    .slice(0, 3)
    .map((test) => `${test.suite} :: ${test.name}`)
    .join(', ')

  return `${diagnosis.summary} (${leadingTests}${diagnosis.failingTests.length > 3 ? ', ...' : ''})`
}

function formatVerificationDiagnosisKind(kind: VerificationDiagnosis['kind']) {
  if (kind === 'environment') {
    return 'environment'
  }

  if (kind === 'test_regression') {
    return 'test_regression'
  }

  if (kind === 'external_blocker') {
    return 'external_blocker'
  }

  if (kind === 'plan_misalignment') {
    return 'plan_misalignment'
  }

  return 'unknown'
}

function formatVerificationRecoveryKind(kind: VerificationDiagnosis['recommendedRecovery']) {
  if (kind === 'new_run_plan') {
    return 'new_run_plan'
  }

  if (kind === 'needs_decision') {
    return 'needs_decision'
  }

  return 'new_run_implement'
}

function formatVerificationDiagnosisDetails(
  diagnosis: VerificationDiagnosis,
  opts: { includeFingerprint?: boolean; includeRecovery?: boolean; maxTests?: number } = {}
) {
  const maxTests = opts.maxTests ?? 5
  const lines = [
    `분류: ${formatVerificationDiagnosisKind(diagnosis.kind)}`,
    `요약: ${summarizeVerificationDiagnosis(diagnosis)}`,
  ]

  if (opts.includeFingerprint ?? true) {
    lines.push(`fingerprint: ${diagnosis.fingerprint}`)
  }

  if (diagnosis.failingTests.length > 0) {
    lines.push('실패 테스트:')
    for (const test of diagnosis.failingTests.slice(0, maxTests)) {
      const details = [`${test.suite} :: ${test.name}`]
      if (test.path) {
        details.push(`path=${test.path}`)
      }
      details.push(`message=${normalizeDiagnosticText(test.message).slice(0, 220)}`)
      lines.push(`- ${details.join(' / ')}`)
    }

    if (diagnosis.failingTests.length > maxTests) {
      lines.push(`- 외 ${diagnosis.failingTests.length - maxTests}건`)
    }
  }

  if (diagnosis.suspectedAreas.length > 0) {
    lines.push('의심 영역:')
    lines.push(...diagnosis.suspectedAreas.map((area) => `- ${area}`))
  }

  if (diagnosis.failingCommands.length > 0) {
    lines.push('실패 명령 로그:')
    lines.push(
      ...diagnosis.failingCommands.map((command) =>
        `- ${command.id}: ${command.logPath ?? command.command}${command.exitCode != null ? ` (exit=${command.exitCode})` : ''}`
      )
    )
  }

  if (opts.includeRecovery) {
    lines.push(`권장 복구: ${formatVerificationRecoveryKind(diagnosis.recommendedRecovery)}`)
  }

  return lines.join('\n')
}

function buildVerificationRecoveryFindings(run: VerificationRun) {
  if (run.diagnosis) {
    const findings = [
      `fingerprint: ${run.diagnosis.fingerprint}`,
      `진단 요약: ${summarizeVerificationDiagnosis(run.diagnosis)}`,
    ]

    findings.push(
      ...run.diagnosis.failingTests
        .slice(0, 5)
        .map((test) =>
          `${test.suite} :: ${test.name}${test.path ? ` (${test.path})` : ''} / ${normalizeDiagnosticText(test.message).slice(0, 180)}`
        )
    )

    findings.push(...run.diagnosis.suspectedAreas.map((area) => `의심 영역: ${area}`))

    return findings
  }

  return run.commands
    .filter((command) => command.status === 'failed')
    .map((command) => `${command.label}: ${command.output.trim().split('\n').slice(-5).join(' ')}`)
}

function countVerificationFingerprintOccurrences(ticket: Ticket, fingerprint: string) {
  return ticket.verificationRuns.filter(
    (run) => run.status === 'failed' && run.diagnosis?.fingerprint === fingerprint
  ).length
}

function latestFailedVerificationRun(ticket: Ticket) {
  return [...ticket.verificationRuns].reverse().find((run) => run.status === 'failed')
}

function buildLatestVerificationContext(ticket: Ticket) {
  const latestFailedRun = latestFailedVerificationRun(ticket)
  if (!latestFailedRun?.diagnosis) {
    return undefined
  }

  return ['최신 verify 진단:', formatVerificationDiagnosisDetails(latestFailedRun.diagnosis, { includeRecovery: true })].join(
    '\n'
  )
}

function isExternalVerificationBlockerRun(run: VerificationRun) {
  const scopedCommands = run.commands.filter((command) => command.stage === 'scoped')
  const projectFailed = run.commands.some((command) => command.stage === 'project' && command.status === 'failed')
  return scopedCommands.length > 0 && scopedCommands.every((command) => command.status === 'passed') && projectFailed
}

function diagnoseVerificationRun(run: VerificationRun, cwd: string): VerificationDiagnosis | undefined {
  if (run.status !== 'failed') {
    return undefined
  }

  const classification = classifyVerificationFailure(run)
  const failedCommands = run.commands.filter((command) => command.status === 'failed')
  const combinedOutput = failedCommands.map((command) => command.output).join('\n')
  const failingTests = collectJUnitFailures(cwd)
  const suspectedAreas = collectSuspectedAreas([
    combinedOutput,
    ...failingTests.map((test) => `${test.suite}\n${test.message}`),
  ])

  let kind: VerificationDiagnosis['kind'] = 'unknown'
  let recommendedRecovery: VerificationDiagnosis['recommendedRecovery'] = 'new_run_implement'
  let summary = '검증 실패 원인을 추가 확인해야 합니다.'
  const commonSignals = collectCommonFailureSignals(failingTests, combinedOutput)

  if (classification.kind === 'verification_environment_failed') {
    kind = 'environment'
    recommendedRecovery = 'needs_decision'
    summary = classification.signals.length > 0 ? classification.signals.join(' ') : classification.rationale
  } else if (isExternalVerificationBlockerRun(run)) {
    kind = 'external_blocker'
    recommendedRecovery = 'needs_decision'
    summary = `범위 검증은 통과했지만 프로젝트 전체 검증에서 ${
      failingTests.length > 0 ? `${failingTests.length}개` : '추가'
    } 회귀가 발견되었습니다.${commonSignals.topStatus ? ` 공통 상태=${commonSignals.topStatus}` : ''}${
      commonSignals.topCode ? `, 코드=${commonSignals.topCode}` : ''
    }`
  } else if (failingTests.length > 0) {
    kind = 'test_regression'
    summary = `${failingTests.length}개 테스트가 실패했습니다.${commonSignals.topStatus ? ` 공통 상태=${commonSignals.topStatus}` : ''}${
      commonSignals.topCode ? `, 코드=${commonSignals.topCode}` : ''
    }`
  } else if (/acceptance|criterion|criteria|scope|요구사항|완료 기준|계획/i.test(combinedOutput)) {
    kind = 'plan_misalignment'
    recommendedRecovery = 'new_run_plan'
    summary = '검증 실패가 구현 세부보다 계획 또는 완료 기준 정렬 문제에 가깝습니다.'
  } else if (failedCommands.length > 0) {
    summary = `${failedCommands.length}개 검증 명령이 실패했습니다.`
  }

  const fingerprint = createHash('sha1')
    .update(
      JSON.stringify({
        kind,
        commands: failedCommands.map((command) => ({
          id: command.id,
          exitCode: command.exitCode ?? null,
          output: normalizeDiagnosticText(command.output).slice(0, 500),
        })),
        tests: failingTests.map((test) => ({
          suite: test.suite,
          name: test.name,
          message: normalizeDiagnosticText(test.message).slice(0, 300),
        })),
      })
    )
    .digest('hex')
    .slice(0, 12)

  return {
    kind,
    fingerprint,
    summary,
    failingTests,
    failingCommands: failedCommands.map((command) => ({
      id: command.id,
      command: command.command,
      exitCode: command.exitCode,
      logPath: `diagnostics/verify/${run.attempt}-${command.id}.log`,
    })),
    suspectedAreas,
    recommendedRecovery,
  }
}

function normalizeVerifySkillRecovery(
  value: string | undefined
): VerificationDiagnosis['recommendedRecovery'] | undefined {
  if (value === 'new_run_implement' || value === 'new_run_plan' || value === 'needs_decision') {
    return value
  }

  return undefined
}

async function maybeDiagnoseVerificationWithSkill(
  ticket: Ticket,
  project: ProjectConfig,
  verificationRun: VerificationRun,
  diagnosis: VerificationDiagnosis,
  signal?: AbortSignal
) {
  try {
    const verifyStep = getStepConfig('verify')
    const result = await runCodexTurnImpl<VerifySkillOutput>({
      prompt: buildVerifyPrompt(ticket, project, verificationRun),
      promptFile: verifyStep.promptFile ?? VERIFY_SKILL_PROMPT_FILE,
      cwd: getExecutionCwd(ticket),
      additionalDirectories: getTicketSkillDirectories('verify'),
      model: getTicketModel(verifyStep),
      reasoningEffort: getTicketReasoningEffort(verifyStep, 'medium'),
      serviceTier: loadConfig().flows.explain.serviceTier,
      sandboxMode: verifyStep.sandboxMode ?? 'read-only',
      approvalPolicy: verifyStep.approvalPolicy ?? 'never',
      networkAccessEnabled: verifyStep.networkAccessEnabled ?? false,
      signal,
      outputSchema: verifySkillSchema,
    })

    const parsed = result.parsedOutput as VerifySkillOutput | undefined
    const summary = parsed?.summary?.trim()
    const recommendedRecovery = normalizeVerifySkillRecovery(parsed?.recommendedRecovery)

    return {
      ...diagnosis,
      summary: summary || diagnosis.summary,
      recommendedRecovery:
        diagnosis.kind === 'environment'
          ? 'needs_decision'
          : diagnosis.kind === 'external_blocker'
            ? 'needs_decision'
            : diagnosis.kind === 'plan_misalignment'
              ? 'new_run_plan'
              : recommendedRecovery ?? diagnosis.recommendedRecovery,
    } satisfies VerificationDiagnosis
  } catch (error) {
    console.warn(`Ticket verify skill failed for ${ticket.id}:`, error)
    return diagnosis
  }
}

function formatReviewOutput(output: ReviewOutput, attempt: number): string {
  return [
    `## 코드 리뷰 ${attempt}`,
    '',
    `판정: **${output.verdict === 'pass' ? 'PASS' : 'FAIL'}**`,
    '',
    output.summary,
    '',
    formatGoalAssessment(output.goalAssessment),
    '### 블로킹 이슈',
    formatList(output.blockingFindings),
    '',
    '### 잔여 리스크',
    formatList(output.residualRisks),
    '',
    '### 릴리스 노트',
    formatList(output.releaseNotes),
    '',
  ].join('\n')
}

function formatStageReviewOutput(label: string, output: StageReviewOutput, attempt: number) {
  return [
    `## ${label} 리뷰 ${attempt}`,
    '',
    `판정: **${output.verdict === 'pass' ? 'PASS' : 'FAIL'}**`,
    '',
    output.summary,
    '',
    '### 블로킹 이슈',
    formatList(output.blockingFindings),
    '',
    '### 잔여 리스크',
    formatList(output.residualRisks),
    '',
  ].join('\n')
}

function combineRemediationNotes(...notes: Array<string | undefined>) {
  const cleaned = notes.filter((note): note is string => Boolean(note?.trim())).map((note) => note.trim())
  if (cleaned.length === 0) {
    return undefined
  }

  return cleaned.join('\n\n')
}

function buildMergeRecoveryPromptContext(ticket: Ticket) {
  if (!ticket.mergeContext?.mode) {
    return undefined
  }

  const context = ticket.mergeContext

  if (context.mode === 'reconcile_target_worktree') {
    return [
      buildTicketContext(ticket),
      '이번 구현은 merge target의 로컬 변경을 안전하게 보존한 뒤 reviewed ticket 결과와 통합하는 reconcile 작업이다.',
      '현재 새 worktree에는 review를 통과한 ticket 변경이 이미 선적용되어 있다.',
      context.sourceRunId ? `원본 reviewed run: ${context.sourceRunId}` : '',
      context.targetBranchName ? `대상 기준 브랜치: ${context.targetBranchName}` : '',
      context.targetHeadCommit ? `대상 기준 HEAD: ${context.targetHeadCommit}` : '',
      context.sourceReviewedBaseCommit ? `원본 reviewed base commit: ${context.sourceReviewedBaseCommit}` : '',
      context.sourceReviewedHeadCommit ? `원본 reviewed head commit: ${context.sourceReviewedHeadCommit}` : '',
      context.conflictFiles.length > 0 ? `merge를 막은 겹침 파일:\n${context.conflictFiles.map((file) => `- ${file}`).join('\n')}` : '',
      context.safetyBranchName ? `보존된 target 변경 브랜치: ${context.safetyBranchName}` : '',
      context.safetyCommit ? `보존된 target 변경 커밋: ${context.safetyCommit}` : '',
      context.sourceFinalReportOutput ? `원본 Final Report:\n${context.sourceFinalReportOutput}` : '',
      context.sourceReadyOutput ? `원본 Ready 출력:\n${context.sourceReadyOutput}` : '',
      context.sourceDiffSummary ? `원본 reviewed diff 요약:\n${context.sourceDiffSummary}` : '',
      context.safetyDiffSummary ? `보존된 target 변경 diff 요약:\n${context.safetyDiffSummary}` : '',
      '통합 규칙:',
      '- review를 통과한 ticket 결과를 기준선으로 유지한다.',
      '- 보존된 target 변경의 의도는 compatible한 범위만 다시 반영한다.',
      '- unrelated 변경은 건드리지 않는다.',
      '- 충돌 시 reviewed ticket의 API 계약과 완료 기준을 깨지 않는 쪽을 우선한다.',
      '- 통합이 불가능하면 억지로 우회하지 말고 검증/리뷰에서 실패가 드러나게 둔다.',
    ]
      .filter(Boolean)
      .join('\n\n')
  }

  return [
    buildTicketContext(ticket),
    '이번 구현은 merge 충돌 복구를 위해 최신 기준 브랜치에서 기존 reviewed 변경 의도만 다시 적용하는 작업이다.',
    context.sourceRunId ? `원본 reviewed run: ${context.sourceRunId}` : '',
    context.currentBaseCommit ? `최신 기준 커밋: ${context.currentBaseCommit}` : '',
    context.conflictFiles.length > 0 ? `충돌 파일:\n${context.conflictFiles.map((file) => `- ${file}`).join('\n')}` : '',
    context.sourceFinalReportOutput ? `원본 Final Report:\n${context.sourceFinalReportOutput}` : '',
    context.sourceReadyOutput ? `원본 Ready 출력:\n${context.sourceReadyOutput}` : '',
    context.sourceDiffSummary ? `원본 committed diff 요약:\n${context.sourceDiffSummary}` : '',
    '재적용 규칙:',
    '- 최신 기준 브랜치의 unrelated 변경은 유지한다.',
    '- 기존 reviewed 작업의 의도만 최소 변경으로 다시 적용한다.',
    '- 충돌 파일은 최신 기준 브랜치 내용을 우선하고 ticket 요구사항에 필요한 부분만 반영한다.',
  ]
    .filter(Boolean)
    .join('\n\n')
}

function buildImplementPrompt(ticket: Ticket, attempt: number, remediationNotes?: string): string {
  const sections: string[] = []
  const mergeRecoveryContext = buildMergeRecoveryPromptContext(ticket)
  const project = getProjectConfig(ticket)
  const analyzeOutput = ticket.steps.analyze?.output || '분석 결과 없음'
  const planOutput = ticket.steps.plan?.output || '계획 결과 없음'
  const acceptanceCriteria = extractAcceptanceCriteriaFromPlanOutput(planOutput)
  const latestVerificationContext = buildLatestVerificationContext(ticket)

  sections.push(buildSkillInvocation(TICKET_IMPLEMENT_SKILL))

  if (mergeRecoveryContext) {
    sections.push(mergeRecoveryContext)
  } else {
    sections.push(buildTicketContext(ticket))
  }

  sections.push(
    [
      `분석 결과:\n${analyzeOutput}`,
      `승인된 계획:\n${planOutput}`,
      '완료 기준:',
      acceptanceCriteria.length > 0 ? acceptanceCriteria.map((criterion) => `- ${criterion}`).join('\n') : '- 없음',
      '',
      '예정된 자동 검증 명령:',
      formatVerificationCommandCatalog(project),
    ].join('\n')
  )

  if (latestVerificationContext) {
    sections.push(latestVerificationContext)
  }

  if (remediationNotes) {
    sections.push(
      [
        `이전 구현 시도는 ${attempt - 1}번째에서 검증 또는 리뷰를 통과하지 못했다.`,
        '아래 피드백을 직접 해결하도록 코드를 수정해줘.',
        '',
        remediationNotes,
      ].join('\n')
    )
  }

  sections.push(
    [
      '구현 규칙:',
      '- 승인된 계획 범위 안에서만 수정한다.',
      '- 계획에 없는 경로는 명확한 실패 근거가 없다면 건드리지 않는다.',
      '- verify 또는 review 실패가 있으면 해당 테스트, 엔드포인트, assertion과 직접 연결된 파일부터 확인한다.',
      '- 오케스트레이터의 최종 verify를 대체하지 말고, 필요한 국소 확인만 실행한다.',
      '- 필요한 파일만 수정하고 마지막에 한국어로 변경 요약을 짧게 정리한다.',
    ].join('\n')
  )

  return sections.join('\n\n')
}

function buildVerifyPrompt(ticket: Ticket, project: ProjectConfig, verificationRun: VerificationRun) {
  const acceptanceCriteria = extractAcceptanceCriteriaFromPlanOutput(ticket.steps.plan?.output || '')

  return [
    buildSkillInvocation(TICKET_VERIFY_SKILL),
    '',
    buildTicketContext(ticket),
    `승인된 계획:\n${ticket.steps.plan?.output || '계획 결과 없음'}`,
    '',
    '완료 기준:',
    acceptanceCriteria.length > 0 ? acceptanceCriteria.map((criterion) => `- ${criterion}`).join('\n') : '- 없음',
    '',
    '예정된 자동 검증 명령:',
    formatVerificationCommandCatalog(project),
    '',
    `검증 결과:\n${formatVerificationRun(verificationRun)}`,
    '',
    '위 검증 결과를 바탕으로 다음 recovery path 하나만 추천해줘.',
    '구현 보완 이슈면 new_run_implement, 계획 또는 완료 기준 정렬 문제면 new_run_plan, 사람 판단이 필요하면 needs_decision을 선택해줘.',
  ].join('\n')
}

function buildAnalyzeReviewPrompt(ticket: Ticket, project: ProjectConfig) {
  return [
    buildSkillInvocation(TICKET_STAGE_REVIEW_SKILL),
    '',
    buildTicketContext(ticket),
    '예정된 자동 검증 명령:',
    formatVerificationCommandCatalog(project),
    '',
    `분석 결과:\n${ticket.steps.analyze?.output || '분석 결과 없음'}`,
    '',
    '이 분석이 구현 전 단계로 넘어갈 만큼 충분히 정확한지 검토해줘.',
    '요구사항 해석 누락, 영향 범위 오판, 리스크 누락, 실제 자동 검증과 맞지 않는 검증 제안만 블로킹으로 판단해줘.',
  ].join('\n')
}

function buildPlanReviewPrompt(ticket: Ticket, project: ProjectConfig) {
  return [
    buildSkillInvocation(TICKET_STAGE_REVIEW_SKILL),
    '',
    buildTicketContext(ticket),
    '예정된 자동 검증 명령:',
    formatVerificationCommandCatalog(project),
    '',
    `분석 결과:\n${ticket.steps.analyze?.output || '분석 결과 없음'}`,
    '',
    `구현 계획:\n${ticket.steps.plan?.output || '계획 결과 없음'}`,
    '',
    '이 계획이 그대로 구현 단계로 넘어가도 되는지 검토해줘.',
    '변경 범위, 구현 순서, 검증 계획, 실제 자동 검증과의 불일치, 누락된 파일/위험 요소만 블로킹으로 판단해줘.',
  ].join('\n')
}

function extractChangedAreas(diffSummary: string, releaseNotes: string[]) {
  if (releaseNotes.length > 0) {
    return releaseNotes
  }

  const diffStatSection =
    diffSummary.split('Committed diff:\n')[1] ?? diffSummary.split('Diff stat:\n')[1] ?? ''
  const lines = diffStatSection
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

  return lines.slice(0, 8)
}

function buildVerificationSummary(run?: VerificationRun) {
  if (!run) {
    return ['검증 단계 없음']
  }

  return run.commands.map(
    (command) => `${command.label}: ${command.status === 'passed' ? 'PASS' : 'FAIL'}${command.exitCode != null ? ` (exit ${command.exitCode})` : ''}`
  )
}

function buildRecoveryHistory(ticket: Ticket) {
  return ticket.timeline
    .filter((entry) => entry.type === 'system' && entry.title.includes('자동 복구'))
    .map((entry) => entry.title)
    .slice(-5)
}

function deriveFinalReport(ticket: Ticket, review: ReviewRun, verificationRun: VerificationRun | undefined, diffSummary: string): FinalReport {
  const qualityAssessment: FinalReport['qualityAssessment'] = {
    correctness: review.verdict === 'pass' ? 'high' : 'low',
    maintainability: review.blockingFindings.length === 0 && review.residualRisks.length <= 1 ? 'high' : 'medium',
    testConfidence: verificationRun?.status === 'passed' ? 'high' : includesStep(ticket, 'verify') ? 'low' : 'medium',
    risk: review.blockingFindings.length > 0 ? 'high' : review.residualRisks.length > 1 ? 'medium' : 'low',
  }

  const report: FinalReport = {
    summary: review.summary,
    changedAreas: extractChangedAreas(diffSummary, review.releaseNotes),
    verificationSummary: buildVerificationSummary(verificationRun),
    goalAssessment: review.goalAssessment,
    qualityAssessment,
    blockingFindings: review.blockingFindings,
    residualRisks: review.residualRisks,
    mergeRecommendation:
      review.verdict === 'pass' && (verificationRun?.status === 'passed' || !includesStep(ticket, 'verify'))
        ? 'merge'
        : 'hold',
    output: '',
    createdAt: new Date().toISOString(),
  }

  report.output = [
    '## 최종 보고',
    '',
    report.summary,
    '',
    ...(buildRecoveryHistory(ticket).length > 0
      ? ['### 복구 이력', formatList(buildRecoveryHistory(ticket)), '']
      : []),
    '### 변경 영역',
    formatList(report.changedAreas),
    '',
    '### 검증 요약',
    formatList(report.verificationSummary),
    '',
    formatGoalAssessment(report.goalAssessment),
    '### 코드 품질 평가',
    `- Correctness: ${report.qualityAssessment.correctness}`,
    `- Maintainability: ${report.qualityAssessment.maintainability}`,
    `- Test Confidence: ${report.qualityAssessment.testConfidence}`,
    `- Risk: ${report.qualityAssessment.risk}`,
    '',
    '### 블로킹 이슈',
    formatList(report.blockingFindings),
    '',
    '### 잔여 리스크',
    formatList(report.residualRisks),
    '',
    `### Merge 권고\n- ${report.mergeRecommendation === 'merge' ? 'merge' : 'hold'}`,
    '',
  ].join('\n')

  return report
}

async function runCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<{ exitCode: number | null; output: string; durationMs: number; timedOut: boolean }> {
  ensureAbortSignal(signal)

  return new Promise((resolve, reject) => {
    const startedAt = Date.now()
    const child = spawn(command, {
      cwd,
      env: { ...process.env },
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let output = ''
    let timedOut = false
    let finished = false

    const finish = (fn: () => void) => {
      if (finished) return
      finished = true
      clearTimeout(timeout)
      signal?.removeEventListener('abort', onAbort)
      fn()
    }

    const onAbort = () => {
      child.kill('SIGTERM')
      finish(() => {
        const error = new Error('Command aborted')
        error.name = 'AbortError'
        reject(error)
      })
    }

    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true })
    }

    child.stdout?.on('data', (chunk) => {
      output += chunk.toString()
    })

    child.stderr?.on('data', (chunk) => {
      output += chunk.toString()
    })

    child.on('error', (error) => {
      finish(() => reject(error))
    })

    child.on('close', (code) => {
      finish(() => {
        resolve({
          exitCode: code,
          output,
          durationMs: Date.now() - startedAt,
          timedOut,
        })
      })
    })

    const timeout = setTimeout(() => {
      timedOut = true
      output += `\n\n[timeout] Command exceeded ${timeoutMs}ms`
      child.kill('SIGTERM')
      setTimeout(() => {
        child.kill('SIGKILL')
      }, 1000).unref()
    }, timeoutMs)
  })
}

async function readGitValue(command: string, cwd: string, signal?: AbortSignal) {
  const result = await runCommand(command, cwd, 15_000, signal)
  if (result.exitCode !== 0) {
    throw new Error(`Git command failed: ${command}`)
  }

  return result.output.trim()
}

function recordCleanupFailure(ticketId: string, message: string, patch: Partial<TicketWorktree> = {}) {
  updateTicketWorktree(ticketId, {
    ...patch,
    status: 'cleanup_failed',
  })
  appendTimelineEvent(ticketId, {
    type: 'system',
    title: '워크트리 정리에 실패했습니다.',
    body: message,
  })
}

function quoteShellArg(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function buildTicketWorktreeCommitMessage(ticket: Ticket) {
  const normalizedTitle = ticket.title.replace(/\s+/g, ' ').trim()
  return `[${ticket.id}] ${normalizedTitle || 'ticket changes'}`
}

function buildTicketWorktreeSlug(ticket: Ticket, attempt: number) {
  const runId = (ticket.activeRunId ?? 'run-unknown').toLowerCase()
  return `${ticket.id.toLowerCase()}-${runId}-attempt-${attempt}`
}

export function ensureProjectDependenciesAvailableInWorktree(projectPath: string, worktreePath: string) {
  const repositoryRoot = resolveProjectRepositoryRoot(projectPath)
  const normalizedWorktreePath = resolve(worktreePath)

  for (const ancestorPath of listProjectAncestorsWithinRepository(projectPath)) {
    const sourceNodeModulesPath = resolve(ancestorPath, 'node_modules')
    if (!existsSync(sourceNodeModulesPath)) {
      continue
    }

    const ancestorRelativePath = relative(repositoryRoot, ancestorPath)
    const targetDirectory =
      ancestorRelativePath === '' ? normalizedWorktreePath : resolve(normalizedWorktreePath, ancestorRelativePath)
    mkdirSync(targetDirectory, { recursive: true })

    const targetNodeModulesPath = resolve(targetDirectory, 'node_modules')
    if (existsSync(targetNodeModulesPath)) {
      continue
    }

    try {
      symlinkSync(sourceNodeModulesPath, targetNodeModulesPath, process.platform === 'win32' ? 'junction' : 'dir')
    } catch (error: any) {
      if (error?.code === 'EEXIST') {
        continue
      }

      throw new Error(error?.message || 'Failed to link project dependencies into ticket worktree')
    }
  }
}

async function ensureWorktree(ticket: Ticket, attempt: number, signal?: AbortSignal): Promise<TicketWorktree> {
  if (ticket.worktree && existsSync(ticket.worktree.worktreePath)) {
    return ticket.worktree
  }

  const now = new Date().toISOString()
  const projectRepositoryRoot = resolveProjectRepositoryRoot(ticket.projectPath)
  const worktreeRoot = resolveProjectWorktreeRoot(ticket.projectPath)
  mkdirSync(worktreeRoot, { recursive: true })

  const baseBranch = (await readGitValue('git branch --show-current', projectRepositoryRoot, signal)) || 'HEAD'
  const baseCommit = await readGitValue('git rev-parse HEAD', projectRepositoryRoot, signal)
  const worktreeSlug = buildTicketWorktreeSlug(ticket, attempt)
  const branchName = `tickets/${worktreeSlug}`
  const worktreePath = resolve(worktreeRoot, worktreeSlug)

  const addResult = await runCommand(
    `git worktree add -b "${branchName}" "${worktreePath}" "${baseBranch}"`,
    projectRepositoryRoot,
    30_000,
    signal
  )
  if (addResult.exitCode !== 0) {
    throw new Error(addResult.output.trim() || 'Failed to create git worktree')
  }

  ensureProjectDependenciesAvailableInWorktree(ticket.projectPath, worktreePath)

  const worktree: TicketWorktree = {
    branchName,
    baseBranch,
    baseCommit,
    worktreePath,
    status: 'pending',
    createdAt: now,
    updatedAt: now,
  }

  setTicketWorktree(ticket.id, worktree)
  return worktree
}

async function prepareReconcileSeededWorktree(ticket: Ticket, signal?: AbortSignal) {
  const context = ticket.mergeContext
  if (!ticket.worktree || context?.mode !== 'reconcile_target_worktree' || context.reconcileSeedApplied) {
    return
  }

  if (!context.sourceReviewedBaseCommit || !context.sourceReviewedHeadCommit) {
    throw new Error('Reconcile worktree is missing the reviewed commit range to seed')
  }

  if (context.sourceReviewedBaseCommit === context.sourceReviewedHeadCommit) {
    setTicketMergeContext(ticket.id, {
      ...context,
      conflictFiles: [...context.conflictFiles],
      reconcileSeedApplied: true,
      reconcileSeedHeadCommit: context.sourceReviewedHeadCommit,
    })
    return
  }

  const cherryPickResult = await runCommand(
    `git cherry-pick ${quoteShellArg(`${context.sourceReviewedBaseCommit}..${context.sourceReviewedHeadCommit}`)}`,
    ticket.worktree.worktreePath,
    60_000,
    signal
  )
  if (cherryPickResult.exitCode !== 0) {
    await runCommand('git cherry-pick --abort', ticket.worktree.worktreePath, 15_000, signal)
    throw new Error(cherryPickResult.output.trim() || 'Failed to pre-apply reviewed ticket changes to the reconcile worktree')
  }

  const refreshedTicket = getTicketOrThrow(ticket.id)
  const seededHeadCommit = await readGitValue('git rev-parse HEAD', refreshedTicket.worktree!.worktreePath, signal)
  const diffSummary = await collectCommittedTicketDiffSummary(refreshedTicket, signal)

  updateTicketWorktree(ticket.id, {
    headCommit: seededHeadCommit,
    diffSummary,
  })
  const refreshedMergeContext = getTicketOrThrow(ticket.id).mergeContext
  if (!refreshedMergeContext) {
    throw new Error('Reconcile merge context disappeared while seeding the worktree')
  }
  setTicketMergeContext(ticket.id, {
    ...refreshedMergeContext,
    conflictFiles: [...refreshedMergeContext.conflictFiles],
    reconcileSeedApplied: true,
    reconcileSeedHeadCommit: seededHeadCommit,
  })
  appendTimelineEvent(ticket.id, {
    type: 'system',
    title: 'review를 통과한 ticket 변경을 reconcile worktree에 먼저 적용했습니다.',
  })
}

async function captureWorktreeSummary(ticket: Ticket, signal?: AbortSignal) {
  if (!ticket.worktree) {
    throw new Error('Ticket worktree not initialized')
  }

  const headCommit = await readGitValue('git rev-parse HEAD', ticket.worktree.worktreePath, signal)
  const diffSummary = await collectCommittedTicketDiffSummary(ticket, signal)

  updateTicketWorktree(ticket.id, {
    headCommit,
    diffSummary,
    status: 'ready',
  })

  return {
    headCommit,
    diffSummary,
  }
}

async function cleanupWorktreeReference(projectPath: string, worktree: TicketWorktree, signal?: AbortSignal) {
  const repositoryRoot = resolveProjectRepositoryRoot(projectPath)
  const removeResult = await runCommand(
    `git worktree remove --force "${worktree.worktreePath}"`,
    repositoryRoot,
    30_000,
    signal
  )
  if (removeResult.exitCode !== 0) {
    throw new Error(removeResult.output.trim() || 'Failed to remove git worktree')
  }

  const deleteBranchResult = await runCommand(`git branch -D "${worktree.branchName}"`, repositoryRoot, 30_000, signal)

  if (deleteBranchResult.exitCode === 0) {
    return
  }

  const pruneResult = await runCommand('git worktree prune', repositoryRoot, 30_000, signal)
  if (pruneResult.exitCode === 0) {
    const retryDeleteBranchResult = await runCommand(
      `git branch -D "${worktree.branchName}"`,
      repositoryRoot,
      30_000,
      signal
    )

    if (retryDeleteBranchResult.exitCode === 0) {
      return
    }

    throw new Error(retryDeleteBranchResult.output.trim() || 'Failed to delete worktree branch')
  }

  throw new Error(deleteBranchResult.output.trim() || 'Failed to delete worktree branch')
}

async function cleanupWorktree(ticket: Ticket, signal?: AbortSignal) {
  if (!ticket.worktree) {
    return
  }

  await cleanupWorktreeReference(ticket.projectPath, ticket.worktree, signal)
}

async function reconcileMissingWorktreeReference(projectPath: string, worktree: TicketWorktree, signal?: AbortSignal) {
  const repositoryRoot = resolveProjectRepositoryRoot(projectPath)
  const pruneResult = await runCommand('git worktree prune', repositoryRoot, 30_000, signal)
  if (pruneResult.exitCode !== 0) {
    throw new Error(pruneResult.output.trim() || 'Failed to prune git worktrees')
  }

  const branchLookup = await runCommand(
    `git rev-parse --verify --quiet "refs/heads/${worktree.branchName}"`,
    repositoryRoot,
    15_000,
    signal
  )

  if (branchLookup.exitCode !== 0) {
    return
  }

  const deleteBranchResult = await runCommand(`git branch -D "${worktree.branchName}"`, repositoryRoot, 30_000, signal)

  if (deleteBranchResult.exitCode !== 0) {
    throw new Error(deleteBranchResult.output.trim() || 'Failed to delete worktree branch')
  }
}

async function reconcileMissingWorktree(ticket: Ticket, signal?: AbortSignal) {
  if (!ticket.worktree) {
    return
  }

  await reconcileMissingWorktreeReference(ticket.projectPath, ticket.worktree, signal)
}

async function cleanupSupersededWorktree(ticketId: string, signal?: AbortSignal) {
  const ticket = getTicketOrThrow(ticketId)
  const supersededWorktree = ticket.mergeContext?.supersededWorktree

  if (!supersededWorktree) {
    if (ticket.mergeContext?.mode === 'reapply_on_latest_base') {
      setTicketMergeContext(ticketId, undefined)
    }
    return true
  }

  try {
    if (existsSync(supersededWorktree.worktreePath)) {
      await cleanupWorktreeReference(ticket.projectPath, supersededWorktree, signal)
    } else {
      await reconcileMissingWorktreeReference(ticket.projectPath, supersededWorktree, signal)
    }

    setTicketMergeContext(ticketId, undefined)
    return true
  } catch (error: any) {
    appendTimelineEvent(ticketId, {
      type: 'system',
      title: '이전 reviewed worktree 정리에 실패했습니다.',
      body: error.message,
    })
    return false
  }
}

export async function preserveTargetWorktreeForMergeReconcile(ticketId: string, signal?: AbortSignal) {
  const ticket = getTicketOrThrow(ticketId)
  if (!ticket.worktree || ticket.status !== 'awaiting_merge') {
    throw new Error('Ticket is not waiting for a merge decision')
  }

  const dirtyTarget = await inspectDirtyMergeTarget(ticket, signal)
  if (dirtyTarget.dirtyFiles.length === 0) {
    throw new Error('Merge target has no local changes to preserve')
  }

  const repositoryRoot = resolveProjectRepositoryRoot(ticket.projectPath)
  const targetBranchName = (await readGitValue('git branch --show-current', repositoryRoot, signal)) || undefined
  const targetHeadCommit = await readGitValue('git rev-parse HEAD', repositoryRoot, signal)
  const safetyBranchName = `wip/merge-safety-${ticket.id.toLowerCase()}-${Date.now()}`
  let switchedToSafetyBranch = false

  try {
    const createBranchResult = await runCommand(`git switch -c "${safetyBranchName}"`, repositoryRoot, 30_000, signal)
    if (createBranchResult.exitCode !== 0) {
      throw new Error(createBranchResult.output.trim() || 'Failed to create a safety branch for the merge target')
    }
    switchedToSafetyBranch = true

    const addResult = await runCommand('git add -A', repositoryRoot, 30_000, signal)
    if (addResult.exitCode !== 0) {
      throw new Error(addResult.output.trim() || 'Failed to stage target worktree changes for preservation')
    }

    const stagedCheck = await runCommand('git diff --cached --quiet --exit-code', repositoryRoot, 15_000, signal)
    if (stagedCheck.exitCode === 0) {
      throw new Error('Merge target has no stageable local changes to preserve')
    }
    if (stagedCheck.exitCode !== 1) {
      throw new Error(stagedCheck.output.trim() || 'Failed to inspect staged target worktree changes')
    }

    const commitResult = await runCommand(
      `git -c user.name=${quoteShellArg('Ticket Automation')} -c user.email=${quoteShellArg('ticket-automation@local')} commit --no-verify -m ${quoteShellArg(`[${ticket.id}] preserve merge target changes`)}`,
      repositoryRoot,
      30_000,
      signal
    )
    if (commitResult.exitCode !== 0) {
      throw new Error(commitResult.output.trim() || 'Failed to create a safety commit for the merge target')
    }

    const safetyCommit = await readGitValue('git rev-parse HEAD', repositoryRoot, signal)
    const safetyDiffSummaryResult = await runCommand(
      `git show --stat --format=medium ${quoteShellArg(safetyCommit)} -- . ':(exclude)node_modules'`,
      ticket.projectPath,
      15_000,
      signal
    )
    const restoreCommand = targetBranchName
      ? `git switch ${quoteShellArg(targetBranchName)}`
      : `git switch --detach ${quoteShellArg(targetHeadCommit)}`
    const restoreResult = await runCommand(restoreCommand, repositoryRoot, 30_000, signal)
    if (restoreResult.exitCode !== 0) {
      throw new Error(restoreResult.output.trim() || 'Failed to restore the original merge target branch')
    }

    return {
      targetBranchName,
      targetHeadCommit,
      safetyBranchName,
      safetyCommit,
      safetyDiffSummary:
        safetyDiffSummaryResult.exitCode === 0 && safetyDiffSummaryResult.output.trim()
          ? safetyDiffSummaryResult.output.trim()
          : dirtyTarget.dirtySummary || '보존된 target 변경 요약을 가져오지 못했습니다.',
    }
  } catch (error) {
    if (switchedToSafetyBranch) {
      const restoreCommand = targetBranchName
        ? `git switch ${quoteShellArg(targetBranchName)}`
        : `git switch --detach ${quoteShellArg(targetHeadCommit)}`
      try {
        await runCommand(restoreCommand, repositoryRoot, 30_000, signal)
      } catch (restoreError) {
        console.error(`Failed to restore merge target after preservation error for ${ticketId}:`, restoreError)
      }
    }

    throw error
  }
}

async function collectGitSummary(cwd: string, signal?: AbortSignal): Promise<string> {
  try {
    const status = await runCommand("git status --short -- . ':(exclude)node_modules'", cwd, 15_000, signal)
    const diffStat = await runCommand("git diff --stat -- . ':(exclude)node_modules'", cwd, 15_000, signal)
    const sections: string[] = []

    if (status.output.trim()) {
      sections.push(`Git status:\n${status.output.trim()}`)
    }

    if (diffStat.output.trim()) {
      sections.push(`Diff stat:\n${diffStat.output.trim()}`)
    }

    return sections.join('\n\n') || '변경 요약을 가져오지 못했습니다.'
  } catch {
    return 'Git 변경 요약을 가져오지 못했습니다.'
  }
}

async function collectCommittedTicketDiffSummary(ticket: Ticket, signal?: AbortSignal): Promise<string> {
  if (!ticket.worktree) {
    throw new Error('Ticket worktree not initialized')
  }

  try {
    const cwd = getExecutionCwd(ticket)
    const sections: string[] = []
    const status = await runCommand("git status --short -- . ':(exclude)node_modules'", cwd, 15_000, signal)
    const committedDiff = await runCommand(
      `git diff --stat ${quoteShellArg(`${ticket.worktree.baseCommit}..HEAD`)} -- . ':(exclude)node_modules'`,
      cwd,
      15_000,
      signal
    )

    if (status.output.trim()) {
      sections.push(`Git status:\n${status.output.trim()}`)
    }

    if (committedDiff.output.trim()) {
      sections.push(`Committed diff:\n${committedDiff.output.trim()}`)
    }

    return sections.join('\n\n') || '커밋된 변경 요약을 가져오지 못했습니다.'
  } catch {
    return '커밋된 변경 요약을 가져오지 못했습니다.'
  }
}

function normalizeGitPath(path: string) {
  const trimmed = path.trim()
  if (!trimmed) {
    return ''
  }

  const normalized = trimmed.includes(' -> ') ? trimmed.slice(trimmed.lastIndexOf(' -> ') + 4) : trimmed
  if (normalized.startsWith('"') && normalized.endsWith('"')) {
    return normalized.slice(1, -1).replace(/\\"/g, '"')
  }

  return normalized
}

function parseGitStatusPaths(output: string) {
  const files = new Set<string>()

  for (const line of output.split('\n')) {
    const trimmed = line.trimEnd()
    if (!trimmed) {
      continue
    }

    const path = normalizeGitPath(trimmed.slice(3))
    if (path) {
      files.add(path)
    }
  }

  return [...files]
}

async function collectTicketChangedFiles(ticket: Ticket, signal?: AbortSignal) {
  if (!ticket.worktree) {
    return []
  }

  const diffResult = await runCommand(
    `git diff --name-only ${quoteShellArg(`${ticket.worktree.baseCommit}..HEAD`)} -- . ':(exclude)node_modules'`,
    getExecutionCwd(ticket),
    15_000,
    signal
  )
  if (diffResult.exitCode !== 0) {
    throw new Error(diffResult.output.trim() || 'Failed to collect ticket changed files')
  }

  return diffResult.output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

interface DirtyTargetInspection {
  dirtyFiles: string[]
  dirtySummary: string
  overlappingFiles: string[]
  ticketChangedFiles: string[]
}

async function inspectDirtyMergeTarget(ticket: Ticket, signal?: AbortSignal): Promise<DirtyTargetInspection> {
  const dirtyStatus = await runCommand("git status --short --untracked-files=all -- . ':(exclude)node_modules'", ticket.projectPath, 15_000, signal)
  if (dirtyStatus.exitCode !== 0) {
    throw new Error(dirtyStatus.output.trim() || 'Failed to inspect merge target worktree status')
  }

  const dirtyFiles = parseGitStatusPaths(dirtyStatus.output)
  const ticketChangedFiles = await collectTicketChangedFiles(ticket, signal)
  const dirtyFileSet = new Set(dirtyFiles)
  const overlappingFiles = ticketChangedFiles.filter((path) => dirtyFileSet.has(path))

  return {
    dirtyFiles,
    dirtySummary: dirtyStatus.output.trim(),
    overlappingFiles,
    ticketChangedFiles,
  }
}

function buildDirtyTargetMergeMessage(files: string[]) {
  const detail = files.length > 0 ? `: ${files.join(', ')}` : ''
  return `Merge target worktree has local changes overlapping reviewed ticket files${detail}`
}

async function ensureMergeableWorktreeCommit(ticket: Ticket, signal?: AbortSignal) {
  if (!ticket.worktree) {
    throw new Error('Ticket worktree not initialized')
  }

  const cwd = getExecutionCwd(ticket)
  const addResult = await runCommand("git add -A -- . ':(exclude)node_modules'", cwd, 30_000, signal)
  if (addResult.exitCode !== 0) {
    throw new Error(addResult.output.trim() || 'Failed to stage ticket worktree changes')
  }

  const stagedCheck = await runCommand('git diff --cached --quiet --exit-code', cwd, 15_000, signal)
  if (stagedCheck.exitCode === 1) {
    const commitResult = await runCommand(
      `git -c user.name=${quoteShellArg('Ticket Automation')} -c user.email=${quoteShellArg('ticket-automation@local')} commit --no-verify -m ${quoteShellArg(buildTicketWorktreeCommitMessage(ticket))}`,
      cwd,
      30_000,
      signal
    )

    if (commitResult.exitCode !== 0) {
      throw new Error(commitResult.output.trim() || 'Failed to create ticket worktree commit')
    }
  } else if (stagedCheck.exitCode !== 0) {
    throw new Error(stagedCheck.output.trim() || 'Failed to inspect staged ticket worktree changes')
  }

  const headCommit = await readGitValue('git rev-parse HEAD', cwd, signal)
  if (headCommit === ticket.worktree.baseCommit) {
    throw new Error('Ticket worktree has no mergeable commit. Re-run implementation before ready.')
  }

  const diffSummary = await collectCommittedTicketDiffSummary(ticket, signal)
  updateTicketWorktree(ticket.id, {
    headCommit,
    diffSummary,
    status: 'ready',
  })

  return {
    headCommit,
    diffSummary,
  }
}

function classifyMergeIssueKind(message: string): TicketMergeIssueKind {
  if (message.includes('Merge target branch changed since worktree creation')) {
    return 'base_branch_changed'
  }

  if (message.includes('Merge target commit changed since worktree creation')) {
    return 'base_commit_changed'
  }

  if (message.includes('Worktree head changed after review')) {
    return 'head_changed_after_review'
  }

  if (
    message.includes('Merge target worktree has local changes overlapping reviewed ticket files') ||
    message.includes('would be overwritten by merge') ||
    message.includes('untracked working tree files would be overwritten by merge')
  ) {
    return 'target_worktree_dirty'
  }

  if (message.includes('rebase')) {
    return 'rebase_failed'
  }

  if (message.includes('merge')) {
    return 'merge_conflict'
  }

  return 'unknown'
}

interface MergeIssueAnalysis {
  issue: TicketMergeIssueKind
  conflictFiles: string[]
  analysisKey?: string
  currentBaseCommit?: string
  currentHeadCommit?: string
  targetDirtyFiles?: string[]
  targetDirtySummary?: string
  ticketChangedFiles?: string[]
}

function isTextConflictFile(path: string) {
  const normalized = path.trim().toLowerCase()
  if (normalized.startsWith('docs/') || normalized.startsWith('todo/')) {
    return true
  }

  return [...TEXT_CONFLICT_FILE_EXTENSIONS].some((extension) => normalized.endsWith(extension))
}

function extractConflictFilesFromMergeTree(output: string) {
  const files = new Set<string>()
  let captureNextPath = false

  for (const line of output.split('\n')) {
    if (/^(changed in both|added in both|removed in both|added in remote|added in local|removed in remote|removed in local)$/.test(line.trim())) {
      captureNextPath = true
      continue
    }

    if (!captureNextPath) {
      continue
    }

    const match = /^\s+(?:base|our|their)\s+\d+\s+[0-9a-f]+\s+(.+)$/.exec(line)
    if (!match) {
      continue
    }

    files.add(match[1].trim())
    captureNextPath = false
  }

  return [...files]
}

function allowedMergeActionsForIssue(issue: TicketMergeIssueKind): TicketMergeResolutionAction[] {
  if (issue === 'head_changed_after_review') {
    return ['revalidate_current_worktree', 'restart_from_plan', 'discard_worktree']
  }

  if (issue === 'target_worktree_dirty') {
    return ['preserve_target_changes_and_reconcile', 'restart_from_plan', 'discard_worktree']
  }

  if (issue === 'rebase_conflict_text' || issue === 'rebase_conflict_code') {
    return ['reapply_on_latest_base', 'restart_from_plan', 'discard_worktree']
  }

  return ['rebase_and_revalidate', 'restart_from_plan', 'discard_worktree']
}

async function inspectMergeIssue(ticket: Ticket, message: string, signal?: AbortSignal): Promise<MergeIssueAnalysis> {
  if (!ticket.worktree) {
    return {
      issue: classifyMergeIssueKind(message),
      conflictFiles: [],
    }
  }

  const currentBaseCommit = await readGitValue('git rev-parse HEAD', ticket.projectPath, signal)
  const currentHeadCommit = await readGitValue('git rev-parse HEAD', ticket.worktree.worktreePath, signal)
  const dirtyTarget = await inspectDirtyMergeTarget(ticket, signal)
  const dirtyFingerprint = createHash('sha1')
    .update(dirtyTarget.dirtySummary)
    .update(`\n${dirtyTarget.overlappingFiles.join('\n')}`)
    .digest('hex')
  const analysisKey = `${ticket.worktree.baseCommit}:${currentBaseCommit}:${currentHeadCommit}:${dirtyFingerprint}`
  const classifiedIssue = classifyMergeIssueKind(message)

  if (classifiedIssue === 'target_worktree_dirty' || dirtyTarget.overlappingFiles.length > 0) {
    const conflictFiles =
      dirtyTarget.overlappingFiles.length > 0 ? dirtyTarget.overlappingFiles : dirtyTarget.dirtyFiles

    return {
      issue: 'target_worktree_dirty',
      conflictFiles,
      analysisKey,
      currentBaseCommit,
      currentHeadCommit,
      targetDirtyFiles: dirtyTarget.dirtyFiles,
      targetDirtySummary: dirtyTarget.dirtySummary,
      ticketChangedFiles: dirtyTarget.ticketChangedFiles,
    }
  }

  const mergeTree = await runCommand(
    `git merge-tree ${quoteShellArg(ticket.worktree.baseCommit)} ${quoteShellArg(currentBaseCommit)} ${quoteShellArg(currentHeadCommit)}`,
    ticket.projectPath,
    15_000,
    signal
  )
  const conflictFiles = extractConflictFilesFromMergeTree(mergeTree.output)

  if (conflictFiles.length > 0) {
    return {
      issue: conflictFiles.every(isTextConflictFile) ? 'rebase_conflict_text' : 'rebase_conflict_code',
      conflictFiles,
      analysisKey,
      currentBaseCommit,
      currentHeadCommit,
    }
  }

  return {
    issue: classifiedIssue,
    conflictFiles: [],
    analysisKey,
    currentBaseCommit,
    currentHeadCommit,
  }
}

async function collectMergeDecisionEvidence(ticket: Ticket, analysis: MergeIssueAnalysis, signal?: AbortSignal) {
  if (!ticket.worktree) {
    return 'worktree 정보가 없습니다.'
  }

  const currentBranch = (await readGitValue('git branch --show-current', ticket.projectPath, signal)) || 'HEAD'
  const currentBaseCommit = analysis.currentBaseCommit ?? (await readGitValue('git rev-parse HEAD', ticket.projectPath, signal))
  const currentHead = analysis.currentHeadCommit ?? (await readGitValue('git rev-parse HEAD', ticket.worktree.worktreePath, signal))
  const relation = await runCommand(
    `git rev-list --left-right --count ${quoteShellArg(`${currentBaseCommit}...${currentHead}`)}`,
    ticket.projectPath,
    15_000,
    signal
  )
  const baseDelta = await runCommand(
    `git diff --stat ${quoteShellArg(`${ticket.worktree.baseCommit}..${currentBaseCommit}`)}`,
    ticket.projectPath,
    15_000,
    signal
  )
  const worktreeSummary = await collectCommittedTicketDiffSummary(ticket, signal)

  return [
    `- 현재 기준 브랜치: \`${currentBranch}\``,
    `- 현재 기준 커밋: \`${currentBaseCommit}\``,
    `- 기록된 기준 브랜치: \`${ticket.worktree.baseBranch}\``,
    `- 기록된 기준 커밋: \`${ticket.worktree.baseCommit}\``,
    `- 현재 worktree HEAD: \`${currentHead}\``,
    analysis.conflictFiles.length > 0 ? `- 충돌 파일: ${analysis.conflictFiles.map((entry) => `\`${entry}\``).join(', ')}` : '',
    analysis.targetDirtyFiles?.length
      ? `- merge를 막는 target dirty 파일: ${analysis.targetDirtyFiles.map((entry) => `\`${entry}\``).join(', ')}`
      : '',
    analysis.ticketChangedFiles?.length
      ? `- reviewed ticket 변경 파일: ${analysis.ticketChangedFiles.map((entry) => `\`${entry}\``).join(', ')}`
      : '',
    ticket.mergeContext?.lastAttemptedAction
      ? `- 마지막으로 시도한 복구 액션: \`${ticket.mergeContext.lastAttemptedAction}\``
      : '',
    relation.output.trim() ? `- 현재 기준 커밋 대비 ahead/behind: ${relation.output.trim()}` : '',
    baseDelta.output.trim() ? `- 기준 브랜치 이동 요약:\n${baseDelta.output.trim()}` : '- 기준 브랜치 이동 요약: 없음',
    analysis.targetDirtySummary ? `- target repo dirty 상태:\n${analysis.targetDirtySummary}` : '',
    '',
    worktreeSummary,
  ]
    .filter(Boolean)
    .join('\n')
}

function buildFallbackMergeOptions(issue: TicketMergeIssueKind): TicketMergeOption[] {
  const options: TicketMergeOption[] = []

  if (issue === 'head_changed_after_review') {
    options.push({
      id: 'merge-revalidate-current-worktree',
      label: formatMergeResolutionLabel('revalidate_current_worktree'),
      action: 'revalidate_current_worktree',
      rationale: '기준 브랜치는 유지된 상태에서 worktree HEAD만 바뀐 경우에는 verify/review만 다시 실행하는 경로가 가장 비용이 낮습니다.',
      recommended: true,
    })
  }

  if (issue === 'rebase_conflict_text') {
    options.push({
      id: 'merge-reapply-on-latest-base',
      label: formatMergeResolutionLabel('reapply_on_latest_base'),
      action: 'reapply_on_latest_base',
      rationale: '자동 rebase 대신 최신 기준 브랜치에서 검토된 변경 의도를 다시 적용하면 충돌 문맥을 보존하면서 검증을 새로 진행할 수 있습니다.',
      recommended: true,
    })
  }

  if (issue === 'rebase_conflict_code') {
    options.push({
      id: 'merge-reapply-on-latest-base',
      label: formatMergeResolutionLabel('reapply_on_latest_base'),
      action: 'reapply_on_latest_base',
      rationale: '충돌 범위가 코드이므로 최신 기준 브랜치에서 변경 의도만 다시 적용하는 새 run이 필요합니다.',
    })
  }

  if (issue === 'target_worktree_dirty') {
    options.push({
      id: 'merge-preserve-target-and-reconcile',
      label: formatMergeResolutionLabel('preserve_target_changes_and_reconcile'),
      action: 'preserve_target_changes_and_reconcile',
      rationale:
        'merge 대상을 막고 있는 로컬 변경을 안전 브랜치에 보존한 뒤, review를 통과한 ticket 결과와 새 run에서 다시 통합하는 것이 가장 안전합니다.',
      recommended: true,
    })
  }

  if (issue === 'base_branch_changed' || issue === 'base_commit_changed' || issue === 'merge_conflict' || issue === 'rebase_failed') {
    options.push({
      id: 'merge-rebase-and-revalidate',
      label: formatMergeResolutionLabel('rebase_and_revalidate'),
      action: 'rebase_and_revalidate',
      rationale: '현재 worktree 변경을 유지한 채 최신 기준 브랜치 위로 올린 뒤 verify/review를 다시 실행하는 것이 가장 자연스러운 복구 경로입니다.',
      recommended: true,
    })
  }

  options.push({
    id: 'merge-restart-plan',
    label: formatMergeResolutionLabel('restart_from_plan'),
    action: 'restart_from_plan',
    rationale: '기준 브랜치 드리프트가 크거나 rebase 위험이 크다고 판단되면 새 run으로 계획부터 다시 시작하는 편이 안전합니다.',
    recommended: options.length === 0,
  })
  options.push({
    id: 'merge-discard-worktree',
    label: formatMergeResolutionLabel('discard_worktree'),
    action: 'discard_worktree',
    rationale: '현재 작업을 반영하지 않기로 결정했다면 worktree를 폐기하는 경로가 가장 단순합니다.',
  })

  return options
}

function normalizeMergeDecisionBlock(
  ticket: Ticket,
  message: string,
  analysis: MergeIssueAnalysis,
  output: MergeDecisionOutput | undefined
) {
  const fallbackOptions = buildFallbackMergeOptions(analysis.issue)
  const allowedActions = new Set(allowedMergeActionsForIssue(analysis.issue))
  const mappedOptions = output?.options
    ?.map((option, index) => ({
      id: `merge-option-${index + 1}-${option.action}`,
      label: formatMergeResolutionLabel(option.action),
      action: option.action,
      rationale: option.rationale,
      recommended: option.action === output.recommendedAction,
    }))
    .filter(
      (option, index, list) =>
        allowedActions.has(option.action) &&
        list.findIndex((entry) => entry.action === option.action) === index &&
        option.rationale.trim().length > 0
    )

  const options = (mappedOptions && mappedOptions.length > 0 ? mappedOptions : fallbackOptions).map((option, index, list) => ({
    ...option,
    recommended: option.recommended || (!list.some((entry) => entry.recommended) && index === 0),
  }))
  const now = new Date().toISOString()

  return {
    issue: analysis.issue,
    errorMessage: message,
    summary:
      output?.summary?.trim() ||
      `자동 merge가 현재 상태에서는 안전하지 않아 추가 조치가 필요합니다. (${ticket.worktree?.baseBranch} 기준 재정렬 여부를 먼저 결정해야 합니다.)`,
    findings: output?.findings?.length ? output.findings : [message],
    conflictFiles: [...analysis.conflictFiles],
    options,
    createdAt: now,
    updatedAt: now,
  } satisfies TicketMergeBlock
}

function isMergeDecisionRequired(message: string) {
  return (
    message.includes('Merge target branch changed since worktree creation') ||
    message.includes('Merge target commit changed since worktree creation') ||
    message.includes('Worktree head changed after review') ||
    message.includes('Merge target worktree has local changes overlapping reviewed ticket files') ||
    message.includes('Failed to merge ticket worktree branch') ||
    message.includes('would be overwritten by merge') ||
    message.includes('untracked working tree files would be overwritten by merge')
  )
}

export async function analyzeTicketMergeIssue(ticketId: string, message: string, signal?: AbortSignal) {
  const ticket = getTicketOrThrow(ticketId)
  const analysis = await inspectMergeIssue(ticket, message, signal)
  if (
    analysis.analysisKey &&
    ticket.mergeContext?.analysisKey === analysis.analysisKey &&
    ticket.mergeBlock &&
    ticket.mergeBlock.issue === analysis.issue
  ) {
    return ticket.mergeBlock
  }

  const evidence = await collectMergeDecisionEvidence(ticket, analysis, signal)
  const reviewStep = getStepConfig('review')
  const allowedActions = allowedMergeActionsForIssue(analysis.issue)
  let mergeBlock = normalizeMergeDecisionBlock(ticket, message, analysis, undefined)

  try {
    const result = await runCodexTurnImpl<MergeDecisionOutput>({
      prompt: buildMergeDecisionPrompt(ticket, message, evidence, allowedActions),
      promptFile: MERGE_DECISION_PROMPT_FILE,
      cwd: getExecutionCwd(ticket),
      additionalDirectories: getProjectSkillDirectories(),
      model: getTicketModel(reviewStep),
      reasoningEffort: getTicketReasoningEffort(reviewStep),
      serviceTier: loadConfig().flows.explain.serviceTier,
      sandboxMode: reviewStep.sandboxMode ?? 'read-only',
      approvalPolicy: reviewStep.approvalPolicy ?? 'never',
      networkAccessEnabled: false,
      signal,
      outputSchema: mergeDecisionSchema,
    })

    mergeBlock = normalizeMergeDecisionBlock(ticket, message, analysis, result.parsedOutput as MergeDecisionOutput)
  } catch (error: any) {
    mergeBlock = {
      ...mergeBlock,
      findings: [...mergeBlock.findings, `Codex merge 분석에 실패해 기본 복구 옵션을 제공합니다. (${error.message})`],
      updatedAt: new Date().toISOString(),
    }
  }

  setTicketMergeBlock(ticket.id, mergeBlock)
  setTicketMergeContext(ticket.id, {
    ...ticket.mergeContext,
    analysisKey: analysis.analysisKey,
    currentBaseCommit: analysis.currentBaseCommit,
    headCommit: analysis.currentHeadCommit,
    conflictFiles: [...analysis.conflictFiles],
  })
  appendTimelineEvent(ticket.id, {
    type: 'system',
    title: '자동 merge가 막혀 복구 옵션을 준비했습니다.',
    body: mergeBlock.summary,
  })

  return mergeBlock
}

async function runStructuredAgentStep<T>(
  ticket: Ticket,
  stepConfig: StepConfig,
  prompt: string,
  schema: Record<string, unknown>,
  formatter: (value: T) => string,
  onEvent: RunTicketWorkflowOptions['onEvent'],
  signal?: AbortSignal
): Promise<T> {
  if (!stepConfig.promptFile || !stepConfig.sandboxMode || !stepConfig.approvalPolicy) {
    throw new Error(`Step "${stepConfig.id}" is not configured for agent execution`)
  }

  updateStepStatus(ticket.id, stepConfig.id, 'running')
  await emitStep(onEvent, ticket, stepConfig.id, 'running')

  try {
    const result = await runRestartableTicketTurn<T>({
      ticket,
      stepConfig,
      prompt,
      promptFile: stepConfig.promptFile,
      cwd: getExecutionCwd(ticket),
      additionalDirectories: getTicketSkillDirectories(stepConfig.id),
      threadId: getPlanningThreadId(ticket),
      stepLabel: stepConfig.id === 'analyze' ? '분석' : '계획',
      signal,
      outputSchema: schema,
      onThreadId: (threadId) => {
        setTicketPlanningThreadId(ticket.id, threadId)
      },
      onEvent: async (event) => {
      },
    })

    const formattedOutput = formatter(result.parsedOutput as T)
    replaceStepOutput(ticket.id, stepConfig.id, formattedOutput)
    await emitDelta(onEvent, ticket, stepConfig.id, formattedOutput)
    return result.parsedOutput as T
  } catch (error: any) {
    if (error.name !== 'AbortError') {
      updateStepStatus(ticket.id, stepConfig.id, 'failed')
      await emitStep(onEvent, ticket, stepConfig.id, 'failed')
    }
    throw error
  }
}

async function runAnalyze(
  ticket: Ticket,
  project: ProjectConfig,
  remediationNotes: string | undefined,
  onEvent: RunTicketWorkflowOptions['onEvent'],
  signal?: AbortSignal
) {
  setTicketCurrentPhase(ticket.id, 'analyze')
  appendTimelineEvent(ticket.id, {
    type: 'phase',
    stepId: 'analyze',
    status: 'running',
    title: '분석을 시작했습니다.',
  })

  const stepConfig = getStepConfig('analyze')

  await runStructuredAgentStep<AnalyzeOutput>(
    ticket,
    stepConfig,
    buildAnalyzePrompt(ticket, project, remediationNotes),
    analyzeSchema,
    formatAnalyzeOutput,
    onEvent,
    signal
  )

  updateStepStatus(ticket.id, 'analyze', 'done')
  appendTimelineEvent(ticket.id, {
    type: 'phase',
    stepId: 'analyze',
    status: 'done',
    title: '분석이 완료되었습니다.',
  })
  await emitStep(onEvent, ticket, 'analyze', 'done')
  await emitDone(onEvent, ticket, 'analyze', 'done', ticket.attemptCount)
}

async function runPlan(
  ticket: Ticket,
  project: ProjectConfig,
  remediationNotes: string | undefined,
  onEvent: RunTicketWorkflowOptions['onEvent'],
  signal?: AbortSignal
) {
  setTicketCurrentPhase(ticket.id, 'plan')
  appendTimelineEvent(ticket.id, {
    type: 'phase',
    stepId: 'plan',
    status: 'running',
    title: '구현 계획을 수립하고 있습니다.',
  })

  const stepConfig = getStepConfig('plan')

  const planOutput = await runStructuredAgentStep<PlanOutput>(
    ticket,
    stepConfig,
    buildPlanPrompt(ticket, project, remediationNotes),
    planSchema,
    formatPlanOutput,
    onEvent,
    signal
  )
  setTicketScopedVerification(ticket.id, normalizeScopedVerificationPlan(planOutput.scopedVerification, project))

  updateStepStatus(ticket.id, 'plan', 'done')
  appendTimelineEvent(ticket.id, {
    type: 'phase',
    stepId: 'plan',
    status: 'done',
    title: '구현 계획이 완료되었습니다.',
  })
  await emitStep(onEvent, ticket, 'plan', 'done')
  await emitDone(onEvent, ticket, 'plan', 'done', ticket.attemptCount)
}

async function runStageReview(
  ticket: Ticket,
  subjectStepId: 'analyze' | 'plan',
  label: string,
  prompt: string,
  onEvent: RunTicketWorkflowOptions['onEvent'],
  signal?: AbortSignal
) {
  const reviewKey = `${subjectStepId}_review`
  const reviewStep = getStepConfig('review')
  const attempt = ticket.stageReviews.filter((entry) => entry.subjectStepId === subjectStepId).length + 1

  if (!reviewStep.promptFile || !reviewStep.sandboxMode || !reviewStep.approvalPolicy) {
    throw new Error('Review step is not configured for agent execution')
  }

  setTicketCurrentPhase(ticket.id, reviewKey)
  appendTimelineEvent(ticket.id, {
    type: 'review',
    stepId: reviewKey,
    attempt,
    status: 'running',
    title: `${label} 리뷰를 시작했습니다.`,
  })
  await emitStep(onEvent, ticket, reviewKey, 'running', attempt)

  const startedAt = new Date().toISOString()
  const result = await runCodexTurnImpl<StageReviewOutput>({
    prompt,
    promptFile: 'prompts/ticket-stage-review.txt',
    cwd: getExecutionCwd(ticket),
    additionalDirectories: getTicketSkillDirectories('stage_review'),
    model: getTicketModel(reviewStep),
    reasoningEffort: getTicketReasoningEffort(reviewStep),
    serviceTier: loadConfig().flows.explain.serviceTier,
    sandboxMode: reviewStep.sandboxMode,
    approvalPolicy: reviewStep.approvalPolicy,
    networkAccessEnabled: reviewStep.networkAccessEnabled ?? false,
    signal,
    outputSchema: stageReviewSchema,
  })

  const parsed = result.parsedOutput as StageReviewOutput
  const output = formatStageReviewOutput(label, parsed, attempt)
  const review: StageReview = {
    id: `${reviewKey}-${attempt}`,
    subjectStepId,
    label,
    attempt,
    verdict: parsed.verdict,
    summary: parsed.summary,
    blockingFindings: parsed.blockingFindings,
    residualRisks: parsed.residualRisks,
    output,
    startedAt,
    completedAt: new Date().toISOString(),
  }

  appendStageReview(ticket.id, review)
  appendTimelineEvent(ticket.id, {
    type: 'review',
    stepId: reviewKey,
    attempt,
    status: review.verdict,
    title: `${label} 리뷰가 ${review.verdict === 'pass' ? '통과' : '실패'}했습니다.`,
    body: review.summary,
  })
  await emitDelta(onEvent, ticket, reviewKey, output, attempt)
  await emitStep(onEvent, ticket, reviewKey, review.verdict === 'pass' ? 'done' : 'failed', attempt)
  await emitDone(onEvent, ticket, reviewKey, review.verdict === 'pass' ? 'done' : 'failed', attempt)
  return review
}

async function runAnalyzeUntilReviewed(
  ticket: Ticket,
  project: ProjectConfig,
  initialRecoveryNotes: string | undefined,
  onEvent: RunTicketWorkflowOptions['onEvent'],
  signal?: AbortSignal
) {
  const stepConfig = getStepConfig('analyze')
  const maxAttempts = getConfiguredStepMaxAttempts(stepConfig)
  let remediationNotes = combineRemediationNotes(
    initialRecoveryNotes,
    latestStageReviewFailure(ticket, 'analyze')
      ? buildStageReviewFeedback('분석', latestStageReviewFailure(ticket, 'analyze') as StageReview)
      : undefined
  )

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    await runAnalyze(getTicketOrThrow(ticket.id), project, remediationNotes, onEvent, signal)
    const analyzeReview = await runStageReview(
      getTicketOrThrow(ticket.id),
      'analyze',
      '분석',
      buildAnalyzeReviewPrompt(getTicketOrThrow(ticket.id), project),
      onEvent,
      signal
    )

    if (analyzeReview.verdict === 'pass') {
      return true
    }

    remediationNotes = buildStageReviewFeedback('분석', analyzeReview)
    if (attempt >= maxAttempts) {
      setTicketRunState(ticket.id, 'failed')
      appendTimelineEvent(ticket.id, {
        type: 'system',
        title: '최대 분석 시도 횟수 내에 분석 리뷰를 통과하지 못했습니다.',
        body: remediationNotes,
      })
      if (
        (await attemptTicketSelfHeal(
          ticket.id,
          {
            kind: 'analyze_failed',
            message: remediationNotes ?? '최종 분석 리뷰 실패',
            phase: 'analyze',
            attempt,
          },
          onEvent,
          signal
        )) === 'started'
      ) {
        return false
      }
      captureIncidentSafely(ticket.id, {
        kind: 'analyze_failed',
        message: remediationNotes ?? '최종 분석 리뷰 실패',
        phase: 'analyze',
        attempt,
      })
      return false
    }

    appendTimelineEvent(ticket.id, {
      type: 'system',
      title: '분석 리뷰 피드백을 반영해 분석을 다시 시도합니다.',
      body: remediationNotes,
    })
  }

  return false
}

async function runPlanUntilReviewed(
  ticket: Ticket,
  project: ProjectConfig,
  initialRecoveryNotes: string | undefined,
  onEvent: RunTicketWorkflowOptions['onEvent'],
  signal?: AbortSignal
) {
  const stepConfig = getStepConfig('plan')
  const maxAttempts = getConfiguredStepMaxAttempts(stepConfig)
  let remediationNotes = combineRemediationNotes(
    initialRecoveryNotes,
    latestStageReviewFailure(ticket, 'plan')
      ? buildStageReviewFeedback('계획', latestStageReviewFailure(ticket, 'plan') as StageReview)
      : undefined
  )

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    setTicketPlanningBlock(ticket.id, undefined)
    await runPlan(getTicketOrThrow(ticket.id), project, remediationNotes, onEvent, signal)
    const planReview = await runStageReview(
      getTicketOrThrow(ticket.id),
      'plan',
      '계획',
      buildPlanReviewPrompt(getTicketOrThrow(ticket.id), project),
      onEvent,
      signal
    )

    if (planReview.verdict === 'pass') {
      setTicketPlanningBlock(ticket.id, undefined)
      return true
    }

    remediationNotes = buildStageReviewFeedback('계획', planReview)
    const coordination = await coordinatePlanReviewFailure(
      getTicketOrThrow(ticket.id),
      project,
      planReview,
      remediationNotes,
      attempt,
      maxAttempts,
      signal
    )
    remediationNotes = coordination.remediationNotes

    if (!coordination.shouldRetry) {
      const planningBlock = coordination.planningBlock ?? classifyPlanReviewBlock(planReview)
      setTicketPlanningBlock(ticket.id, planningBlock)
      setTicketRunState(ticket.id, planningBlock.kind)
      appendTimelineEvent(ticket.id, {
        type: 'system',
        title:
          attempt >= maxAttempts
            ? '최대 계획 시도 횟수 내에 계획 리뷰를 통과하지 못했습니다.'
            : '계획 리뷰 결과에 따라 자동 재시도를 중단하고 다음 판단을 대기합니다.',
        body: remediationNotes,
      })
      return false
    }

    setTicketPlanningBlock(ticket.id, undefined)
    appendTimelineEvent(ticket.id, {
      type: 'system',
      title: '계획 리뷰 피드백을 반영해 계획을 다시 시도합니다.',
      body: remediationNotes,
    })
  }

  return false
}

function buildVerificationCommandPlan(ticket: Ticket, project: ProjectConfig) {
  const scopedVerification = getScopedVerificationPlan(ticket, project)
  const scopedCommands = (scopedVerification?.commands ?? []).map((command, index) => ({
    id: `scoped-${index + 1}`,
    label: command.label,
    command: command.command,
    stage: 'scoped' as const,
    timeoutMs: command.timeoutMs ?? project.verificationCommands[0]?.timeoutMs ?? 120_000,
    required: true,
  }))

  const projectCommands = project.verificationCommands.map((command) => ({
    ...command,
    stage: 'project' as const,
  }))

  return {
    scopedVerification,
    commands: [...scopedCommands, ...projectCommands],
  }
}

async function runVerification(
  ticket: Ticket,
  project: ProjectConfig,
  attempt: number,
  onEvent: RunTicketWorkflowOptions['onEvent'],
  signal?: AbortSignal
): Promise<VerificationRun> {
  ensureAbortSignal(signal)
  if (ticket.repairLoop) {
    updateTicketRepairLoop(ticket.id, { status: 'waiting_verify' })
  }
  setTicketCurrentPhase(ticket.id, 'verify')
  updateStepStatus(ticket.id, 'verify', 'running')
  appendTimelineEvent(ticket.id, {
    type: 'phase',
    stepId: 'verify',
    attempt,
    status: 'running',
    title: `자동 검증 ${attempt}회를 시작했습니다.`,
  })
  await emitStep(onEvent, ticket, 'verify', 'running', attempt)

  const startedAt = new Date().toISOString()
  const commands: VerificationCommandResult[] = []
  const verificationPlan = buildVerificationCommandPlan(ticket, project)

  try {
    for (let index = 0; index < verificationPlan.commands.length; index += 1) {
      const commandConfig = verificationPlan.commands[index]
      ensureAbortSignal(signal)

      const startedAtRun = new Date().toISOString()
      const executionCwd = getExecutionCwd(ticket)
      const preflightFailure = preflightVerificationCommand(commandConfig.command, executionCwd)
      const result = preflightFailure
        ? {
            exitCode: 1,
            output: preflightFailure.output,
            durationMs: 0,
            timedOut: false,
          }
        : await runCommand(
            commandConfig.command,
            executionCwd,
            commandConfig.timeoutMs ?? 120_000,
            signal
          )

      const passed = !result.timedOut && result.exitCode === 0
      commands.push({
        id: commandConfig.id,
        label: commandConfig.label,
        command: commandConfig.command,
        stage: commandConfig.stage,
        required: commandConfig.required ?? true,
        status: passed ? 'passed' : 'failed',
        output: result.output,
        exitCode: result.exitCode ?? undefined,
        durationMs: result.durationMs,
        startedAt: startedAtRun,
        completedAt: new Date().toISOString(),
      })

      if ((commandConfig.required ?? true) && !passed) {
        const skippedAt = new Date().toISOString()
        for (const skippedCommand of verificationPlan.commands.slice(index + 1)) {
          commands.push({
            id: skippedCommand.id,
            label: skippedCommand.label,
            command: skippedCommand.command,
            stage: skippedCommand.stage,
            required: skippedCommand.required ?? true,
            status: 'skipped',
            output: '앞선 필수 검증이 실패해 실행하지 않았습니다.',
            startedAt: skippedAt,
            completedAt: skippedAt,
          })
        }
        break
      }
    }

    const runStatus = commands.some((command) => command.required && command.status === 'failed')
      ? 'failed'
      : 'passed'
    const completedAt = new Date().toISOString()

    const baseVerificationRun: VerificationRun = {
      attempt,
      status: runStatus,
      commands,
      startedAt,
      completedAt,
    }
    const preliminaryDiagnosis =
      runStatus === 'failed' ? diagnoseVerificationRun(baseVerificationRun, getExecutionCwd(ticket)) : undefined
    const diagnosis =
      preliminaryDiagnosis && preliminaryDiagnosis.kind !== 'environment'
        ? await maybeDiagnoseVerificationWithSkill(ticket, project, baseVerificationRun, preliminaryDiagnosis, signal)
        : preliminaryDiagnosis

    const verificationRun: VerificationRun = {
      ...baseVerificationRun,
      diagnosis,
    }

    appendVerificationRun(ticket.id, verificationRun)
    const formattedOutput = formatVerificationRun(verificationRun)
    appendStepOutput(ticket.id, 'verify', formattedOutput)
    await emitDelta(onEvent, ticket, 'verify', formattedOutput, attempt)

    updateStepStatus(ticket.id, 'verify', runStatus === 'passed' ? 'done' : 'failed')
    appendTimelineEvent(ticket.id, {
      type: 'phase',
      stepId: 'verify',
      attempt,
      status: runStatus,
      title: `자동 검증 ${attempt}회가 ${runStatus === 'passed' ? '통과' : '실패'}했습니다.`,
    })
    await emitStep(onEvent, ticket, 'verify', runStatus === 'passed' ? 'done' : 'failed', attempt)

    return verificationRun
  } catch (error: any) {
    if (error.name !== 'AbortError') {
      updateStepStatus(ticket.id, 'verify', 'failed')
      appendTimelineEvent(ticket.id, {
        type: 'phase',
        stepId: 'verify',
        attempt,
        status: 'failed',
        title: `자동 검증 ${attempt}회가 오류로 실패했습니다.`,
      })
      await emitStep(onEvent, ticket, 'verify', 'failed', attempt)
    }
    throw error
  }
}

async function runReview(
  ticket: Ticket,
  stepConfig: StepConfig,
  attempt: number,
  verificationRun: VerificationRun,
  onEvent: RunTicketWorkflowOptions['onEvent'],
  signal?: AbortSignal
): Promise<ReviewRun> {
  if (!stepConfig.promptFile || !stepConfig.sandboxMode || !stepConfig.approvalPolicy) {
    throw new Error('Review step is not configured for agent execution')
  }

  if (ticket.repairLoop) {
    updateTicketRepairLoop(ticket.id, { status: 'waiting_review' })
  }
  setTicketCurrentPhase(ticket.id, 'review')
  updateStepStatus(ticket.id, 'review', 'running')
  appendTimelineEvent(ticket.id, {
    type: 'review',
    stepId: 'review',
    attempt,
    status: 'running',
    title: `코드 리뷰 ${attempt}회를 시작했습니다.`,
  })
  await emitStep(onEvent, ticket, 'review', 'running', attempt)

  const gitSummary = await collectGitSummary(getExecutionCwd(ticket), signal)
  const acceptanceCriteria = extractAcceptanceCriteriaFromPlanOutput(ticket.steps.plan?.output || '')
  const hasLinkedRequest = Boolean(ticket.linkedRequestId && getClientRequest(ticket.linkedRequestId))
  const reviewPrompt = buildReviewPrompt(ticket, includesStep(ticket, 'verify') ? verificationRun : undefined, gitSummary)

  const startedAt = new Date().toISOString()
  try {
    const result = await runCodexTurnImpl<ReviewOutput>({
      prompt: reviewPrompt,
      promptFile: stepConfig.promptFile,
      cwd: getExecutionCwd(ticket),
      additionalDirectories: getTicketSkillDirectories(stepConfig.id),
      model: getTicketModel(stepConfig),
      reasoningEffort: getTicketReasoningEffort(stepConfig),
      serviceTier: loadConfig().flows.explain.serviceTier,
      sandboxMode: stepConfig.sandboxMode,
      approvalPolicy: stepConfig.approvalPolicy,
      networkAccessEnabled: stepConfig.networkAccessEnabled ?? false,
      signal,
      outputSchema: reviewSchema,
    })

    const parsed = normalizeReviewOutput(result.parsedOutput as ReviewOutput, {
      expectedAcceptanceCriteria: acceptanceCriteria,
      hasLinkedRequest,
    })
    const output = formatReviewOutput(parsed, attempt)
    const reviewRun: ReviewRun = {
      attempt,
      verdict: parsed.verdict,
      summary: parsed.summary,
      goalAssessment: parsed.goalAssessment,
      blockingFindings: parsed.blockingFindings,
      residualRisks: parsed.residualRisks,
      releaseNotes: parsed.releaseNotes,
      output,
      startedAt,
      completedAt: new Date().toISOString(),
    }

    appendReviewRun(ticket.id, reviewRun)
    appendStageReview(ticket.id, {
      id: `review-${attempt}`,
      subjectStepId: 'implement',
      label: '코드 리뷰',
      attempt,
      verdict: reviewRun.verdict,
      summary: reviewRun.summary,
      blockingFindings: reviewRun.blockingFindings,
      residualRisks: reviewRun.residualRisks,
      output,
      startedAt,
      completedAt: reviewRun.completedAt,
    })
    replaceStepOutput(ticket.id, 'review', output)
    await emitDelta(onEvent, ticket, 'review', output, attempt)

    updateStepStatus(ticket.id, 'review', reviewRun.verdict === 'pass' ? 'done' : 'failed')
    appendTimelineEvent(ticket.id, {
      type: 'review',
      stepId: 'review',
      attempt,
      status: reviewRun.verdict,
      title: `코드 리뷰 ${attempt}회가 ${reviewRun.verdict === 'pass' ? '통과' : '실패'}했습니다.`,
      body: reviewRun.summary,
    })
    await emitStep(onEvent, ticket, 'review', reviewRun.verdict === 'pass' ? 'done' : 'failed', attempt)

    return reviewRun
  } catch (error: any) {
    if (error.name !== 'AbortError') {
      updateStepStatus(ticket.id, 'review', 'failed')
      appendTimelineEvent(ticket.id, {
        type: 'review',
        stepId: 'review',
        attempt,
        status: 'failed',
        title: `코드 리뷰 ${attempt}회가 오류로 실패했습니다.`,
      })
      await emitStep(onEvent, ticket, 'review', 'failed', attempt)
    }
    throw error
  }
}

async function finalizeTicketReadyState(
  ticketId: string,
  reviewRun: ReviewRun,
  verificationRun: VerificationRun | undefined,
  attempt: number,
  onEvent: RunTicketWorkflowOptions['onEvent'],
  signal?: AbortSignal
) {
  clearRepairLoopForTicket(ticketId)
  const readyTicket = getTicketOrThrow(ticketId)
  const summary = await ensureMergeableWorktreeCommit(readyTicket, signal)
  const report = deriveFinalReport(getTicketOrThrow(ticketId), reviewRun, verificationRun, summary.diffSummary)
  setFinalReport(ticketId, report)
  setTicketMergeBlock(ticketId, undefined)
  await cleanupSupersededWorktree(ticketId, signal)

  const latestTicket = getTicketOrThrow(ticketId)
  const readyOutput = [
    '## 머지 준비',
    '',
    '상세 구현 및 검증 결과는 `Final Report` 패널에서 확인하세요.',
    '',
    '### 머지 검토 정보',
    `- 브랜치: \`${latestTicket.worktree?.branchName}\``,
    `- 기준 브랜치: \`${latestTicket.worktree?.baseBranch}\``,
    `- 기준 커밋: \`${latestTicket.worktree?.baseCommit}\``,
    `- 작업 커밋: \`${summary.headCommit}\``,
    '',
    summary.diffSummary,
    '',
    '최종 검토가 끝났습니다. Merge 또는 Discard를 선택해 주세요.',
  ].join('\n')

  setTicketCurrentPhase(ticketId, 'ready')
  replaceStepOutput(ticketId, 'ready', readyOutput)
  updateStepStatus(ticketId, 'ready', 'done')
  setTicketStatus(ticketId, 'awaiting_merge')
  appendTimelineEvent(ticketId, {
    type: 'report',
    stepId: 'ready',
    attempt,
    status: 'done',
    title: '최종 보고가 생성되었고 머지 대기 상태가 되었습니다.',
    body: report.summary,
  })

  const finalTicket = getTicketOrThrow(ticketId)
  await emitStep(onEvent, finalTicket, 'ready', 'done', attempt)
  await emitDelta(onEvent, finalTicket, 'ready', readyOutput, attempt)
  await emitDone(onEvent, finalTicket, 'ready', 'done', attempt)
}

async function runValidationAndReady(
  ticket: Ticket,
  startStepId: 'verify' | 'review',
  onEvent: RunTicketWorkflowOptions['onEvent'],
  signal?: AbortSignal
) {
  const project = getProjectConfig(ticket)
  const reviewStep = getStepConfig('review')
  const attempt = ticket.attemptCount + 1
  setTicketAttemptCount(ticket.id, attempt)

  let verificationRun: VerificationRun | undefined

  if (startStepId === 'verify' && includesStep(ticket, 'verify')) {
    verificationRun = await runVerification(getTicketOrThrow(ticket.id), project, attempt, onEvent, signal)

    if (verificationRun.status === 'failed') {
      let remediationNotes = buildVerificationFeedback(verificationRun)
      const verificationFailure = classifyVerificationFailure(verificationRun)

      if (verificationFailure.kind === 'verification_environment_failed') {
        clearRepairLoopForTicket(ticket.id)
        setTicketRunState(ticket.id, 'failed')
        appendTimelineEvent(ticket.id, {
          type: 'system',
          title: 'merge 재검증 중 검증 환경 문제가 발생해 실행을 중단했습니다.',
          body: remediationNotes,
        })
        captureIncidentSafely(ticket.id, {
          kind: verificationFailure.kind,
          message: remediationNotes,
          phase: 'verify',
          attempt,
        })
        await emitDone(onEvent, getTicketOrThrow(ticket.id), 'verify', 'failed', attempt)
        return false
      }

      if (verificationRun.diagnosis?.kind === 'external_blocker') {
        clearRepairLoopForTicket(ticket.id)
        await blockTicketOnExternalVerificationFailure(getTicketOrThrow(ticket.id), verificationRun, remediationNotes, attempt, onEvent)
        return false
      }

      const coordinated = await coordinateVerifyRecoveryDecision(
        getTicketOrThrow(ticket.id),
        project,
        verificationRun,
        remediationNotes,
        signal
      )
      remediationNotes = coordinated.remediationNotes

      if (coordinated.recovery.kind === 'same_run_implement') {
        const repairLoop = beginTicketRepairLoop(ticket.id, 'verify', remediationNotes)
        appendTimelineEvent(ticket.id, {
          type: 'system',
          title: `merge 재검증 실패를 같은 run에서 수선합니다. (${repairLoop.cycle}회차)`,
          body: remediationNotes,
        })
        await runImplementLoop(getTicketOrThrow(ticket.id), remediationNotes, onEvent, signal)
        return false
      }

      if (coordinated.recovery.kind === 'new_run_plan' || coordinated.recovery.kind === 'new_run_implement') {
        const preferredStartStep = coordinated.recovery.kind === 'new_run_plan' ? 'plan' : 'implement'
        appendTimelineEvent(ticket.id, {
          type: 'system',
          title:
            preferredStartStep === 'plan'
              ? 'merge 재검증 실패를 바탕으로 계획 단계부터 새 run을 다시 시작합니다.'
              : 'merge 재검증 실패를 바탕으로 구현 단계부터 새 run을 다시 시작합니다.',
          body: remediationNotes,
        })

        const selfHealOutcome = await attemptTicketSelfHeal(
          ticket.id,
          {
            kind: 'verify_failed',
            message: remediationNotes,
            phase: 'verify',
            attempt,
            preferredStartStep,
          },
          onEvent,
          signal
        )
        if (selfHealOutcome === 'started') {
          return false
        }

        if (selfHealOutcome === 'run_limit' || selfHealOutcome === 'disabled') {
          clearRepairLoopForTicket(ticket.id)
          setTicketPlanningBlock(
            ticket.id,
            buildSelfHealUnavailablePlanningBlock(
              getTicketOrThrow(ticket.id),
              'verify',
              'merge 재검증 실패 후 더 이상 안전한 자동 복구를 진행할 수 없습니다.',
              buildVerificationRecoveryFindings(verificationRun)
            )
          )
          setTicketRunState(ticket.id, 'needs_decision')
          appendTimelineEvent(ticket.id, {
            type: 'system',
            title: 'merge 재검증 실패 후 사람 판단이 필요한 상태로 전환했습니다.',
            body: remediationNotes,
          })
          await emitDone(onEvent, getTicketOrThrow(ticket.id), 'verify', 'failed', attempt)
          return false
        }
        setTicketRunState(ticket.id, 'failed')
        appendTimelineEvent(ticket.id, {
          type: 'system',
          title:
            preferredStartStep === 'plan'
              ? 'merge 재검증 실패 후 계획 단계 자동 복구를 더 진행할 수 없어 incident를 기록합니다.'
              : 'merge 재검증 실패 후 구현 단계 자동 복구를 더 진행할 수 없어 incident를 기록합니다.',
          body: remediationNotes,
        })
        captureIncidentSafely(ticket.id, {
          kind: 'verify_failed',
          message: remediationNotes,
          phase: 'verify',
          attempt,
        })
        await emitDone(onEvent, getTicketOrThrow(ticket.id), 'verify', 'failed', attempt)
        return false
      }

      clearRepairLoopForTicket(ticket.id)
      setTicketPlanningBlock(ticket.id, coordinated.recovery.planningBlock)
      setTicketRunState(ticket.id, coordinated.recovery.kind)
      appendTimelineEvent(ticket.id, {
        type: 'system',
        title:
          coordinated.recovery.kind === 'needs_decision'
            ? 'merge 재검증 실패를 어떻게 반영할지 사람의 선택이 필요합니다.'
            : 'merge 재검증 실패를 해결하려면 요구사항 보완이 먼저 필요합니다.',
        body: remediationNotes,
      })
      await emitDone(onEvent, getTicketOrThrow(ticket.id), 'verify', 'failed', attempt)
      return false
    }
  }

  const reviewRun = await runReview(
    getTicketOrThrow(ticket.id),
    reviewStep,
    attempt,
    verificationRun ?? {
      attempt,
      status: 'passed',
      commands: [],
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    },
    onEvent,
    signal
  )

  if (reviewRun.verdict === 'fail') {
    let remediationNotes = buildReviewFeedback(reviewRun)
    const coordinated = await coordinateReviewRecoveryDecision(
      getTicketOrThrow(ticket.id),
      project,
      reviewRun,
      remediationNotes,
      signal
    )
    remediationNotes = coordinated.remediationNotes
    const recovery = coordinated.recovery

    if (recovery.kind === 'same_run_implement') {
      const repairLoop = beginTicketRepairLoop(ticket.id, 'review', remediationNotes)
      appendTimelineEvent(ticket.id, {
        type: 'system',
        title: `merge 재검증 리뷰 실패를 같은 run에서 수선합니다. (${repairLoop.cycle}회차)`,
        body: remediationNotes,
      })
      await runImplementLoop(getTicketOrThrow(ticket.id), remediationNotes, onEvent, signal)
      return false
    }

    if (recovery.kind === 'new_run_plan' || recovery.kind === 'new_run_implement') {
      const preferredStartStep = recovery.kind === 'new_run_plan' ? 'plan' : 'implement'
      appendTimelineEvent(ticket.id, {
        type: 'system',
        title:
          preferredStartStep === 'plan'
            ? 'merge 재검증 결과를 바탕으로 계획 단계부터 새 run을 다시 시작합니다.'
            : 'merge 재검증 결과를 바탕으로 구현 단계부터 새 run을 다시 시작합니다.',
        body: remediationNotes,
      })

      if (
        (await attemptTicketSelfHeal(
          ticket.id,
          {
            kind: 'review_failed',
            message: remediationNotes,
            phase: 'review',
            attempt,
            preferredStartStep,
          },
          onEvent,
          signal
        )) === 'started'
      ) {
        return false
      }

      setTicketRunState(ticket.id, 'failed')
      appendTimelineEvent(ticket.id, {
        type: 'system',
        title:
          preferredStartStep === 'plan'
            ? 'merge 재검증 결과 후 계획 단계 자동 복구를 더 진행할 수 없어 incident를 기록합니다.'
            : 'merge 재검증 결과 후 구현 단계 자동 복구를 더 진행할 수 없어 incident를 기록합니다.',
        body: remediationNotes,
      })
      captureIncidentSafely(ticket.id, {
        kind: 'review_failed',
        message: remediationNotes,
        phase: 'review',
        attempt,
      })
      await emitDone(onEvent, getTicketOrThrow(ticket.id), 'review', 'failed', attempt)
      return false
    }

    if (recovery.kind === 'needs_decision' || recovery.kind === 'needs_request_clarification') {
      clearRepairLoopForTicket(ticket.id)
      setTicketPlanningBlock(ticket.id, recovery.planningBlock)
      setTicketRunState(ticket.id, recovery.kind)
      appendTimelineEvent(ticket.id, {
        type: 'system',
        title:
          recovery.kind === 'needs_decision'
            ? 'merge 재검증 결과를 반영하는 방법을 선택해야 합니다.'
            : 'merge 재검증 결과를 해결하려면 요구사항 보완이 먼저 필요합니다.',
        body: remediationNotes,
      })
      await emitDone(onEvent, getTicketOrThrow(ticket.id), 'review', 'failed', attempt)
      return false
    }

    clearRepairLoopForTicket(ticket.id)
    setTicketRunState(ticket.id, 'failed')
    appendTimelineEvent(ticket.id, {
      type: 'system',
      title: 'merge 재검증 중 코드 리뷰를 통과하지 못했습니다.',
      body: remediationNotes,
    })
    captureIncidentSafely(ticket.id, {
      kind: 'review_failed',
      message: remediationNotes,
      phase: 'review',
      attempt,
    })
    await emitDone(onEvent, getTicketOrThrow(ticket.id), 'review', 'failed', attempt)
    return false
  }

  await finalizeTicketReadyState(ticket.id, reviewRun, verificationRun, attempt, onEvent, signal)
  return true
}

function buildVerificationFeedback(run: VerificationRun): string {
  const failedCommands = run.commands.filter((command) => command.status === 'failed')
  const classification = classifyVerificationFailure(run)
  const diagnosis = run.diagnosis
  if (failedCommands.length === 0) {
    return '검증 단계에서 원인을 특정하지 못했지만 재검토가 필요하다.'
  }

  const header =
    classification.kind === 'verification_environment_failed'
      ? `검증 시도 ${run.attempt}에서 검증 환경 문제로 분류한 실패 항목:`
      : `검증 시도 ${run.attempt}에서 실패한 항목:`

  const diagnosisCommandById = new Map(diagnosis?.failingCommands.map((command) => [command.id, command]))

  return [
    header,
    ...(diagnosis ? ['', '진단 세부:', formatVerificationDiagnosisDetails(diagnosis, { includeRecovery: true })] : []),
    ...(classification.kind === 'verification_environment_failed'
      ? ['', '분류 근거:', ...classification.signals.map((signal) => `- ${signal}`), '', classification.rationale]
      : []),
    ...failedCommands.map((command) => {
      const excerpt = command.output.trim().split('\n').slice(-20).join('\n')
      const diagnosisCommand = diagnosisCommandById.get(command.id)
      return [
        `- ${command.label} [${command.stage === 'scoped' ? 'scoped' : 'project'}] (\`${command.command}\`)`,
        diagnosisCommand?.logPath ? `로그: ${diagnosisCommand.logPath}` : undefined,
        '```text',
        excerpt || '(no output)',
        '```',
      ]
        .filter(Boolean)
        .join('\n')
    }),
  ].join('\n\n')
}

function getBlockerCategory() {
  return loadConfig().flows.ticket.categories.find((category) => category.id === 'bugfix')
}

function buildExternalVerifyBlockerTitle(ticket: Ticket) {
  return `전체 검증 blocker: ${ticket.title}`
}

function buildExternalVerifyBlockerDescription(ticket: Ticket, verificationRun: VerificationRun, remediationNotes: string) {
  const diagnosis = verificationRun.diagnosis
  const failingTests = diagnosis?.failingTests.slice(0, 10) ?? []

  return [
    '## Problem',
    `원본 ticket \`${ticket.id}\`는 범위 검증을 통과했지만 프로젝트 전체 검증에서 범위 밖 회귀에 막혔습니다.`,
    '',
    '## Desired Outcome',
    `프로젝트 전체 검증 회귀를 해결해 원본 ticket \`${ticket.id}\`가 verify 단계부터 자동 재개될 수 있어야 합니다.`,
    '',
    '## Constraints',
    '- 원본 ticket 기능 범위를 넓히지 않고 전체 검증 회귀만 해결합니다.',
    `- 해결 후 원본 ticket \`${ticket.id}\`는 verify부터 다시 실행됩니다.`,
    '',
    '## Verification Evidence',
    remediationNotes,
    '',
    '## Failing Tests',
    ...(failingTests.length > 0
      ? failingTests.map((test) => `- ${test.suite} :: ${test.name} / ${normalizeDiagnosticText(test.message).slice(0, 180)}`)
      : ['- 저장된 테스트 세부는 부족하지만 전체 project verify가 실패했습니다.']),
  ].join('\n')
}

function ensureExternalVerifyBlockerTicket(ticket: Ticket, verificationRun: VerificationRun, remediationNotes: string) {
  const existingBlocker = ticket.blockedByTicketId ? getTicket(ticket.blockedByTicketId) : undefined
  if (existingBlocker && existingBlocker.status !== 'completed' && existingBlocker.status !== 'discarded') {
    return existingBlocker
  }

  const category = getBlockerCategory()
  if (!category) {
    throw new Error('Bugfix category is required to create an external verify blocker ticket')
  }

  const blockerTicket = createTicket({
    title: buildExternalVerifyBlockerTitle(ticket),
    description: buildExternalVerifyBlockerDescription(ticket, verificationRun, remediationNotes),
    projectId: ticket.projectId,
    projectPath: ticket.projectPath,
    categoryId: category.id,
    flowStepIds: [...category.steps],
    linkedRequestId: ticket.linkedRequestId,
    originTicketId: ticket.id,
  })

  enqueueTicketExecution(
    blockerTicket.id,
    'analyze',
    `원본 ticket ${ticket.id}의 프로젝트 전체 검증 회귀를 해결한 뒤 verify 재개가 가능하도록 정리합니다.`
  )
  return blockerTicket
}

async function blockTicketOnExternalVerificationFailure(
  ticket: Ticket,
  verificationRun: VerificationRun,
  remediationNotes: string,
  attempt: number,
  onEvent: RunTicketWorkflowOptions['onEvent']
) {
  const blockerTicket = ensureExternalVerifyBlockerTicket(ticket, verificationRun, remediationNotes)
  setTicketBlockerLink(ticket.id, blockerTicket.id, 'external_verify_blocker')
  setTicketRunState(ticket.id, 'blocked')
  appendTimelineEvent(ticket.id, {
    type: 'system',
    title: `프로젝트 전체 검증 회귀를 별도 blocker ticket ${blockerTicket.id}로 분리했습니다.`,
    body: `원본 ticket은 blocked 상태로 유지하고, 범위 밖 회귀는 ${blockerTicket.id}에서 해결합니다.`,
  })
  await emitDone(onEvent, getTicketOrThrow(ticket.id), 'verify', 'failed', attempt)
}

export function classifyVerificationFailure(run: VerificationRun): VerificationFailureClassification {
  const signals = new Set<string>()

  for (const command of run.commands) {
    if (command.status !== 'failed') {
      continue
    }

    for (const entry of VERIFICATION_ENVIRONMENT_PATTERNS) {
      if (entry.pattern.test(command.output)) {
        signals.add(entry.signal)
      }
    }
  }

  if (signals.size > 0) {
    return {
      kind: 'verification_environment_failed',
      rationale: '코드 수정 재시도보다 의존성 또는 검증 런타임 정비가 먼저 필요한 실패로 판단했습니다.',
      signals: [...signals],
    }
  }

  return {
    kind: 'verify_failed',
    rationale: '검증 실패를 코드 또는 테스트 회귀로 간주합니다.',
    signals: [],
  }
}

function buildReviewFeedback(review: ReviewRun): string {
  if (review.blockingFindings.length === 0) {
    return `${review.summary}\n\n잔여 리스크:\n${review.residualRisks.join('\n')}`
  }

  return [
    `리뷰 시도 ${review.attempt}에서 나온 블로킹 이슈:`,
    ...review.blockingFindings.map((finding) => `- ${finding}`),
    '',
    '잔여 리스크:',
    ...review.residualRisks.map((risk) => `- ${risk}`),
  ].join('\n')
}

interface TicketSelfHealTrigger {
  kind: 'analyze_failed' | 'verify_failed' | 'review_failed'
  message: string
  attempt: number
  phase: 'analyze' | 'verify' | 'review'
  preferredStartStep?: 'analyze' | 'plan' | 'implement'
}

type TicketSelfHealOutcome = 'started' | 'run_limit' | 'disabled' | 'failed'

interface ReviewRecoveryDecision {
  kind: 'same_run_implement' | 'new_run_implement' | 'new_run_plan' | 'needs_decision' | 'needs_request_clarification'
  rationale: string
  planningBlock?: TicketPlanningBlock
}

function beginTicketRepairLoop(
  ticketId: string,
  gate: TicketRepairLoop['gate'],
  failureSummary: string
): TicketRepairLoop {
  const ticket = getTicketOrThrow(ticketId)
  const repairLoop: TicketRepairLoop = {
    gate,
    cycle: (ticket.repairLoop?.cycle ?? 0) + 1,
    status: 'repairing',
    failureSummary,
    startedAt: new Date().toISOString(),
  }
  setTicketRepairLoop(ticketId, repairLoop)
  return repairLoop
}

function clearRepairLoopForTicket(ticketId: string) {
  clearTicketRepairLoop(ticketId)
}

async function maybeCoordinateTicketFailure(opts: {
  trigger: 'plan_review_failed' | 'verify_failed' | 'review_failed'
  ticket: Ticket
  project: ProjectConfig
  failureSummary: string
  evidence: string[]
  canRetryImplementInSameRun?: boolean
  signal?: AbortSignal
}) {
  try {
    return await coordinateTicketFailure({
      ...opts,
      canRetryImplementInSameRun: opts.canRetryImplementInSameRun ?? canRetryReviewInSameRun(opts.ticket),
      threadId: getCoordinatorThreadId(opts.ticket),
      onThreadId: (threadId) => {
        setTicketCoordinatorThreadId(opts.ticket.id, threadId)
      },
      onRecoveryState: (reason) => {
        appendTicketSessionRecoveryEvent(opts.ticket.id, '조율', reason)
      },
      runCodexTurnImpl,
    })
  } catch (error) {
    console.warn(`Ticket coordinator failed for ${opts.ticket.id}:`, error)
    return null
  }
}

async function coordinatePlanReviewFailure(
  ticket: Ticket,
  project: ProjectConfig,
  review: StageReview,
  remediationNotes: string,
  attempt: number,
  maxAttempts: number,
  signal?: AbortSignal
) {
  const decision = await maybeCoordinateTicketFailure({
    trigger: 'plan_review_failed',
    ticket,
    project,
    failureSummary: remediationNotes,
    evidence: [review.output],
    signal,
  })

  if (!decision) {
    return {
      shouldRetry: attempt < maxAttempts,
      remediationNotes,
      planningBlock: attempt >= maxAttempts ? classifyPlanReviewBlock(review) : undefined,
    }
  }

  if (decision.kind === 'retry_plan' && attempt < maxAttempts) {
    return {
      shouldRetry: true,
      remediationNotes: decision.remediationNotes,
      planningBlock: undefined,
    }
  }

  return {
    shouldRetry: false,
    remediationNotes: decision.remediationNotes,
    planningBlock:
      decision.kind === 'needs_decision' || decision.kind === 'needs_request_clarification'
        ? buildCoordinatorPlanningBlock(
            ticket,
            'plan_review',
            decision,
            review.summary,
            [...review.blockingFindings, ...review.residualRisks]
          )
        : classifyPlanReviewBlock(review),
  }
}

async function coordinateReviewRecoveryDecision(
  ticket: Ticket,
  project: ProjectConfig,
  review: ReviewRun,
  remediationNotes: string,
  signal?: AbortSignal
): Promise<{ remediationNotes: string; recovery: ReviewRecoveryDecision }> {
  const fallback = classifyReviewRecovery(ticket, review)
  const decision = await maybeCoordinateTicketFailure({
    trigger: 'review_failed',
    ticket,
    project,
    failureSummary: remediationNotes,
    evidence: [review.output],
    signal,
  })

  if (!decision) {
    return {
      remediationNotes,
      recovery: fallback,
    }
  }

  if (decision.kind === 'restart_plan') {
    return {
      remediationNotes: decision.remediationNotes,
      recovery: {
        kind: 'new_run_plan',
        rationale: decision.rationale,
      },
    }
  }

  if (decision.kind === 'restart_implement') {
    if (fallback.kind === 'new_run_plan') {
      return {
        remediationNotes: decision.remediationNotes,
        recovery: {
          kind: 'new_run_plan',
          rationale: fallback.rationale,
        },
      }
    }

    return {
      remediationNotes: decision.remediationNotes,
      recovery: {
        kind: canRetryReviewInSameRun(ticket) ? 'same_run_implement' : 'new_run_implement',
        rationale: decision.rationale,
      },
    }
  }

  if (decision.kind === 'needs_decision' || decision.kind === 'needs_request_clarification') {
    return {
      remediationNotes: decision.remediationNotes,
      recovery: {
        kind: decision.kind,
        rationale: decision.rationale,
        planningBlock: buildCoordinatorPlanningBlock(
          ticket,
          'review',
          decision,
          review.summary,
          [...review.blockingFindings, ...review.residualRisks]
        ),
      },
    }
  }

  return {
    remediationNotes: decision.remediationNotes,
    recovery: {
      kind: canRetryReviewInSameRun(ticket) ? 'same_run_implement' : 'new_run_implement',
      rationale: decision.rationale,
    },
  }
}

async function coordinateVerifyRecoveryDecision(
  ticket: Ticket,
  project: ProjectConfig,
  verificationRun: VerificationRun,
  remediationNotes: string,
  signal?: AbortSignal
): Promise<{ remediationNotes: string; recovery: ReviewRecoveryDecision }> {
  const diagnosis = verificationRun.diagnosis

  if (diagnosis?.kind === 'external_blocker') {
    return {
      remediationNotes,
      recovery: {
        kind: 'needs_decision',
        rationale: '범위 검증은 통과했지만 프로젝트 전체 회귀가 발생해 별도 blocker 처리 또는 사람 판단이 필요합니다.',
        planningBlock: {
          kind: 'needs_decision',
          source: 'verify',
          summary: '프로젝트 전체 검증 회귀가 발생했습니다.',
          findings: buildVerificationRecoveryFindings(verificationRun),
          options: buildRecoveryRetryOptions(ticket, 'verify'),
        },
      },
    }
  }

  if (diagnosis?.kind === 'plan_misalignment') {
    return {
      remediationNotes,
      recovery: {
        kind: 'new_run_plan',
        rationale: '검증 진단이 승인된 계획 또는 완료 기준 정렬 문제를 가리켜 새 run의 plan부터 다시 시작합니다.',
      },
    }
  }

  if (diagnosis?.fingerprint && countVerificationFingerprintOccurrences(ticket, diagnosis.fingerprint) >= 2) {
    const repeatedFingerprintNotes =
      combineRemediationNotes(
        remediationNotes,
        `동일한 검증 실패 fingerprint(${diagnosis.fingerprint})가 반복되어 자동 복구를 중단합니다.`
      ) ?? remediationNotes

    return {
      remediationNotes: repeatedFingerprintNotes,
      recovery: {
        kind: 'needs_decision',
        rationale: '같은 검증 실패가 반복되어 새 구현을 계속 재시도해도 수렴하지 않아 사람 판단이 필요합니다.',
        planningBlock: {
          kind: 'needs_decision',
          source: 'verify',
          summary: '동일한 자동 검증 실패가 반복되었습니다.',
          findings: buildVerificationRecoveryFindings(verificationRun),
          options: buildRecoveryRetryOptions(ticket, 'verify'),
        },
      },
    }
  }

  const decision = await maybeCoordinateTicketFailure({
    trigger: 'verify_failed',
    ticket,
    project,
    failureSummary: remediationNotes,
    evidence: [
      formatVerificationRun(verificationRun),
      ...(diagnosis ? [formatVerificationDiagnosisDetails(diagnosis, { includeRecovery: true })] : []),
    ],
    canRetryImplementInSameRun: false,
    signal,
  })

  if (!decision) {
    return {
      remediationNotes,
      recovery: {
        kind: diagnosis?.recommendedRecovery === 'new_run_plan' ? 'new_run_plan' : 'new_run_implement',
        rationale:
          diagnosis?.recommendedRecovery === 'new_run_plan'
            ? '검증 진단이 승인된 계획 또는 완료 기준 정렬 문제를 가리켜 새 run의 plan부터 다시 시작합니다.'
            : '검증 실패를 구현 보완 이슈로 간주해 새 run의 implement부터 다시 시작합니다.',
      },
    }
  }

  if (decision.kind === 'restart_plan') {
    return {
      remediationNotes: decision.remediationNotes,
      recovery: {
        kind: 'new_run_plan',
        rationale: decision.rationale,
      },
    }
  }

  if (decision.kind === 'restart_implement') {
    return {
      remediationNotes: decision.remediationNotes,
      recovery: {
        kind: 'new_run_implement',
        rationale: decision.rationale,
      },
    }
  }

  if (decision.kind === 'needs_decision' || decision.kind === 'needs_request_clarification') {
    return {
      remediationNotes: decision.remediationNotes,
      recovery: {
        kind: decision.kind,
        rationale: decision.rationale,
        planningBlock: buildCoordinatorPlanningBlock(
          ticket,
          'verify',
          decision,
          diagnosis ? diagnosis.summary : '자동 검증 실패 후 사람 판단이 필요합니다.',
          buildVerificationRecoveryFindings(verificationRun),
        ),
      },
    }
  }

  return {
    remediationNotes: decision.remediationNotes,
    recovery: {
      kind: 'new_run_implement',
      rationale: decision.rationale,
    },
  }
}

function canRetryReviewInSameRun(ticket: Ticket) {
  return Boolean(ticket.worktree && ticket.worktree.status !== 'cleanup_failed' && ticket.worktree.status !== 'discarded')
}

function buildSameRunRepairLoopLimitFindings(source: 'review' | 'verify', remediationNotes: string | undefined) {
  const heading = source === 'review' ? '리뷰 same-run 수선 한도에 도달했습니다.' : '검증 same-run 수선 한도에 도달했습니다.'
  const details = remediationNotes
    ?.split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 6)

  return details && details.length > 0 ? [heading, ...details] : [heading]
}

function buildReviewRecoverySignalText(review: ReviewRun) {
  return [review.summary, ...review.blockingFindings, ...review.residualRisks].join('\n')
}

function hasReviewPlanRestartSignal(review: ReviewRun) {
  const combined = buildReviewRecoverySignalText(review)
  const scopeSignal =
    /out[- ]of[- ]scope|scope drift|비범위|범위 위반|변경 범위[^\n]*불일치|non-goal|비목표/i.test(
      combined
    )
  const manualVerificationSignal =
    /수동 검증|manual verification|정적 검사로만은 보장되지|스크린샷|screenshot|화면 녹화|영상|브라우저[^\n]*확인|시각적 검증|visual verification|viewport/i.test(
      combined
    )

  return scopeSignal || manualVerificationSignal
}

function classifyReviewRecovery(ticket: Ticket, review: ReviewRun | undefined): ReviewRecoveryDecision {
  if (!review) {
    return {
      kind: canRetryReviewInSameRun(ticket) ? 'same_run_implement' : 'new_run_implement',
      rationale: canRetryReviewInSameRun(ticket)
        ? '리뷰 결과가 비어 있어 같은 run의 implement부터 다시 수선합니다.'
        : '리뷰 결과가 비어 있어 새 run의 implement부터 다시 시작합니다.',
    }
  }

  const findings = [...review.blockingFindings, ...review.residualRisks]
  const combined = buildReviewRecoverySignalText(review)
  const requestNeedsReplan =
    review.goalAssessment.request.status === 'partial' || review.goalAssessment.request.status === 'misaligned'
  const ticketNeedsRework =
    review.goalAssessment.ticket.status === 'partial' || review.goalAssessment.ticket.status === 'misaligned'
  const clarificationSignal =
    /clarification|ambiguous|contradict|scenario|non-goal|open question|요구사항 설명|요구사항 보완|시나리오|비목표|모호|상충|추가 설명/i.test(
      combined
    )
  const decisionSignal = /정책|결정|선택|trade-?off|either|어느 쪽|둘 중|판단/i.test(combined)
  const planSignal = /계획|acceptance|criterion|criteria|scope|범위|request|spec|설계|interface|contract|검증 계획/i.test(combined)

  if (clarificationSignal) {
    return {
      kind: 'needs_request_clarification',
      rationale: '리뷰가 요구사항 보완 없이는 다음 진행 경로를 확정할 수 없어 사람의 보완이 필요합니다.',
      planningBlock: {
        kind: 'needs_request_clarification',
        source: 'review',
        summary: review.summary,
        findings,
        options: [
          {
            id: 'review-restart-plan',
            label: '요구사항 보완 후 계획부터 다시 시작',
            startStepId: 'plan',
            executionMode: 'new_run',
            sessionMode: 'new_thread',
          },
        ],
      },
    }
  }

  if (requestNeedsReplan && decisionSignal) {
    return {
      kind: 'needs_decision',
      rationale: '리뷰가 요구사항 재정렬과 구현 재시작 중 어느 경로가 맞는지 사람 판단을 요구합니다.',
      planningBlock: {
        kind: 'needs_decision',
        source: 'review',
        summary: review.summary,
        findings,
        options: buildRecoveryRetryOptions(ticket, 'review'),
      },
    }
  }

  if (requestNeedsReplan) {
    return {
      kind: 'new_run_plan',
      rationale: '리뷰가 요구사항 또는 계획 정렬 문제를 보여 새 run으로 plan부터 다시 시작합니다.',
    }
  }

  if (hasReviewPlanRestartSignal(review)) {
    return {
      kind: 'new_run_plan',
      rationale: '리뷰가 범위 준수 또는 검증 전략 재정렬 문제를 보여 새 run으로 plan부터 다시 시작합니다.',
    }
  }

  if (ticketNeedsRework) {
    return {
      kind: canRetryReviewInSameRun(ticket) ? 'same_run_implement' : 'new_run_implement',
      rationale: canRetryReviewInSameRun(ticket)
        ? '리뷰가 구현 결과가 승인된 계획과 어긋났음을 보여 같은 run의 implement부터 다시 수선합니다.'
        : '리뷰가 구현 결과가 승인된 계획과 어긋났음을 보여 새 run의 implement부터 다시 시작합니다.',
    }
  }

  if (decisionSignal) {
    return {
      kind: 'needs_decision',
      rationale: '리뷰가 구현 재시작과 계획 재정렬 중 어느 경로가 맞는지 사람 판단을 요구합니다.',
      planningBlock: {
        kind: 'needs_decision',
        source: 'review',
        summary: review.summary,
        findings,
        options: buildRecoveryRetryOptions(ticket, 'review'),
      },
    }
  }

  if (planSignal) {
    return {
      kind: 'new_run_plan',
      rationale: '리뷰가 계획 또는 요구사항 정렬 문제를 보여 새 run으로 plan부터 다시 시작합니다.',
    }
  }

  return {
    kind: canRetryReviewInSameRun(ticket) ? 'same_run_implement' : 'new_run_implement',
    rationale: canRetryReviewInSameRun(ticket)
      ? '리뷰가 구현 보완 이슈 중심이라 같은 run의 implement부터 다시 수선합니다.'
      : '리뷰가 구현 보완 이슈 중심이라 새 run의 implement부터 다시 시작합니다.',
  }
}

function determineSelfHealStartStep(ticket: Ticket, trigger: TicketSelfHealTrigger) {
  if (trigger.preferredStartStep) {
    return {
      startStepId: trigger.preferredStartStep,
      rationale: `조율 결과에 따라 ${trigger.preferredStartStep} 단계부터 다시 시작합니다.`,
    }
  }

  if (trigger.kind === 'analyze_failed') {
    return {
      startStepId: 'analyze' as const,
      rationale: '분석 단계 자체가 충분히 통과하지 못해 analyze부터 다시 수행합니다.',
    }
  }

  if (trigger.kind === 'verify_failed') {
    return {
      startStepId: 'implement' as const,
      rationale: '검증 실패는 구현 수정으로 바로 회복 가능한 경우가 많아 implement부터 다시 수행합니다.',
    }
  }

  const latestReview = ticket.reviewRuns.at(-1)
  const recovery = classifyReviewRecovery(ticket, latestReview)
  if (recovery.kind === 'new_run_plan') {
    return {
      startStepId: 'plan' as const,
      rationale: recovery.rationale,
    }
  }

  return {
    startStepId: 'implement' as const,
    rationale: recovery.rationale,
  }
}

function buildSelfHealNotes(ticket: Ticket, trigger: TicketSelfHealTrigger, rationale: string) {
  const sections = [
    `Ticket 자동 복구 지침`,
    `- 실패 유형: ${trigger.kind}`,
    `- 실패 단계: ${trigger.phase}`,
    `- 실패 시도: ${trigger.attempt}`,
    `- 복구 판단: ${rationale}`,
    '',
    '직전 실패 요약:',
    trigger.message,
  ]

  if (trigger.kind === 'verify_failed') {
    sections.push('', buildVerificationFeedback(ticket.verificationRuns.at(-1) as VerificationRun))
  }

  if (trigger.kind === 'review_failed' && ticket.reviewRuns.at(-1)) {
    sections.push('', buildReviewFeedback(ticket.reviewRuns.at(-1) as ReviewRun))
  }

  return sections.join('\n')
}

async function attemptTicketSelfHeal(
  ticketId: string,
  trigger: TicketSelfHealTrigger,
  onEvent: RunTicketWorkflowOptions['onEvent'],
  signal?: AbortSignal
): Promise<TicketSelfHealOutcome> {
  if (!ticketSelfHealingEnabled) {
    return 'disabled'
  }

  const ticket = getTicketOrThrow(ticketId)
  if (ticket.runSummaries.length >= MAX_TICKET_WORKFLOW_RUNS) {
    return 'run_limit'
  }

  const decision = determineSelfHealStartStep(ticket, trigger)
  const recoveryNotes = buildSelfHealNotes(ticket, trigger, decision.rationale)
  const shouldCleanupWorktree = Boolean(
    ticket.worktree && ticket.worktree.status !== 'merged' && ticket.worktree.status !== 'discarded'
  )

  try {
    if (shouldCleanupWorktree) {
      await destroyTicketWorktree(ticketId, signal)
    }

    const reset = applyTicketRetryPlan(ticketId, {
      id: `self-heal-${decision.startStepId}`,
      label: `자동 복구: ${decision.startStepId}부터 새 run 시작`,
      startStepId: decision.startStepId,
      executionMode: 'new_run',
      sessionMode: 'new_thread',
      shouldCleanupWorktree,
    })
    if (!reset) {
      return 'failed'
    }

    appendTimelineEvent(ticketId, {
      type: 'system',
      title: `자동 복구 판단에 따라 ${reset.startStepId} 단계부터 새 run을 시작합니다.`,
      body: recoveryNotes,
    })

    await runAutomaticTicketWorkflow({
      ticketId,
      startStepId: reset.startStepId,
      recoveryNotes,
      signal,
      onEvent,
    })

    return 'started'
  } catch (error) {
    console.error(`Failed to self-heal ticket ${ticketId}:`, error)
    return 'failed'
  }
}

async function runImplementLoop(
  ticket: Ticket,
  initialRecoveryNotes: string | undefined,
  onEvent: RunTicketWorkflowOptions['onEvent'],
  signal?: AbortSignal
) {
  const project = getProjectConfig(ticket)
  const implementStep = getStepConfig('implement')
  const maxImplementAttempts = getConfiguredStepMaxAttempts(implementStep)
  const reviewStep = getStepConfig('review')

  if (!implementStep.promptFile || !implementStep.sandboxMode || !implementStep.approvalPolicy) {
    throw new Error('Implement step is not configured for agent execution')
  }

  let remediationNotes = initialRecoveryNotes
  let attempt = ticket.attemptCount
  let loopAttempts = 0

  while (true) {
    ensureAbortSignal(signal)
    loopAttempts += 1
    attempt += 1
    setTicketAttemptCount(ticket.id, attempt)
    await ensureWorktree(getTicketOrThrow(ticket.id), attempt, signal)
    await prepareReconcileSeededWorktree(getTicketOrThrow(ticket.id), signal)
    const activeTicket = getTicketOrThrow(ticket.id)

    setTicketCurrentPhase(ticket.id, 'implement')
    updateStepStatus(ticket.id, 'implement', 'running')
    appendTimelineEvent(ticket.id, {
      type: 'phase',
      stepId: 'implement',
      attempt,
      status: 'running',
      title: `구현 ${attempt}회를 시작했습니다.`,
      body: remediationNotes,
    })
    await emitStep(onEvent, ticket, 'implement', 'running', attempt)

    const implementHeader = `\n## 구현 시도 ${attempt}\n\n`
    appendStepOutput(ticket.id, 'implement', implementHeader)
    await emitDelta(onEvent, ticket, 'implement', implementHeader, attempt)

    const result = await runRestartableTicketTurn({
      ticket: activeTicket,
      stepConfig: implementStep,
      prompt: buildImplementPrompt(activeTicket, attempt, remediationNotes),
      promptFile: implementStep.promptFile,
      cwd: getExecutionCwd(activeTicket),
      additionalDirectories: getTicketSkillDirectories(implementStep.id),
      threadId: getImplementationThreadId(activeTicket),
      stepLabel: `구현 ${attempt}회`,
      signal,
      onThreadId: (threadId) => {
        setTicketImplementationThreadId(ticket.id, threadId)
      },
      onEvent: async (event) => {
        if (event.type === 'delta' && event.data.text) {
          appendStepOutput(ticket.id, 'implement', event.data.text)
          await emitDelta(onEvent, getTicketOrThrow(ticket.id), 'implement', event.data.text, attempt)
        }
      },
    })

    updateStepStatus(ticket.id, 'implement', 'done')
    appendTimelineEvent(ticket.id, {
      type: 'phase',
      stepId: 'implement',
      attempt,
      status: 'done',
      title: `구현 ${attempt}회가 완료되었습니다.`,
    })
    await emitStep(onEvent, getTicketOrThrow(ticket.id), 'implement', 'done', attempt)

    let verificationRun: VerificationRun | undefined

    if (includesStep(activeTicket, 'verify')) {
      verificationRun = await runVerification(getTicketOrThrow(ticket.id), project, attempt, onEvent, signal)
      if (verificationRun.status === 'failed') {
        const verificationFailure = classifyVerificationFailure(verificationRun)
        remediationNotes = buildVerificationFeedback(verificationRun)

        if (verificationFailure.kind === 'verification_environment_failed') {
          clearRepairLoopForTicket(ticket.id)
          setTicketRunState(ticket.id, 'failed')
          appendTimelineEvent(ticket.id, {
            type: 'system',
            title: '자동 검증 실패를 검증 환경 문제로 분류해 티켓 실행을 중단했습니다.',
            body: remediationNotes,
          })
          captureIncidentSafely(ticket.id, {
            kind: 'verification_environment_failed',
            message: remediationNotes,
            phase: 'verify',
            attempt,
          })
          await emitDone(onEvent, getTicketOrThrow(ticket.id), 'verify', 'failed', attempt)
          return
        }

        if (verificationRun.diagnosis?.kind === 'external_blocker') {
          clearRepairLoopForTicket(ticket.id)
          await blockTicketOnExternalVerificationFailure(getTicketOrThrow(ticket.id), verificationRun, remediationNotes, attempt, onEvent)
          return
        }

        const coordination = await coordinateVerifyRecoveryDecision(
          getTicketOrThrow(ticket.id),
          project,
          verificationRun,
          remediationNotes,
          signal
        )
        remediationNotes = coordination.remediationNotes

        if (coordination.recovery.kind === 'same_run_implement') {
          const repairLoop = beginTicketRepairLoop(ticket.id, 'verify', remediationNotes)
          appendTimelineEvent(ticket.id, {
            type: 'system',
            title: `자동 검증 실패를 같은 run에서 수선합니다. (${repairLoop.cycle}회차)`,
            body: remediationNotes,
          })
          continue
        }

        if (coordination.recovery.kind === 'new_run_plan' || coordination.recovery.kind === 'new_run_implement') {
          const preferredStartStep = coordination.recovery.kind === 'new_run_plan' ? 'plan' : 'implement'
          appendTimelineEvent(ticket.id, {
            type: 'system',
            title:
              preferredStartStep === 'plan'
                ? '자동 검증 실패를 바탕으로 계획 단계부터 새 run을 다시 시작합니다.'
                : '자동 검증 실패를 바탕으로 구현 단계부터 새 run을 다시 시작합니다.',
            body: remediationNotes,
          })

          const selfHealOutcome = await attemptTicketSelfHeal(
            ticket.id,
            {
              kind: 'verify_failed',
              message: remediationNotes,
              phase: 'verify',
              attempt,
              preferredStartStep,
            },
            onEvent,
            signal
          )
          if (selfHealOutcome === 'started') {
            return
          }

          if (selfHealOutcome === 'run_limit' || selfHealOutcome === 'disabled') {
            clearRepairLoopForTicket(ticket.id)
            setTicketPlanningBlock(
              ticket.id,
              buildSelfHealUnavailablePlanningBlock(
                getTicketOrThrow(ticket.id),
                'verify',
                '자동 검증 실패 후 더 이상 안전한 자동 복구를 진행할 수 없습니다.',
                buildVerificationRecoveryFindings(verificationRun)
              )
            )
            setTicketRunState(ticket.id, 'needs_decision')
            appendTimelineEvent(ticket.id, {
              type: 'system',
              title: '자동 검증 실패 후 사람 판단이 필요한 상태로 전환했습니다.',
              body: remediationNotes,
            })
            await emitDone(onEvent, getTicketOrThrow(ticket.id), 'verify', 'failed', attempt)
            return
          }

          setTicketRunState(ticket.id, 'failed')
          appendTimelineEvent(ticket.id, {
            type: 'system',
            title:
              preferredStartStep === 'plan'
                ? '자동 검증 실패 후 계획 단계 자동 복구를 더 진행할 수 없어 incident를 기록합니다.'
                : '자동 검증 실패 후 구현 단계 자동 복구를 더 진행할 수 없어 incident를 기록합니다.',
            body: remediationNotes,
          })
          captureIncidentSafely(ticket.id, {
            kind: 'verify_failed',
            message: remediationNotes,
            phase: 'verify',
            attempt,
          })
          await emitDone(onEvent, getTicketOrThrow(ticket.id), 'verify', 'failed', attempt)
          return
        }

        clearRepairLoopForTicket(ticket.id)
        if (coordination.recovery.kind === 'needs_decision' || coordination.recovery.kind === 'needs_request_clarification') {
          setTicketPlanningBlock(ticket.id, coordination.recovery.planningBlock)
          setTicketRunState(ticket.id, coordination.recovery.kind)
          appendTimelineEvent(ticket.id, {
            type: 'system',
            title:
              coordination.recovery.kind === 'needs_decision'
                ? '자동 검증 실패를 해결할 경로에 사람의 선택이 필요합니다.'
                : '자동 검증 실패를 해결하려면 요구사항 보완이 먼저 필요합니다.',
            body: remediationNotes,
          })
          await emitDone(onEvent, getTicketOrThrow(ticket.id), 'verify', 'failed', attempt)
          return
        }
      }
    }

    const reviewRun = await runReview(
      getTicketOrThrow(ticket.id),
      reviewStep,
      attempt,
      verificationRun ?? {
        attempt,
        status: 'passed',
        commands: [],
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      },
      onEvent,
      signal
    )

    if (reviewRun.verdict === 'fail') {
      remediationNotes = buildReviewFeedback(reviewRun)
      const coordinated = await coordinateReviewRecoveryDecision(
        getTicketOrThrow(ticket.id),
        project,
        reviewRun,
        remediationNotes,
        signal
      )
      remediationNotes = coordinated.remediationNotes
      const recovery = coordinated.recovery

      if (recovery.kind === 'same_run_implement') {
        if (loopAttempts >= maxImplementAttempts) {
          clearRepairLoopForTicket(ticket.id)
          setTicketPlanningBlock(ticket.id, {
            kind: 'needs_decision',
            source: 'review',
            summary: '같은 run에서 구현/리뷰 자동 수선을 더 진행할 수 없어 사람 판단이 필요합니다.',
            findings: buildSameRunRepairLoopLimitFindings('review', remediationNotes),
            options: buildRecoveryRetryOptions(getTicketOrThrow(ticket.id), 'review'),
          })
          setTicketRunState(ticket.id, 'needs_decision')
          appendTimelineEvent(ticket.id, {
            type: 'system',
            title: '같은 run의 구현 자동 수선이 반복 한도에 도달해 추가 재시도를 중단합니다.',
            body: remediationNotes,
          })
          await emitDone(onEvent, getTicketOrThrow(ticket.id), 'review', 'failed', attempt)
          return
        }

        const repairLoop = beginTicketRepairLoop(ticket.id, 'review', remediationNotes)
        appendTimelineEvent(ticket.id, {
          type: 'system',
          title: `코드 리뷰 실패를 같은 run에서 수선합니다. (${repairLoop.cycle}회차)`,
          body: remediationNotes,
        })
        continue
      }

      if (recovery.kind === 'new_run_plan' || recovery.kind === 'new_run_implement') {
        const preferredStartStep = recovery.kind === 'new_run_plan' ? 'plan' : 'implement'
        appendTimelineEvent(ticket.id, {
          type: 'system',
          title:
            preferredStartStep === 'plan'
              ? '코드 리뷰 피드백을 반영해 계획 단계부터 새 run을 다시 시작합니다.'
              : '코드 리뷰 피드백을 반영해 구현 단계부터 새 run을 다시 시작합니다.',
          body: remediationNotes,
        })

        if (
          (await attemptTicketSelfHeal(
            ticket.id,
            {
              kind: 'review_failed',
              message: remediationNotes,
              phase: 'review',
              attempt,
              preferredStartStep,
            },
            onEvent,
            signal
          )) === 'started'
        ) {
          return
        }

        setTicketRunState(ticket.id, 'failed')
        appendTimelineEvent(ticket.id, {
          type: 'system',
          title:
            preferredStartStep === 'plan'
              ? '계획 단계 자동 복구를 더 진행할 수 없어 incident를 기록합니다.'
              : '구현 단계 자동 복구를 더 진행할 수 없어 incident를 기록합니다.',
          body: remediationNotes,
        })
        captureIncidentSafely(ticket.id, {
          kind: 'review_failed',
          message: remediationNotes,
          phase: 'review',
          attempt,
        })
        await emitDone(onEvent, getTicketOrThrow(ticket.id), 'review', 'failed', attempt)
        return
      }

      clearRepairLoopForTicket(ticket.id)
      if (recovery.kind === 'needs_decision' || recovery.kind === 'needs_request_clarification') {
        setTicketPlanningBlock(ticket.id, recovery.planningBlock)
        setTicketRunState(ticket.id, recovery.kind)
        appendTimelineEvent(ticket.id, {
          type: 'system',
          title:
            recovery.kind === 'needs_decision'
              ? '리뷰 결과를 어떻게 반영할지 사람의 선택이 필요합니다.'
              : '리뷰 결과를 해결하려면 요구사항 보완이 먼저 필요합니다.',
          body: remediationNotes,
        })
        await emitDone(onEvent, getTicketOrThrow(ticket.id), 'review', 'failed', attempt)
        return
      }
    }

    await finalizeTicketReadyState(ticket.id, reviewRun, verificationRun, attempt, onEvent, signal)
    return
  }
}

function latestStageReviewVerdict(ticket: Ticket, subjectStepId: 'analyze' | 'plan') {
  return [...ticket.stageReviews].reverse().find((review) => review.subjectStepId === subjectStepId)?.verdict
}

function ensureStageReviewPassed(ticket: Ticket, subjectStepId: 'analyze' | 'plan') {
  return latestStageReviewVerdict(ticket, subjectStepId) === 'pass'
}

export async function destroyTicketWorktree(ticketId: string, signal?: AbortSignal) {
  const ticket = getTicketOrThrow(ticketId)
  if (!ticket.worktree) {
    return
  }

  if (!existsSync(ticket.worktree.worktreePath)) {
    try {
      await reconcileMissingWorktree(ticket, signal)
      clearTicketWorktree(ticketId)
    } catch (error: any) {
      recordCleanupFailure(ticketId, error.message)
      throw error
    }
    return
  }

  try {
    await cleanupWorktree(ticket, signal)
    clearTicketWorktree(ticketId)
  } catch (error: any) {
    recordCleanupFailure(ticketId, error.message)
    throw error
  }
}

export async function runAutomaticTicketWorkflow(opts: RunAutomaticTicketWorkflowOptions): Promise<void> {
  const ticket = getTicketOrThrow(opts.ticketId)
  const startStepId = opts.startStepId ?? 'analyze'
  const project = getProjectConfig(ticket)

  setTicketRunState(ticket.id, 'running')
  setTicketCurrentPhase(ticket.id, startStepId)
  appendTimelineEvent(ticket.id, {
    type: 'system',
    title: startStepId === 'analyze' ? '자동 실행을 시작했습니다.' : `자동 실행을 ${startStepId} 단계부터 재개합니다.`,
  })

  if (startStepId === 'analyze') {
    const ok = await runAnalyzeUntilReviewed(
      getTicketOrThrow(ticket.id),
      project,
      opts.recoveryNotes,
      opts.onEvent,
      opts.signal
    )
    if (!ok) {
      return
    }
  }

  if (startStepId === 'analyze' || startStepId === 'plan') {
    const ok = await runPlanUntilReviewed(
      getTicketOrThrow(ticket.id),
      project,
      startStepId === 'plan' ? opts.recoveryNotes : undefined,
      opts.onEvent,
      opts.signal
    )
    if (!ok) {
      return
    }
  }

  if (startStepId === 'implement' && !ensureStageReviewPassed(getTicketOrThrow(ticket.id), 'plan')) {
    throw new Error('Implement can start only after a passing plan review')
  }

  if (startStepId === 'verify' || startStepId === 'review') {
    await runValidationAndReady(getTicketOrThrow(ticket.id), startStepId, opts.onEvent, opts.signal)
    return
  }

  await runImplementLoop(
    getTicketOrThrow(ticket.id),
    startStepId === 'implement' ? opts.recoveryNotes : undefined,
    opts.onEvent,
    opts.signal
  )
}

export async function prepareTicketWorktreeForMergeResolution(
  ticketId: string,
  action: 'rebase_and_revalidate' | 'revalidate_current_worktree',
  signal?: AbortSignal
) {
  const ticket = getTicketOrThrow(ticketId)
  if (!ticket.worktree || ticket.status !== 'awaiting_merge') {
    throw new Error('Ticket is not waiting for a merge decision')
  }

  await ensureMergeableWorktreeCommit(ticket, signal)

  if (action === 'rebase_and_revalidate') {
    const analysis = await inspectMergeIssue(
      getTicketOrThrow(ticketId),
      'Merge target commit changed since worktree creation. Re-run the ticket from the latest base commit.',
      signal
    )
    if (analysis.issue === 'rebase_conflict_text' || analysis.issue === 'rebase_conflict_code') {
      const conflictSummary =
        analysis.conflictFiles.length > 0 ? `: ${analysis.conflictFiles.map((file) => file.trim()).join(', ')}` : ''
      throw new Error(`Rebase conflict detected while preparing the ticket worktree${conflictSummary}`)
    }

    const currentBranch = (await readGitValue('git branch --show-current', ticket.projectPath, signal)) || 'HEAD'
    const currentBaseCommit = await readGitValue('git rev-parse HEAD', ticket.projectPath, signal)
    const rebaseResult = await runCommand(
      `git rebase ${quoteShellArg(currentBaseCommit)}`,
      ticket.worktree.worktreePath,
      60_000,
      signal
    )

    if (rebaseResult.exitCode !== 0) {
      await runCommand('git rebase --abort', ticket.worktree.worktreePath, 15_000, signal)
      throw new Error(rebaseResult.output.trim() || 'Rebase failed while preparing the ticket worktree')
    }

    updateTicketWorktree(ticket.id, {
      baseBranch: currentBranch,
      baseCommit: currentBaseCommit,
    })
    appendTimelineEvent(ticket.id, {
      type: 'system',
      title: '현재 기준 브랜치 위로 worktree를 rebase했습니다.',
    })
  } else {
    appendTimelineEvent(ticket.id, {
      type: 'system',
      title: '현재 worktree 기준으로 merge 재검증을 준비합니다.',
    })
  }

  const refreshedTicket = getTicketOrThrow(ticket.id)
  const headCommit = await readGitValue('git rev-parse HEAD', refreshedTicket.worktree!.worktreePath, signal)
  const diffSummary = await collectCommittedTicketDiffSummary(refreshedTicket, signal)
  updateTicketWorktree(ticket.id, {
    headCommit,
    diffSummary,
    status: 'ready',
  })
  setTicketMergeBlock(ticket.id, undefined)

  return {
    startStepId: includesStep(refreshedTicket, 'verify') ? ('verify' as const) : ('review' as const),
    recoveryNotes:
      action === 'rebase_and_revalidate'
        ? '머지 기준 브랜치가 변경되어 현재 HEAD 위로 rebase한 뒤 verify/review를 다시 실행합니다.'
        : 'worktree 상태가 바뀌어 verify/review를 다시 실행합니다.',
  }
}

export async function mergeTicketWorktree(ticketId: string, signal?: AbortSignal) {
  const ticket = getTicketOrThrow(ticketId)

  if (!ticket.worktree || ticket.status !== 'awaiting_merge' || ticket.steps.ready?.status !== 'done') {
    throw new Error('Ticket is not ready for merge')
  }

  if (ticket.worktree.baseBranch !== 'HEAD') {
    const currentBranch = await readGitValue('git branch --show-current', ticket.projectPath, signal)
    if (currentBranch !== ticket.worktree.baseBranch) {
      throw new Error('Merge target branch changed since worktree creation. Re-run the ticket from the current branch.')
    }
  }

  const currentBaseCommit = await readGitValue('git rev-parse HEAD', ticket.projectPath, signal)
  if (currentBaseCommit !== ticket.worktree.baseCommit) {
    throw new Error('Merge target commit changed since worktree creation. Re-run the ticket from the latest base commit.')
  }

  const currentHead = await readGitValue('git rev-parse HEAD', ticket.worktree.worktreePath, signal)
  if (ticket.worktree.headCommit && currentHead !== ticket.worktree.headCommit) {
    throw new Error('Worktree head changed after review. Re-run review before merging.')
  }

  const dirtyTarget = await inspectDirtyMergeTarget(ticket, signal)
  if (dirtyTarget.overlappingFiles.length > 0) {
    throw new Error(buildDirtyTargetMergeMessage(dirtyTarget.overlappingFiles))
  }

  const mergeResult = await runCommand(
    `git merge --ff-only "${ticket.worktree.branchName}"`,
    ticket.projectPath,
    30_000,
    signal
  )
  if (mergeResult.exitCode !== 0) {
    throw new Error(mergeResult.output.trim() || 'Failed to merge ticket worktree branch')
  }

  const mergeCommit = await readGitValue('git rev-parse HEAD', ticket.projectPath, signal)

  try {
    await cleanupWorktree(getTicketOrThrow(ticket.id), signal)
    updateTicketWorktree(ticket.id, {
      mergeCommit,
      status: 'merged',
    })
    setTicketMergeBlock(ticket.id, undefined)
    const cleanedSupersededWorktree = await cleanupSupersededWorktree(ticket.id, signal)
    if (cleanedSupersededWorktree) {
      setTicketMergeContext(ticket.id, undefined)
    }
    appendTimelineEvent(ticket.id, {
      type: 'system',
      title: '리뷰된 worktree가 메인 브랜치에 반영되었습니다.',
    })
    setTicketStatus(ticket.id, 'completed')
  } catch (error: any) {
    recordCleanupFailure(ticket.id, `머지는 완료되었지만 정리에 실패했습니다. ${error.message}`, {
      mergeCommit,
    })
    setTicketStatus(ticket.id, 'completed')
    throw new Error(`Merged successfully, but cleanup failed: ${error.message}`)
  }
}

export async function discardTicketWorktree(ticketId: string, signal?: AbortSignal) {
  const ticket = getTicketOrThrow(ticketId)

  if (!ticket.worktree || ticket.status !== 'awaiting_merge') {
    throw new Error('Ticket is not waiting for a merge decision')
  }

  try {
    await cleanupWorktree(getTicketOrThrow(ticket.id), signal)
    updateTicketWorktree(ticket.id, { status: 'discarded' })
    setTicketMergeBlock(ticket.id, undefined)
    const cleanedSupersededWorktree = await cleanupSupersededWorktree(ticket.id, signal)
    if (cleanedSupersededWorktree) {
      setTicketMergeContext(ticket.id, undefined)
    }
    appendTimelineEvent(ticket.id, {
      type: 'system',
      title: '머지 대기 중인 worktree를 폐기했습니다.',
    })
    setTicketStatus(ticket.id, 'discarded')
  } catch (error: any) {
    recordCleanupFailure(ticket.id, `폐기를 완료하지 못했습니다. ${error.message}`)
    throw error
  }
}

export async function runTicketWorkflow(opts: RunTicketWorkflowOptions): Promise<void> {
  const ticket = getTicketOrThrow(opts.ticketId)
  const project = getProjectConfig(ticket)

  if (opts.stepId === 'analyze') {
    await runAnalyzeUntilReviewed(ticket, project, undefined, opts.onEvent, opts.signal)
    return
  }

  if (opts.stepId === 'plan') {
    await runPlanUntilReviewed(ticket, project, undefined, opts.onEvent, opts.signal)
    return
  }

  if (opts.stepId === 'implement') {
    if (!ensureStageReviewPassed(ticket, 'plan')) {
      throw new Error('Implement step requires a passing plan review')
    }
    await runImplementLoop(ticket, undefined, opts.onEvent, opts.signal)
    return
  }

  throw new Error(`Unsupported manual ticket step "${opts.stepId}"`)
}
