import { loadConfig, type ProjectConfig } from '../lib/config.js'
import { runCodexTurn, runRecoverableCodexTurn, type CodexTurnResult, type RunCodexTurnOptions } from './codex-sdk.js'
import type { Ticket, TicketPlanningBlock, TicketWorktree } from './tickets.js'

export type CoordinatorTrigger = 'plan_review_failed' | 'verify_failed' | 'review_failed'
export type CoordinatorDecisionKind =
  | 'retry_plan'
  | 'restart_implement'
  | 'restart_plan'
  | 'needs_decision'
  | 'needs_request_clarification'

export interface CoordinatorDecision {
  kind: CoordinatorDecisionKind
  rationale: string
  remediationNotes: string
  confidence: 'low' | 'medium' | 'high'
}

interface RawCoordinatorDecision {
  kind?: string
  rationale?: string
  remediationNotes?: string
  confidence?: string
}

export interface CoordinateTicketFailureOptions {
  trigger: CoordinatorTrigger
  ticket: Ticket
  project: ProjectConfig
  failureSummary: string
  evidence: string[]
  canRetryImplementInSameRun: boolean
  threadId?: string
  onThreadId?: (threadId: string) => void
  onRecoveryState?: (reason?: string) => void
  signal?: AbortSignal
  runCodexTurnImpl?: <T = unknown>(opts: RunCodexTurnOptions) => Promise<CodexTurnResult<T>>
}

const TICKET_COORDINATOR_DECISION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'rationale', 'remediationNotes', 'confidence'],
  properties: {
    kind: {
      type: 'string',
      enum: ['retry_plan', 'restart_implement', 'restart_plan', 'needs_decision', 'needs_request_clarification'],
    },
    rationale: { type: 'string' },
    remediationNotes: { type: 'string' },
    confidence: {
      type: 'string',
      enum: ['low', 'medium', 'high'],
    },
  },
} as const

function getAllowedKinds(trigger: CoordinatorTrigger) {
  if (trigger === 'plan_review_failed') {
    return ['retry_plan', 'needs_decision', 'needs_request_clarification'] as const
  }

  return ['restart_implement', 'restart_plan', 'needs_decision', 'needs_request_clarification'] as const
}

function makeExcerpt(text: string | undefined, limit = 6_000) {
  const normalized = text?.trim()
  if (!normalized) {
    return '없음'
  }

  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit)}\n...(truncated)`
}

function summarizeVerificationCommands(project: ProjectConfig) {
  return project.verificationCommands.map((command) => `- ${command.label}: \`${command.command}\``).join('\n')
}

function describePlanningBlock(planningBlock?: TicketPlanningBlock) {
  if (!planningBlock) {
    return '없음'
  }

  return [
    `kind: ${planningBlock.kind}`,
    `summary: ${planningBlock.summary}`,
    planningBlock.findings.length > 0 ? `findings:\n${planningBlock.findings.map((entry) => `- ${entry}`).join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

function describeWorktreeStatus(worktree?: TicketWorktree) {
  if (!worktree) {
    return '없음'
  }

  return [
    `status: ${worktree.status}`,
    `branch: ${worktree.branchName}`,
    `baseBranch: ${worktree.baseBranch}`,
    worktree.baseCommit ? `baseCommit: ${worktree.baseCommit}` : '',
    worktree.headCommit ? `headCommit: ${worktree.headCommit}` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

function buildAllowedActions(trigger: CoordinatorTrigger, canRetryImplementInSameRun: boolean) {
  if (trigger === 'plan_review_failed') {
    return [
      '- retry_plan: 같은 planning thread를 유지한 채 plan을 다시 쓴다.',
      '- needs_decision: 사람의 선택이 없으면 어떤 경로가 맞는지 확정할 수 없다.',
      '- needs_request_clarification: 요구사항 설명 보완이 먼저 필요하다.',
    ].join('\n')
  }

  if (trigger === 'verify_failed') {
    return [
      '- restart_implement: approved plan을 유지한 새 run, 새 implementation thread에서 implement부터 다시 시작한다.',
      '- restart_plan: planning thread를 유지한 새 run으로 plan부터 다시 시작한다.',
      '- needs_decision: 구현 보완과 계획 재정렬 중 사람의 선택이 필요하다.',
      '- needs_request_clarification: 요구사항 설명 보완이 먼저 필요하다.',
    ].join('\n')
  }

  return [
    canRetryImplementInSameRun
      ? '- restart_implement: approved plan을 유지하고 review 실패가 국소적이면 같은 run, 같은 worktree, 같은 implementation thread를 재사용해 implement부터 다시 수선할 수 있다.'
      : '- restart_implement: approved plan을 유지한 새 run, 새 implementation thread에서 implement부터 다시 시작한다.',
    '- restart_plan: planning thread를 유지한 새 run으로 plan부터 다시 시작한다.',
    '- needs_decision: 구현 보완과 계획 재정렬 중 사람의 선택이 필요하다.',
    '- needs_request_clarification: 요구사항 설명 보완이 먼저 필요하다.',
  ].join('\n')
}

function buildCoordinatorPrompt(opts: CoordinateTicketFailureOptions) {
  return [
    `Trigger: ${opts.trigger}`,
    '',
    `Ticket title: ${opts.ticket.title}`,
    '',
    `Ticket description:\n${opts.ticket.description}`,
    '',
    `Current phase: ${opts.ticket.currentPhase ?? '없음'}`,
    `Current worktree reusable without cleanup: ${opts.canRetryImplementInSameRun ? 'yes' : 'no'}`,
    `Planning thread exists: ${opts.ticket.planningThreadId ? 'yes' : 'no'}`,
    `Implementation thread exists: ${opts.ticket.implementationThreadId ? 'yes' : 'no'}`,
    '',
    `Worktree:\n${describeWorktreeStatus(opts.ticket.worktree)}`,
    '',
    `Analyze output:\n${makeExcerpt(opts.ticket.steps.analyze?.output)}`,
    '',
    `Plan output:\n${makeExcerpt(opts.ticket.steps.plan?.output)}`,
    '',
    `Latest failure summary:\n${makeExcerpt(opts.failureSummary, 4_000)}`,
    '',
    'Evidence:',
    opts.evidence.length > 0 ? opts.evidence.map((entry) => `- ${makeExcerpt(entry, 2_000)}`).join('\n') : '- 없음',
    '',
    `Existing planning block:\n${describePlanningBlock(opts.ticket.planningBlock)}`,
    '',
    'Scheduled verification commands:',
    summarizeVerificationCommands(opts.project),
    '',
    'Allowed actions:',
    buildAllowedActions(opts.trigger, opts.canRetryImplementInSameRun),
    '',
    '결정 원칙:',
    '- approved plan이 유효하고 구현이 goal에서 벗어났으면 restart_implement를 우선한다.',
    opts.trigger === 'verify_failed'
      ? '- verify 실패는 같은 run 수선보다 fresh run implement 재시작을 우선한다.'
      : '- review 실패가 국소적이고 현재 worktree를 안전하게 재사용할 수 있을 때만 같은 run 수선을 고려한다.',
    '- 요구사항, scope, acceptance criteria, 설계 정렬 문제면 restart_plan 또는 사람 개입을 선택한다.',
    '- 사람이 없이는 정책/우선순위 판단을 확정할 수 없으면 needs_decision을 선택한다.',
    '- 요구사항 자체가 부족하거나 모호하면 needs_request_clarification을 선택한다.',
    '- remediationNotes에는 다음 worker나 사람에게 바로 보여줄 수 있는 구체적 조치만 적는다.',
  ].join('\n')
}

function fallbackKind(trigger: CoordinatorTrigger, failureSummary: string) {
  const combined = failureSummary.trim()
  const clarificationSignal =
    /clarification|ambiguous|contradict|scenario|non-goal|open question|요구사항 설명|요구사항 보완|시나리오|비목표|모호|상충|추가 설명/i.test(
      combined
    )
  const decisionSignal = /정책|결정|선택|trade-?off|either|어느 쪽|둘 중|판단/i.test(combined)
  const planSignal = /계획|acceptance|criterion|criteria|scope|범위|request|spec|설계|interface|contract|검증 계획/i.test(combined)

  if (clarificationSignal) {
    return 'needs_request_clarification' as const
  }

  if (decisionSignal) {
    return 'needs_decision' as const
  }

  if (trigger === 'plan_review_failed') {
    return 'retry_plan' as const
  }

  return planSignal ? ('restart_plan' as const) : ('restart_implement' as const)
}

function normalizeDecisionKind(
  trigger: CoordinatorTrigger,
  rawKind: string | undefined,
  failureSummary: string
): CoordinatorDecisionKind {
  const allowedKinds = new Set<CoordinatorDecisionKind>(getAllowedKinds(trigger))
  const preferredKind = rawKind?.trim() === 'retry_implement' ? 'restart_implement' : rawKind?.trim()
  const preferred = (preferredKind || fallbackKind(trigger, failureSummary)) as CoordinatorDecisionKind

  let normalizedKind: CoordinatorDecisionKind = allowedKinds.has(preferred)
    ? preferred
    : fallbackKind(trigger, failureSummary)

  return normalizedKind
}

function normalizeCoordinatorDecision(
  opts: CoordinateTicketFailureOptions,
  raw: RawCoordinatorDecision | undefined
): CoordinatorDecision {
  const kind = normalizeDecisionKind(
    opts.trigger,
    raw?.kind,
    opts.failureSummary
  )
  const rationale = raw?.rationale?.trim() || '조율 결과를 명확히 설명하지 못해 보수적인 복구 경로를 선택합니다.'
  const remediationNotes = raw?.remediationNotes?.trim() || opts.failureSummary.trim()
  const confidence =
    raw?.confidence === 'low' || raw?.confidence === 'medium' || raw?.confidence === 'high' ? raw.confidence : 'medium'

  return {
    kind,
    rationale,
    remediationNotes,
    confidence,
  }
}

export async function coordinateTicketFailure(
  opts: CoordinateTicketFailureOptions
): Promise<CoordinatorDecision | null> {
  const coordinatorConfig = loadConfig().flows.ticket.coordinator
  if (!coordinatorConfig?.enabled) {
    return null
  }

  const runTurn = opts.runCodexTurnImpl ?? runCodexTurn
  const prompt = buildCoordinatorPrompt(opts)
  const result = await runRecoverableCodexTurn<RawCoordinatorDecision>({
    prompt,
    recoveryStrategy: 'restart',
    onRecoveryState: (_label, _detail, reason) => {
      opts.onRecoveryState?.(reason)
    },
    promptFile: coordinatorConfig.promptFile,
    cwd: opts.ticket.worktree?.worktreePath ?? opts.ticket.projectPath,
    threadId: opts.threadId,
    model: coordinatorConfig.model,
    reasoningEffort: coordinatorConfig.reasoningEffort,
    serviceTier: coordinatorConfig.serviceTier ?? 'fast',
    sandboxMode: coordinatorConfig.sandboxMode ?? 'read-only',
    approvalPolicy: coordinatorConfig.approvalPolicy ?? 'never',
    networkAccessEnabled: coordinatorConfig.networkAccessEnabled ?? false,
    signal: opts.signal,
    outputSchema: TICKET_COORDINATOR_DECISION_SCHEMA,
    runTurn,
    onEvent: async (event) => {
      if (event.type === 'init' && typeof event.data.threadId === 'string') {
        opts.onThreadId?.(event.data.threadId)
      }
    },
  })

  if (result.threadId) {
    opts.onThreadId?.(result.threadId)
  }

  return normalizeCoordinatorDecision(opts, result.parsedOutput as RawCoordinatorDecision | undefined)
}
