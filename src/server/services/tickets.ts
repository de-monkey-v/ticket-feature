import { nanoid } from 'nanoid'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, resolve } from 'node:path'
import { resolveRuntimeDataPath } from '../lib/runtime-data-paths.js'

export type StepStatus =
  | 'pending'
  | 'running'
  | 'done'
  | 'awaiting_approval'
  | 'approved'
  | 'rejected'
  | 'failed'

export type TicketRunState =
  | 'created'
  | 'queued'
  | 'running'
  | 'stopped'
  | 'blocked'
  | 'needs_decision'
  | 'needs_request_clarification'
  | 'awaiting_merge'
  | 'completed'
  | 'discarded'
  | 'failed'

export type TicketRetryExecutionMode = 'same_run' | 'new_run'
export type TicketRetrySessionMode = 'reuse_thread' | 'new_thread'
export type VerificationCommandStage = 'scoped' | 'project'
export type TicketBlockingReason = 'external_verify_blocker'

export interface StepResult {
  status: StepStatus
  output: string
  startedAt?: string
  completedAt?: string
  cost?: number
  attempts?: number
}

export interface VerificationCommandResult {
  id: string
  label: string
  command: string
  stage: VerificationCommandStage
  required: boolean
  status: 'passed' | 'failed' | 'skipped'
  output: string
  exitCode?: number
  durationMs?: number
  startedAt: string
  completedAt: string
}

export interface VerificationFailureTestCase {
  suite: string
  name: string
  message: string
  path?: string
}

export interface VerificationDiagnosisCommand {
  id: string
  command: string
  exitCode?: number
  logPath?: string
}

export interface VerificationDiagnosis {
  kind: 'environment' | 'test_regression' | 'plan_misalignment' | 'external_blocker' | 'unknown'
  fingerprint: string
  summary: string
  failingTests: VerificationFailureTestCase[]
  failingCommands: VerificationDiagnosisCommand[]
  suspectedAreas: string[]
  recommendedRecovery: 'new_run_implement' | 'new_run_plan' | 'needs_decision'
}

export interface ScopedVerificationCommand {
  label: string
  command: string
  timeoutMs?: number
}

export interface ScopedVerificationPlan {
  rationale: string
  commands: ScopedVerificationCommand[]
}

export interface VerificationRun {
  attempt: number
  status: 'passed' | 'failed'
  commands: VerificationCommandResult[]
  diagnosis?: VerificationDiagnosis
  startedAt: string
  completedAt: string
}

export type GoalAlignmentStatus = 'aligned' | 'partial' | 'misaligned' | 'not_available'
export type AcceptanceCriterionStatus = 'met' | 'partial' | 'unmet'

export interface GoalAlignment {
  status: GoalAlignmentStatus
  evidence: string[]
}

export interface AcceptanceCriterionAssessment {
  criterion: string
  status: AcceptanceCriterionStatus
  evidence: string[]
}

export interface GoalAssessment {
  request: GoalAlignment
  ticket: GoalAlignment
  acceptanceCriteria: AcceptanceCriterionAssessment[]
}

export interface ReviewRun {
  attempt: number
  verdict: 'pass' | 'fail'
  summary: string
  goalAssessment: GoalAssessment
  blockingFindings: string[]
  residualRisks: string[]
  releaseNotes: string[]
  output: string
  startedAt: string
  completedAt: string
}

export interface StageReview {
  id: string
  subjectStepId: string
  label: string
  attempt: number
  verdict: 'pass' | 'fail'
  summary: string
  blockingFindings: string[]
  residualRisks: string[]
  output: string
  startedAt: string
  completedAt: string
}

export interface FinalReportQualityAssessment {
  correctness: 'low' | 'medium' | 'high'
  maintainability: 'low' | 'medium' | 'high'
  testConfidence: 'low' | 'medium' | 'high'
  risk: 'low' | 'medium' | 'high'
}

export interface FinalReport {
  summary: string
  changedAreas: string[]
  verificationSummary: string[]
  goalAssessment: GoalAssessment
  qualityAssessment: FinalReportQualityAssessment
  blockingFindings: string[]
  residualRisks: string[]
  mergeRecommendation: 'merge' | 'hold'
  output: string
  createdAt: string
}

export interface TicketTimelineEvent {
  id: string
  type: 'system' | 'phase' | 'review' | 'report'
  title: string
  body?: string
  stepId?: string
  attempt?: number
  status?: string
  createdAt: string
}

export interface TicketWorktree {
  branchName: string
  baseBranch: string
  baseCommit: string
  worktreePath: string
  headCommit?: string
  diffSummary?: string
  mergeCommit?: string
  status: 'pending' | 'ready' | 'merged' | 'discarded' | 'cleanup_failed'
  createdAt: string
  updatedAt: string
}

export interface PublicTicketWorktree {
  branchName: string
  baseBranch: string
  baseCommit: string
  headCommit?: string
  diffSummary?: string
  mergeCommit?: string
  status: 'pending' | 'ready' | 'merged' | 'discarded' | 'cleanup_failed'
  createdAt: string
  updatedAt: string
}

export interface TicketRepairLoop {
  gate: 'verify' | 'review' | 'merge'
  cycle: number
  status: 'repairing' | 'waiting_verify' | 'waiting_review'
  failureSummary: string
  startedAt: string
}

export interface TicketRunSummary {
  id: string
  status: TicketRunState
  currentPhase: string | null
  attemptCount: number
  createdAt: string
  updatedAt: string
}

export interface TicketQueuedExecution {
  startStepId: 'analyze' | 'plan' | 'implement' | 'verify' | 'review'
  recoveryNotes?: string
  queuedAt: string
}

export interface TicketRetryOption {
  id: string
  label: string
  startStepId: 'analyze' | 'plan' | 'implement'
  executionMode: TicketRetryExecutionMode
  sessionMode: TicketRetrySessionMode
}

export interface TicketRetryPlan extends TicketRetryOption {
  shouldCleanupWorktree: boolean
}

export interface TicketPlanningBlock {
  kind: 'needs_decision' | 'needs_request_clarification'
  source: 'plan_review' | 'review' | 'verify'
  summary: string
  findings: string[]
  options?: TicketRetryOption[]
}

export type TicketMergeIssueKind =
  | 'base_branch_changed'
  | 'base_commit_changed'
  | 'head_changed_after_review'
  | 'target_worktree_dirty'
  | 'merge_conflict'
  | 'rebase_conflict_text'
  | 'rebase_conflict_code'
  | 'rebase_failed'
  | 'unknown'

export type TicketMergeResolutionAction =
  | 'rebase_and_revalidate'
  | 'revalidate_current_worktree'
  | 'reapply_on_latest_base'
  | 'preserve_target_changes_and_reconcile'
  | 'restart_from_plan'
  | 'discard_worktree'

export interface TicketMergeOption {
  id: string
  label: string
  action: TicketMergeResolutionAction
  rationale: string
  recommended?: boolean
}

export interface TicketMergeContext {
  mode?: 'reapply_on_latest_base' | 'reconcile_target_worktree'
  analysisKey?: string
  currentBaseCommit?: string
  headCommit?: string
  conflictFiles: string[]
  lastAttemptedAction?: TicketMergeResolutionAction
  sourceRunId?: string
  sourceFinalReportOutput?: string
  sourceReadyOutput?: string
  sourceDiffSummary?: string
  sourceReviewedBaseCommit?: string
  sourceReviewedHeadCommit?: string
  targetBranchName?: string
  targetHeadCommit?: string
  safetyBranchName?: string
  safetyCommit?: string
  safetyDiffSummary?: string
  reconcileSeedApplied?: boolean
  reconcileSeedHeadCommit?: string
  supersededWorktree?: TicketWorktree
}

export interface TicketMergeBlock {
  issue: TicketMergeIssueKind
  errorMessage: string
  summary: string
  findings: string[]
  conflictFiles: string[]
  options: TicketMergeOption[]
  createdAt: string
  updatedAt: string
}

export interface TicketRun {
  id: string
  status: TicketRunState
  currentPhase: string | null
  planningThreadId: string | null
  implementationThreadId: string | null
  coordinatorThreadId: string | null
  attemptCount: number
  steps: Record<string, StepResult>
  verificationRuns: VerificationRun[]
  reviewRuns: ReviewRun[]
  stageReviews: StageReview[]
  finalReport?: FinalReport
  timeline: TicketTimelineEvent[]
  worktree?: TicketWorktree
  repairLoop?: TicketRepairLoop
  scopedVerification?: ScopedVerificationPlan
  createdAt: string
  updatedAt: string
}

export interface Ticket {
  id: string
  title: string
  description: string
  projectId: string
  projectPath: string
  categoryId: string
  flowStepIds: string[]
  linkedRequestId?: string
  blockedByTicketId?: string
  blockingReason?: TicketBlockingReason
  originTicketId?: string
  activeRunId: string | null
  runSummaries: TicketRunSummary[]
  status: TicketRunState
  runState: TicketRunState
  currentPhase: string | null
  recoveryRequired: boolean
  queuedExecution?: TicketQueuedExecution
  stopRequestedAt?: string
  planningBlock?: TicketPlanningBlock
  mergeBlock?: TicketMergeBlock
  mergeContext?: TicketMergeContext
  planningThreadId: string | null
  implementationThreadId: string | null
  coordinatorThreadId: string | null
  steps: Record<string, StepResult>
  attemptCount: number
  verificationRuns: VerificationRun[]
  reviewRuns: ReviewRun[]
  stageReviews: StageReview[]
  finalReport?: FinalReport
  timeline: TicketTimelineEvent[]
  worktree?: TicketWorktree
  repairLoop?: TicketRepairLoop
  scopedVerification?: ScopedVerificationPlan
  createdAt: string
  updatedAt: string
}

export interface PublicTicketSummary {
  id: string
  title: string
  projectId: string
  categoryId: string
  linkedRequestId?: string
  blockedByTicketId?: string
  blockingReason?: TicketBlockingReason
  originTicketId?: string
  status: TicketRunState
  runState: TicketRunState
  currentPhase: string | null
  recoveryRequired: boolean
  planningBlock?: TicketPlanningBlock
  mergeBlock?: TicketMergeBlock
  repairLoop?: TicketRepairLoop
  activeRunId: string | null
  runSummaries: TicketRunSummary[]
  createdAt: string
  updatedAt: string
}

export interface PublicTicketDetail extends PublicTicketSummary {
  description: string
  flowStepIds: string[]
}

export interface PublicVerificationCommandResult {
  id: string
  label: string
  command: string
  stage: VerificationCommandStage
  required: boolean
  status: 'passed' | 'failed' | 'skipped'
  outputExcerpt?: string
  truncated?: boolean
  exitCode?: number
  durationMs?: number
  startedAt: string
  completedAt: string
}

export interface PublicVerificationFailureTestCase {
  suite: string
  name: string
  message: string
  path?: string
}

export interface PublicVerificationDiagnosis {
  kind: VerificationDiagnosis['kind']
  summary: string
  failingTests: PublicVerificationFailureTestCase[]
}

export interface PublicVerificationRun {
  attempt: number
  status: 'passed' | 'failed'
  commands: PublicVerificationCommandResult[]
  diagnosis?: PublicVerificationDiagnosis
  startedAt: string
  completedAt: string
}

export interface PublicTicketRunDetail {
  id: string
  status: TicketRunState
  currentPhase: string | null
  attemptCount: number
  steps: Record<string, StepResult>
  verificationRuns: PublicVerificationRun[]
  reviewRuns: ReviewRun[]
  stageReviews: StageReview[]
  finalReport?: FinalReport
  timeline: TicketTimelineEvent[]
  worktree?: PublicTicketWorktree
  repairLoop?: TicketRepairLoop
  createdAt: string
  updatedAt: string
}

export interface TicketStreamEvent {
  type: 'init' | 'state' | 'step' | 'delta' | 'done' | 'error'
  data: Record<string, unknown>
}

interface PersistedStepResult {
  status: StepStatus
  startedAt?: string
  completedAt?: string
  cost?: number
  attempts?: number
  outputPath?: string
}

interface PersistedVerificationCommandResult {
  id: string
  label: string
  command: string
  stage?: VerificationCommandStage
  required: boolean
  status: 'passed' | 'failed' | 'skipped'
  outputPath?: string
  exitCode?: number
  durationMs?: number
  startedAt: string
  completedAt: string
}

interface PersistedVerificationRun {
  attempt: number
  status: 'passed' | 'failed'
  commands: PersistedVerificationCommandResult[]
  diagnosis?: VerificationDiagnosis
  startedAt: string
  completedAt: string
}

interface PersistedTicketRun {
  version: 2 | 3 | 4 | 5
  id: string
  status: TicketRunState
  currentPhase: string | null
  planningThreadId?: string | null
  implementationThreadId?: string | null
  coordinatorThreadId?: string | null
  threadId?: string | null
  attemptCount: number
  steps: Record<string, PersistedStepResult>
  verificationRuns: PersistedVerificationRun[]
  reviewRuns: ReviewRun[]
  stageReviews: StageReview[]
  finalReport?: FinalReport
  timeline: TicketTimelineEvent[]
  worktree?: TicketWorktree
  repairLoop?: TicketRepairLoop
  scopedVerification?: ScopedVerificationPlan
  createdAt: string
  updatedAt: string
}

interface PersistedTicketSummary {
  version: 2 | 3 | 4 | 5
  id: string
  title: string
  description: string
  projectId: string
  projectPath: string
  categoryId: string
  flowStepIds: string[]
  linkedRequestId?: string
  blockedByTicketId?: string
  blockingReason?: TicketBlockingReason
  originTicketId?: string
  activeRunId: string | null
  runSummaries: TicketRunSummary[]
  status: TicketRunState
  runState: TicketRunState
  currentPhase: string | null
  recoveryRequired: boolean
  queuedExecution?: TicketQueuedExecution
  stopRequestedAt?: string
  planningBlock?: TicketPlanningBlock
  mergeBlock?: TicketMergeBlock
  mergeContext?: TicketMergeContext
  repairLoop?: TicketRepairLoop
  scopedVerification?: ScopedVerificationPlan
  createdAt: string
  updatedAt: string
}

interface PersistedTicketStreamEvent {
  type: TicketStreamEvent['type']
  data: Record<string, unknown>
  createdAt: string
}

const tickets = new Map<string, Ticket>()
const ticketRuns = new Map<string, Map<string, TicketRun>>()
const listeners = new Map<string, Set<(event: TicketStreamEvent) => void>>()
const pendingFlushes = new Map<string, ReturnType<typeof setTimeout>>()
const STEP_FLUSH_DELAY_MS = 1_000

function getTicketsDir() {
  return resolveRuntimeDataPath('tickets')
}

function getProjectTicketsDir(projectId: string) {
  return resolve(getTicketsDir(), projectId)
}

function getTicketStorageDir(projectId: string, ticketId: string) {
  return resolve(getProjectTicketsDir(projectId), ticketId)
}

function getTicketRunsDir(projectId: string, ticketId: string) {
  return resolve(getTicketStorageDir(projectId, ticketId), 'runs')
}

function getRunStorageDir(projectId: string, ticketId: string, runId: string) {
  return resolve(getTicketRunsDir(projectId, ticketId), runId)
}

function buildTicketJsonPath(ticketId: string, projectId: string) {
  return resolve(getTicketStorageDir(projectId, ticketId), 'ticket.json')
}

function buildTicketMarkdownPath(ticketId: string, projectId: string) {
  return resolve(getTicketStorageDir(projectId, ticketId), 'ticket.md')
}

function buildRunJsonPath(ticketId: string, projectId: string, runId: string) {
  return resolve(getRunStorageDir(projectId, ticketId, runId), 'run.json')
}

function buildRunJournalPath(ticketId: string, projectId: string, runId: string) {
  return resolve(getRunStorageDir(projectId, ticketId, runId), 'events.ndjson')
}

function buildRunStepOutputPath(ticketId: string, projectId: string, runId: string, stepId: string) {
  return resolve(getRunStorageDir(projectId, ticketId, runId), 'steps', `${stepId}.md`)
}

function buildRunVerifyOutputPath(ticketId: string, projectId: string, runId: string, attempt: number, commandId: string) {
  return resolve(getRunStorageDir(projectId, ticketId, runId), 'diagnostics', 'verify', `${attempt}-${commandId}.log`)
}

function buildLegacyTicketJsonPath(ticketId: string) {
  return resolve(getTicketsDir(), `${ticketId}.json`)
}

function buildLegacyTicketMarkdownPath(ticketId: string) {
  return resolve(getTicketsDir(), `${ticketId}.md`)
}

function ensureDir(path: string) {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true })
  }
}

function writeAtomicFile(path: string, content: string) {
  ensureDir(dirname(path))
  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}-${nanoid(6)}`
  writeFileSync(tempPath, content, 'utf-8')
  renameSync(tempPath, path)
}

function readTextIfExists(path: string) {
  if (!existsSync(path)) {
    return ''
  }

  return readFileSync(path, 'utf-8')
}

function cloneStepResult(step?: StepResult): StepResult {
  if (!step) {
    return { status: 'pending', output: '' }
  }

  return {
    status: step.status,
    output: step.output ?? '',
    startedAt: step.startedAt,
    completedAt: step.completedAt,
    attempts: step.attempts,
    cost: step.cost,
  }
}

function cloneVerificationRuns(runs: VerificationRun[]) {
  return runs.map((run) => ({
    ...run,
    diagnosis: run.diagnosis ? normalizeVerificationDiagnosis(run.diagnosis) : undefined,
    commands: run.commands.map((command) => ({
      ...command,
      stage: command.stage,
      output: command.output,
    })),
  }))
}

function cloneReviewRuns(runs: ReviewRun[]) {
  return runs.map((run) => ({
    ...run,
    blockingFindings: [...run.blockingFindings],
    residualRisks: [...run.residualRisks],
    releaseNotes: [...run.releaseNotes],
    goalAssessment: normalizeGoalAssessment(run.goalAssessment),
  }))
}

function cloneStageReviews(reviews: StageReview[]) {
  return reviews.map((review) => ({
    ...review,
    blockingFindings: [...review.blockingFindings],
    residualRisks: [...review.residualRisks],
  }))
}

function cloneTimeline(timeline: TicketTimelineEvent[]) {
  return timeline.map((entry) => ({ ...entry }))
}

function cloneRunSummaries(runSummaries: TicketRunSummary[]) {
  return runSummaries.map((run) => ({ ...run }))
}

function cloneRepairLoop(repairLoop?: TicketRepairLoop) {
  if (!repairLoop) {
    return undefined
  }

  return {
    ...repairLoop,
  }
}

function cloneWorktree(worktree?: TicketWorktree) {
  if (!worktree) {
    return undefined
  }

  return {
    ...worktree,
  }
}

function cloneFinalReport(report?: FinalReport) {
  if (!report) {
    return undefined
  }

  return {
    ...report,
    changedAreas: [...report.changedAreas],
    verificationSummary: [...report.verificationSummary],
    blockingFindings: [...report.blockingFindings],
    residualRisks: [...report.residualRisks],
    goalAssessment: normalizeGoalAssessment(report.goalAssessment),
  }
}

function cloneSteps(steps: Record<string, StepResult>) {
  return Object.fromEntries(Object.entries(steps).map(([stepId, step]) => [stepId, cloneStepResult(step)]))
}

function cloneScopedVerificationPlan(plan: ScopedVerificationPlan | undefined) {
  if (!plan) {
    return undefined
  }

  return {
    rationale: plan.rationale,
    commands: plan.commands.map((command) => ({
      label: command.label,
      command: command.command,
      timeoutMs: command.timeoutMs,
    })),
  }
}

function resolvePlanningThreadId(raw: {
  planningThreadId?: string | null
  threadId?: string | null
}) {
  return raw.planningThreadId ?? raw.threadId ?? null
}

function resolveImplementationThreadId(raw: {
  implementationThreadId?: string | null
  threadId?: string | null
}) {
  return raw.implementationThreadId ?? raw.threadId ?? null
}

function resolveCoordinatorThreadId(raw: {
  coordinatorThreadId?: string | null
}) {
  return raw.coordinatorThreadId ?? null
}

function cloneRun(run: TicketRun): TicketRun {
  return {
    id: run.id,
    status: run.status,
    currentPhase: run.currentPhase,
    planningThreadId: run.planningThreadId,
    implementationThreadId: run.implementationThreadId,
    coordinatorThreadId: run.coordinatorThreadId,
    attemptCount: run.attemptCount,
    steps: cloneSteps(run.steps),
    verificationRuns: cloneVerificationRuns(run.verificationRuns),
    reviewRuns: cloneReviewRuns(run.reviewRuns),
    stageReviews: cloneStageReviews(run.stageReviews),
    finalReport: cloneFinalReport(run.finalReport),
    timeline: cloneTimeline(run.timeline),
    worktree: cloneWorktree(run.worktree),
    repairLoop: cloneRepairLoop(run.repairLoop),
    scopedVerification: cloneScopedVerificationPlan(run.scopedVerification),
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  }
}

export function createDefaultGoalAssessment(): GoalAssessment {
  return {
    request: {
      status: 'not_available',
      evidence: [],
    },
    ticket: {
      status: 'aligned',
      evidence: [],
    },
    acceptanceCriteria: [],
  }
}

function normalizeGoalAlignment(raw?: Partial<GoalAlignment>, fallbackStatus: GoalAlignmentStatus = 'not_available'): GoalAlignment {
  return {
    status: raw?.status ?? fallbackStatus,
    evidence: raw?.evidence ?? [],
  }
}

function normalizeGoalAssessment(raw?: Partial<GoalAssessment>): GoalAssessment {
  const fallback = createDefaultGoalAssessment()

  return {
    request: normalizeGoalAlignment(raw?.request, fallback.request.status),
    ticket: normalizeGoalAlignment(raw?.ticket, fallback.ticket.status),
    acceptanceCriteria:
      raw?.acceptanceCriteria?.map((entry) => ({
        criterion: entry.criterion,
        status: entry.status,
        evidence: entry.evidence ?? [],
      })) ?? [],
  }
}

function normalizeVerificationDiagnosis(raw?: VerificationDiagnosis): VerificationDiagnosis | undefined {
  if (!raw) {
    return undefined
  }

  return {
    ...raw,
    failingTests: raw.failingTests?.map((entry) => ({ ...entry })) ?? [],
    failingCommands: raw.failingCommands?.map((entry) => ({ ...entry })) ?? [],
    suspectedAreas: [...(raw.suspectedAreas ?? [])],
  }
}

function normalizeVerificationRuns(runs?: VerificationRun[]) {
  return runs?.map((run) => ({
    ...run,
    diagnosis: normalizeVerificationDiagnosis(run.diagnosis),
    commands: run.commands.map((command) => ({
      ...command,
      stage: command.stage ?? 'project',
      output: command.output ?? '',
    })),
  })) ?? []
}

function normalizeReviewRuns(runs?: ReviewRun[]) {
  return runs?.map((run) => ({
    ...run,
    blockingFindings: run.blockingFindings ?? [],
    residualRisks: run.residualRisks ?? [],
    releaseNotes: run.releaseNotes ?? [],
    goalAssessment: normalizeGoalAssessment(run.goalAssessment),
  })) ?? []
}

function normalizeStageReviews(reviews?: StageReview[]) {
  return reviews?.map((review) => ({
    ...review,
    blockingFindings: review.blockingFindings ?? [],
    residualRisks: review.residualRisks ?? [],
  })) ?? []
}

function normalizeRunSummaries(runSummaries?: TicketRunSummary[]) {
  return runSummaries?.map((run) => ({
    ...run,
    currentPhase: run.currentPhase ?? null,
    attemptCount: run.attemptCount ?? 0,
  })) ?? []
}

function formatList(items: string[]) {
  return items.length > 0 ? items.map((item) => `- ${item}`).join('\n') : '- 없음'
}

function formatTicketTimeline(ticket: TicketRun) {
  if (ticket.timeline.length === 0) {
    return ''
  }

  const timeline = ticket.timeline
    .map((entry) => {
      const lines = [`- [${entry.createdAt}] ${entry.title}`]
      if (entry.body) {
        lines.push(`  ${entry.body.replace(/\n/g, '\n  ')}`)
      }
      return lines.join('\n')
    })
    .join('\n')

  return `\n## Timeline\n\n${timeline}\n`
}

function buildTicketMarkdown(ticket: Ticket) {
  const lines = [
    `# ${ticket.id}: ${ticket.title}`,
    '',
    `**Status**: ${ticket.status}`,
    `**Run State**: ${ticket.runState}`,
    `**Current Phase**: ${ticket.currentPhase ?? '없음'}`,
    `**Recovery Required**: ${ticket.recoveryRequired ? 'yes' : 'no'}`,
    `**Created**: ${ticket.createdAt}`,
    `**Updated**: ${ticket.updatedAt}`,
    `**Project ID**: ${ticket.projectId}`,
    `**Category**: ${ticket.categoryId}`,
    `**Blocked By Ticket**: ${ticket.blockedByTicketId ?? '없음'}`,
    `**Blocking Reason**: ${ticket.blockingReason ?? '없음'}`,
    `**Origin Ticket**: ${ticket.originTicketId ?? '없음'}`,
    `**Flow Steps**: ${ticket.flowStepIds.join(', ')}`,
    `**Project**: ${ticket.projectPath}`,
    `**Active Run**: ${ticket.activeRunId ?? '없음'}`,
    `**Repair Loop**: ${
      ticket.repairLoop
        ? `${ticket.repairLoop.gate} cycle=${ticket.repairLoop.cycle} status=${ticket.repairLoop.status}`
        : '없음'
    }`,
    '',
    '## Description',
    '',
    ticket.description,
    '',
    '## Runs',
    '',
    ...ticket.runSummaries.map(
      (run) =>
        `- ${run.id} | status=${run.status} | phase=${run.currentPhase ?? '없음'} | attempts=${run.attemptCount} | updated=${run.updatedAt}`
    ),
  ]

  return `${lines.join('\n')}\n`
}

function buildRunMarkdown(run: TicketRun, flowStepIds: string[]) {
  let content = `# ${run.id}\n\n`
  content += `**Status**: ${run.status}\n`
  content += `**Current Phase**: ${run.currentPhase ?? '없음'}\n`
  content += `**Attempts**: ${run.attemptCount}\n`
  content += `**Created**: ${run.createdAt}\n`
  content += `**Updated**: ${run.updatedAt}\n`
  if (run.worktree) {
    content += `**Worktree Branch**: ${run.worktree.branchName}\n`
    content += `**Worktree Base Branch**: ${run.worktree.baseBranch}\n`
    content += `**Worktree Base Commit**: ${run.worktree.baseCommit}\n`
    content += `**Worktree Path**: ${run.worktree.worktreePath}\n`
    content += `**Worktree Status**: ${run.worktree.status}\n`
  }
  if (run.repairLoop) {
    content += `**Repair Loop**: ${run.repairLoop.gate} cycle=${run.repairLoop.cycle} status=${run.repairLoop.status}\n`
  }
  if (run.scopedVerification?.commands.length) {
    content += `**Scoped Verification**: ${run.scopedVerification.commands.map((command) => command.command).join(' | ')}\n`
  }

  for (const stepId of flowStepIds) {
    const step = run.steps[stepId]
    if (!step) {
      continue
    }

    content += `\n## Step: ${stepId} (${step.status})\n`
    if (step.attempts) content += `Attempts: ${step.attempts}\n`
    if (step.startedAt) content += `Started: ${step.startedAt}`
    if (step.completedAt) content += ` | Completed: ${step.completedAt}`
    if (step.startedAt) content += '\n'
    if (step.output) content += `\n${step.output}\n`
  }

  if (run.stageReviews.length > 0) {
    content += '\n## Stage Reviews\n'
    for (const review of run.stageReviews) {
      content += `\n### ${review.label} (${review.verdict})\n`
      content += `${review.output}\n`
    }
  }

  if (run.verificationRuns.length > 0) {
    content += '\n## Verification Runs\n'
    for (const verificationRun of run.verificationRuns) {
      content += `\n### Attempt ${verificationRun.attempt} (${verificationRun.status})\n`
      for (const command of verificationRun.commands) {
        content += `\n- ${command.label} [${command.status}]`
        content += `\n  Stage: ${command.stage}`
        content += `\n  Command: ${command.command}`
        if (command.exitCode != null) {
          content += `\n  Exit code: ${command.exitCode}`
        }
        if (command.durationMs != null) {
          content += `\n  Duration: ${command.durationMs}ms`
        }
      }
      content += '\n'
    }
  }

  if (run.reviewRuns.length > 0) {
    content += '\n## Code Reviews\n'
    for (const reviewRun of run.reviewRuns) {
      content += `\n### Attempt ${reviewRun.attempt} (${reviewRun.verdict})\n`
      content += `${reviewRun.output}\n`
    }
  }

  if (run.finalReport) {
    content += `\n## Final Report\n\n${run.finalReport.output}\n`
  }

  if (run.worktree?.diffSummary) {
    content += `\n## Worktree Diff Summary\n\n${run.worktree.diffSummary}\n`
  }

  content += formatTicketTimeline(run)

  return content
}

function buildRunSummary(run: TicketRun): TicketRunSummary {
  return {
    id: run.id,
    status: run.status,
    currentPhase: run.currentPhase,
    attemptCount: run.attemptCount,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  }
}

function buildRunFromTicket(ticket: Ticket): TicketRun {
  const now = ticket.createdAt

  return {
    id: ticket.activeRunId ?? nextRunId(ticket.runSummaries),
    status: ticket.runState,
    currentPhase: ticket.currentPhase,
    planningThreadId: ticket.planningThreadId,
    implementationThreadId: ticket.implementationThreadId,
    coordinatorThreadId: ticket.coordinatorThreadId,
    attemptCount: ticket.attemptCount,
    steps: ticket.steps,
    verificationRuns: ticket.verificationRuns,
    reviewRuns: ticket.reviewRuns,
    stageReviews: ticket.stageReviews,
    finalReport: ticket.finalReport,
    timeline: ticket.timeline,
    worktree: ticket.worktree,
    repairLoop: ticket.repairLoop,
    scopedVerification: ticket.scopedVerification,
    createdAt: now,
    updatedAt: ticket.updatedAt,
  }
}

function nextRunId(existing: TicketRunSummary[]) {
  const max = existing.reduce((current, run) => {
    const match = /^run-(\d+)$/.exec(run.id)
    if (!match) {
      return current
    }

    return Math.max(current, Number.parseInt(match[1], 10))
  }, 0)

  return `run-${String(max + 1).padStart(3, '0')}`
}

function getRunMap(ticketId: string) {
  return ticketRuns.get(ticketId)
}

function getActiveRun(ticket: Ticket) {
  const runs = getRunMap(ticket.id)
  if (!runs || !ticket.activeRunId) {
    return undefined
  }

  return runs.get(ticket.activeRunId)
}

function syncActiveRun(ticket: Ticket) {
  const runs = ticketRuns.get(ticket.id)
  if (!runs || !ticket.activeRunId) {
    return
  }

  const run = runs.get(ticket.activeRunId)
  if (!run) {
    return
  }

  run.status = ticket.runState
  run.currentPhase = ticket.currentPhase
  run.planningThreadId = ticket.planningThreadId
  run.implementationThreadId = ticket.implementationThreadId
  run.coordinatorThreadId = ticket.coordinatorThreadId
  run.attemptCount = ticket.attemptCount
  run.steps = ticket.steps
  run.verificationRuns = ticket.verificationRuns
  run.reviewRuns = ticket.reviewRuns
  run.stageReviews = ticket.stageReviews
  run.finalReport = ticket.finalReport
  run.timeline = ticket.timeline
  run.worktree = ticket.worktree
  run.repairLoop = ticket.repairLoop
  run.scopedVerification = ticket.scopedVerification
  run.updatedAt = ticket.updatedAt

  const summary = ticket.runSummaries.find((entry) => entry.id === ticket.activeRunId)
  if (summary) {
    summary.status = ticket.runState
    summary.currentPhase = ticket.currentPhase
    summary.attemptCount = ticket.attemptCount
    summary.updatedAt = ticket.updatedAt
  }
}

function flushTicket(ticketId: string) {
  const pending = pendingFlushes.get(ticketId)
  if (pending) {
    clearTimeout(pending)
    pendingFlushes.delete(ticketId)
  }

  const ticket = tickets.get(ticketId)
  if (!ticket) {
    return
  }

  saveTicketToDisk(ticket)
}

function scheduleTicketFlush(ticketId: string) {
  if (pendingFlushes.has(ticketId)) {
    return
  }

  const timer = setTimeout(() => {
    pendingFlushes.delete(ticketId)
    flushTicket(ticketId)
  }, STEP_FLUSH_DELAY_MS)
  pendingFlushes.set(ticketId, timer)
}

function ensureTicketsDir(projectId?: string) {
  ensureDir(getTicketsDir())
  if (projectId) {
    ensureDir(getProjectTicketsDir(projectId))
  }
}

function toPersistedTicketSummary(ticket: Ticket): PersistedTicketSummary {
  return {
    version: 5,
    id: ticket.id,
    title: ticket.title,
    description: ticket.description,
    projectId: ticket.projectId,
    projectPath: ticket.projectPath,
    categoryId: ticket.categoryId,
    flowStepIds: [...ticket.flowStepIds],
    linkedRequestId: ticket.linkedRequestId,
    blockedByTicketId: ticket.blockedByTicketId,
    blockingReason: ticket.blockingReason,
    originTicketId: ticket.originTicketId,
    activeRunId: ticket.activeRunId,
    runSummaries: cloneRunSummaries(ticket.runSummaries),
    status: ticket.status,
    runState: ticket.runState,
    currentPhase: ticket.currentPhase,
    recoveryRequired: ticket.recoveryRequired,
    queuedExecution: ticket.queuedExecution ? { ...ticket.queuedExecution } : undefined,
    stopRequestedAt: ticket.stopRequestedAt,
    planningBlock: ticket.planningBlock
      ? {
          ...ticket.planningBlock,
          findings: [...ticket.planningBlock.findings],
          options: cloneRetryOptions(ticket.planningBlock.options),
        }
      : undefined,
    mergeBlock: cloneMergeBlock(ticket.mergeBlock),
    mergeContext: cloneMergeContext(ticket.mergeContext),
    repairLoop: cloneRepairLoop(ticket.repairLoop),
    scopedVerification: cloneScopedVerificationPlan(ticket.scopedVerification),
    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt,
  }
}

function toPersistedTicketRun(ticket: Ticket, run: TicketRun): PersistedTicketRun {
  const steps = Object.fromEntries(
    Object.entries(run.steps).map(([stepId, step]) => {
      const outputPath = step.output ? `steps/${stepId}.md` : undefined
      return [
        stepId,
        {
          status: step.status,
          startedAt: step.startedAt,
          completedAt: step.completedAt,
          attempts: step.attempts,
          cost: step.cost,
          outputPath,
        } satisfies PersistedStepResult,
      ]
    })
  )

  const verificationRuns = run.verificationRuns.map((verificationRun) => ({
    attempt: verificationRun.attempt,
    status: verificationRun.status,
    diagnosis: verificationRun.diagnosis ? normalizeVerificationDiagnosis(verificationRun.diagnosis) : undefined,
    startedAt: verificationRun.startedAt,
    completedAt: verificationRun.completedAt,
    commands: verificationRun.commands.map((command) => ({
      id: command.id,
      label: command.label,
      command: command.command,
      stage: command.stage,
      required: command.required,
      status: command.status,
      outputPath: command.output ? `diagnostics/verify/${verificationRun.attempt}-${command.id}.log` : undefined,
      exitCode: command.exitCode,
      durationMs: command.durationMs,
      startedAt: command.startedAt,
      completedAt: command.completedAt,
    })),
  }))

  return {
    version: 5,
    id: run.id,
    status: run.status,
    currentPhase: run.currentPhase,
    planningThreadId: run.planningThreadId,
    implementationThreadId: run.implementationThreadId,
    coordinatorThreadId: run.coordinatorThreadId,
    attemptCount: run.attemptCount,
    steps,
    verificationRuns,
    reviewRuns: cloneReviewRuns(run.reviewRuns),
    stageReviews: cloneStageReviews(run.stageReviews),
    finalReport: cloneFinalReport(run.finalReport),
    timeline: cloneTimeline(run.timeline),
    worktree: cloneWorktree(run.worktree),
    repairLoop: cloneRepairLoop(run.repairLoop),
    scopedVerification: cloneScopedVerificationPlan(run.scopedVerification),
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  }
}

function writeRunArtifacts(ticket: Ticket, run: TicketRun) {
  for (const [stepId, step] of Object.entries(run.steps)) {
    const outputPath = buildRunStepOutputPath(ticket.id, ticket.projectId, run.id, stepId)
    if (step.output) {
      writeAtomicFile(outputPath, step.output)
      continue
    }

    if (existsSync(outputPath)) {
      unlinkSync(outputPath)
    }
  }

  for (const verificationRun of run.verificationRuns) {
    for (const command of verificationRun.commands) {
      const outputPath = buildRunVerifyOutputPath(ticket.id, ticket.projectId, run.id, verificationRun.attempt, command.id)
      if (command.output) {
        writeAtomicFile(outputPath, command.output)
        continue
      }

      if (existsSync(outputPath)) {
        unlinkSync(outputPath)
      }
    }
  }
}

function preserveConcurrentStopRequest(ticket: Ticket, summary: PersistedTicketSummary) {
  if (summary.stopRequestedAt || (summary.runState !== 'running' && summary.runState !== 'queued')) {
    return
  }

  const summaryPath = buildTicketJsonPath(ticket.id, ticket.projectId)
  if (!existsSync(summaryPath)) {
    return
  }

  try {
    const persisted = JSON.parse(readFileSync(summaryPath, 'utf-8')) as PersistedTicketSummary
    if (persisted.stopRequestedAt) {
      summary.stopRequestedAt = persisted.stopRequestedAt
    }
  } catch (error) {
    console.warn(`Failed to preserve concurrent stop request for ticket ${ticket.id}:`, error)
  }
}

function saveTicketToDisk(ticket: Ticket) {
  syncActiveRun(ticket)
  ensureTicketsDir(ticket.projectId)

  const ticketStorageDir = getTicketStorageDir(ticket.projectId, ticket.id)
  ensureDir(ticketStorageDir)
  const summary = toPersistedTicketSummary(ticket)
  preserveConcurrentStopRequest(ticket, summary)
  writeAtomicFile(buildTicketJsonPath(ticket.id, ticket.projectId), JSON.stringify(summary, null, 2))
  writeAtomicFile(buildTicketMarkdownPath(ticket.id, ticket.projectId), buildTicketMarkdown(ticket))

  const runs = ticketRuns.get(ticket.id) ?? new Map<string, TicketRun>()
  for (const run of runs.values()) {
    writeRunArtifacts(ticket, run)
    const runJson = toPersistedTicketRun(ticket, run)
    writeAtomicFile(buildRunJsonPath(ticket.id, ticket.projectId, run.id), JSON.stringify(runJson, null, 2))
    writeAtomicFile(resolve(getRunStorageDir(ticket.projectId, ticket.id, run.id), 'run.md'), buildRunMarkdown(run, ticket.flowStepIds))
  }

  const legacyJsonPath = buildLegacyTicketJsonPath(ticket.id)
  const legacyMarkdownPath = buildLegacyTicketMarkdownPath(ticket.id)
  if (existsSync(legacyJsonPath)) {
    unlinkSync(legacyJsonPath)
  }
  if (existsSync(legacyMarkdownPath)) {
    unlinkSync(legacyMarkdownPath)
  }
}

function createEmptySteps(flowStepIds: string[]): Record<string, StepResult> {
  return Object.fromEntries(flowStepIds.map((stepId) => [stepId, { status: 'pending', output: '' } satisfies StepResult]))
}

function createRun(ticket: Ticket, runId: string, now: string): TicketRun {
  return {
    id: runId,
    status: ticket.runState,
    currentPhase: ticket.currentPhase,
    planningThreadId: ticket.planningThreadId,
    implementationThreadId: ticket.implementationThreadId,
    coordinatorThreadId: ticket.coordinatorThreadId,
    attemptCount: ticket.attemptCount,
    steps: ticket.steps,
    verificationRuns: ticket.verificationRuns,
    reviewRuns: ticket.reviewRuns,
    stageReviews: ticket.stageReviews,
    finalReport: ticket.finalReport,
    timeline: ticket.timeline,
    worktree: ticket.worktree,
    repairLoop: ticket.repairLoop,
    scopedVerification: ticket.scopedVerification,
    createdAt: now,
    updatedAt: now,
  }
}

function cloneCarryOverRun(source: TicketRun, ticket: Ticket, startStepId: TicketRetryPlan['startStepId'], runId: string, now: string) {
  const carrySteps = createEmptySteps(ticket.flowStepIds)
  const copyStepIds =
    startStepId === 'implement'
      ? ticket.flowStepIds.filter((stepId) => !['implement', 'verify', 'review', 'ready'].includes(stepId))
      : startStepId === 'plan'
        ? ticket.flowStepIds.filter((stepId) => !['plan', 'implement', 'verify', 'review', 'ready'].includes(stepId))
        : []

  for (const stepId of copyStepIds) {
    carrySteps[stepId] = cloneStepResult(source.steps[stepId])
  }

  const stageReviews =
    startStepId === 'implement'
      ? cloneStageReviews(source.stageReviews.filter((review) => review.subjectStepId === 'analyze' || review.subjectStepId === 'plan'))
      : startStepId === 'plan'
        ? cloneStageReviews(source.stageReviews.filter((review) => review.subjectStepId === 'analyze'))
        : []

  return {
    id: runId,
    status: 'created' as TicketRunState,
    currentPhase: startStepId,
    planningThreadId: source.planningThreadId,
    implementationThreadId: null,
    coordinatorThreadId: source.coordinatorThreadId,
    attemptCount: 0,
    steps: carrySteps,
    verificationRuns: [],
    reviewRuns: [],
    stageReviews,
    finalReport: undefined,
    timeline: [],
    worktree: undefined,
    repairLoop: undefined,
    scopedVerification: startStepId === 'implement' ? cloneScopedVerificationPlan(source.scopedVerification) : undefined,
    createdAt: now,
    updatedAt: now,
  }
}

function cloneRetryOptions(options: TicketRetryOption[] | undefined) {
  return options?.map((option) => ({ ...option }))
}

function cloneMergeOptions(options: TicketMergeOption[] | undefined) {
  return options?.map((option) => ({ ...option }))
}

function cloneMergeContext(context: TicketMergeContext | undefined) {
  if (!context) {
    return undefined
  }

  return {
    ...context,
    conflictFiles: [...(context.conflictFiles ?? [])],
    supersededWorktree: context.supersededWorktree ? { ...context.supersededWorktree } : undefined,
  }
}

function cloneMergeBlock(block: TicketMergeBlock | undefined) {
  if (!block) {
    return undefined
  }

  return {
    ...block,
    findings: [...block.findings],
    conflictFiles: [...(block.conflictFiles ?? [])],
    options: cloneMergeOptions(block.options) ?? [],
  }
}

function loadPersistedRun(ticketSummary: PersistedTicketSummary, runId: string) {
  const runDir = getRunStorageDir(ticketSummary.projectId, ticketSummary.id, runId)
  const runJsonPath = buildRunJsonPath(ticketSummary.id, ticketSummary.projectId, runId)
  const rawRun = JSON.parse(readFileSync(runJsonPath, 'utf-8')) as PersistedTicketRun

  const steps = Object.fromEntries(
    Object.entries(rawRun.steps).map(([stepId, step]) => [
      stepId,
      {
        status: step.status,
        output: step.outputPath ? readTextIfExists(resolve(runDir, step.outputPath)) : '',
        startedAt: step.startedAt,
        completedAt: step.completedAt,
        attempts: step.attempts,
        cost: step.cost,
      } satisfies StepResult,
    ])
  )

  const verificationRuns = rawRun.verificationRuns.map((verificationRun) => ({
    attempt: verificationRun.attempt,
    status: verificationRun.status,
    diagnosis: normalizeVerificationDiagnosis(verificationRun.diagnosis),
    startedAt: verificationRun.startedAt,
    completedAt: verificationRun.completedAt,
    commands: verificationRun.commands.map((command) => ({
      id: command.id,
      label: command.label,
      command: command.command,
      stage: command.stage ?? 'project',
      required: command.required,
      status: command.status,
      output: command.outputPath ? readTextIfExists(resolve(runDir, command.outputPath)) : '',
      exitCode: command.exitCode,
      durationMs: command.durationMs,
      startedAt: command.startedAt,
      completedAt: command.completedAt,
    })),
  }))

  return {
    id: rawRun.id,
    status: rawRun.status ?? 'created',
    currentPhase: rawRun.currentPhase ?? null,
    planningThreadId: resolvePlanningThreadId(rawRun),
    implementationThreadId: resolveImplementationThreadId(rawRun),
    coordinatorThreadId: resolveCoordinatorThreadId(rawRun),
    attemptCount: rawRun.attemptCount ?? 0,
    steps,
    verificationRuns,
    reviewRuns: normalizeReviewRuns(rawRun.reviewRuns),
    stageReviews: normalizeStageReviews(rawRun.stageReviews),
    finalReport: rawRun.finalReport ? cloneFinalReport(rawRun.finalReport) : undefined,
    timeline: rawRun.timeline ?? [],
    worktree: rawRun.worktree,
    repairLoop: cloneRepairLoop(rawRun.repairLoop),
    scopedVerification: cloneScopedVerificationPlan(rawRun.scopedVerification),
    createdAt: rawRun.createdAt,
    updatedAt: rawRun.updatedAt,
  } satisfies TicketRun
}

function loadTicketFromStorage(ticketDir: string) {
  const summaryPath = resolve(ticketDir, 'ticket.json')
  const rawSummary = JSON.parse(readFileSync(summaryPath, 'utf-8')) as PersistedTicketSummary
  const runSummaries = normalizeRunSummaries(rawSummary.runSummaries)
  const runs = new Map<string, TicketRun>()

  for (const runSummary of runSummaries) {
    const run = loadPersistedRun(rawSummary, runSummary.id)
    runs.set(run.id, run)
  }

  const activeRun =
    (rawSummary.activeRunId ? runs.get(rawSummary.activeRunId) : undefined) ??
    (runSummaries.at(-1)?.id ? runs.get(runSummaries.at(-1)?.id as string) : undefined)

  const ticket: Ticket = {
    id: rawSummary.id,
    title: rawSummary.title,
    description: rawSummary.description,
    projectId: rawSummary.projectId,
    projectPath: rawSummary.projectPath,
    categoryId: rawSummary.categoryId,
    flowStepIds: rawSummary.flowStepIds,
    linkedRequestId: rawSummary.linkedRequestId,
    blockedByTicketId: rawSummary.blockedByTicketId,
    blockingReason: rawSummary.blockingReason,
    originTicketId: rawSummary.originTicketId,
    activeRunId: activeRun?.id ?? rawSummary.activeRunId ?? null,
    runSummaries,
    status: rawSummary.status ?? rawSummary.runState ?? activeRun?.status ?? 'created',
    runState: rawSummary.runState ?? rawSummary.status ?? activeRun?.status ?? 'created',
    currentPhase: rawSummary.currentPhase ?? activeRun?.currentPhase ?? null,
    recoveryRequired: rawSummary.recoveryRequired ?? false,
    queuedExecution: rawSummary.queuedExecution
      ? {
          startStepId: rawSummary.queuedExecution.startStepId,
          recoveryNotes: rawSummary.queuedExecution.recoveryNotes,
          queuedAt: rawSummary.queuedExecution.queuedAt,
        }
      : undefined,
    stopRequestedAt: rawSummary.stopRequestedAt,
    planningBlock: rawSummary.planningBlock,
    mergeBlock: rawSummary.mergeBlock,
    mergeContext: rawSummary.mergeContext,
    repairLoop: cloneRepairLoop(rawSummary.repairLoop ?? activeRun?.repairLoop),
    planningThreadId: activeRun?.planningThreadId ?? null,
    implementationThreadId: activeRun?.implementationThreadId ?? null,
    coordinatorThreadId: activeRun?.coordinatorThreadId ?? null,
    steps: activeRun?.steps ?? createEmptySteps(rawSummary.flowStepIds),
    attemptCount: activeRun?.attemptCount ?? 0,
    verificationRuns: activeRun?.verificationRuns ?? [],
    reviewRuns: activeRun?.reviewRuns ?? [],
    stageReviews: activeRun?.stageReviews ?? [],
    finalReport: activeRun?.finalReport,
    timeline: activeRun?.timeline ?? [],
    worktree: activeRun?.worktree,
    scopedVerification: cloneScopedVerificationPlan(activeRun?.scopedVerification ?? rawSummary.scopedVerification),
    createdAt: rawSummary.createdAt,
    updatedAt: rawSummary.updatedAt,
  }

  syncActiveRun(ticket)
  tickets.set(ticket.id, ticket)
  ticketRuns.set(ticket.id, runs)
}

function normalizeLegacyTicket(
  raw: Partial<Ticket> & {
    threadId?: string | null
  } &
    Pick<Ticket, 'id' | 'title' | 'description' | 'projectId' | 'projectPath' | 'categoryId' | 'flowStepIds' | 'createdAt' | 'updatedAt'>
): Ticket {
  const steps = Object.fromEntries(
    raw.flowStepIds.map((stepId) => [stepId, cloneStepResult(raw.steps?.[stepId])])
  )
  const runId = raw.activeRunId ?? 'run-001'
  const runSummaries =
    raw.runSummaries && raw.runSummaries.length > 0
      ? normalizeRunSummaries(raw.runSummaries)
      : [
          {
            id: runId,
            status: raw.runState ?? raw.status ?? 'created',
            currentPhase: raw.currentPhase ?? null,
            attemptCount: raw.attemptCount ?? 0,
            createdAt: raw.createdAt,
            updatedAt: raw.updatedAt,
          },
        ]

  return {
    id: raw.id,
    title: raw.title,
    description: raw.description,
    projectId: raw.projectId,
    projectPath: raw.projectPath,
    categoryId: raw.categoryId,
    flowStepIds: raw.flowStepIds,
    linkedRequestId: raw.linkedRequestId,
    blockedByTicketId: raw.blockedByTicketId,
    blockingReason: raw.blockingReason,
    originTicketId: raw.originTicketId,
    activeRunId: runId,
    runSummaries,
    status: raw.status ?? raw.runState ?? 'created',
    runState: raw.runState ?? raw.status ?? 'created',
    currentPhase: raw.currentPhase ?? null,
    recoveryRequired: raw.recoveryRequired ?? false,
    planningBlock: raw.planningBlock,
    mergeBlock: raw.mergeBlock,
    mergeContext: raw.mergeContext,
    planningThreadId: resolvePlanningThreadId(raw),
    implementationThreadId: resolveImplementationThreadId(raw),
    coordinatorThreadId: resolveCoordinatorThreadId(raw),
    steps,
    attemptCount: raw.attemptCount ?? 0,
    verificationRuns: normalizeVerificationRuns(raw.verificationRuns),
    reviewRuns: normalizeReviewRuns(raw.reviewRuns),
    stageReviews: normalizeStageReviews(raw.stageReviews),
    finalReport: raw.finalReport ? cloneFinalReport(raw.finalReport) : undefined,
    timeline: raw.timeline ?? [],
    worktree: raw.worktree,
    repairLoop: cloneRepairLoop(raw.repairLoop),
    scopedVerification: cloneScopedVerificationPlan(raw.scopedVerification),
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  }
}

function migrateLegacyTicketFile(filepath: string) {
  const raw = JSON.parse(readFileSync(filepath, 'utf-8')) as Ticket
  const ticket = normalizeLegacyTicket(raw)
  const newSummaryPath = buildTicketJsonPath(ticket.id, ticket.projectId)
  if (existsSync(newSummaryPath)) {
    return
  }

  const run = buildRunFromTicket(ticket)
  run.id = ticket.activeRunId ?? 'run-001'
  run.status = ticket.runState
  run.currentPhase = ticket.currentPhase
  run.createdAt = ticket.createdAt
  run.updatedAt = ticket.updatedAt
  ticket.runSummaries = [
    {
      id: run.id,
      status: run.status,
      currentPhase: run.currentPhase,
      attemptCount: run.attemptCount,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
    },
  ]
  ticket.activeRunId = run.id
  tickets.set(ticket.id, ticket)
  ticketRuns.set(ticket.id, new Map([[run.id, run]]))
  saveTicketToDisk(ticket)
  tickets.delete(ticket.id)
  ticketRuns.delete(ticket.id)

  const legacyMarkdown = filepath.replace(/\.json$/, '.md')
  if (existsSync(filepath)) {
    unlinkSync(filepath)
  }
  if (existsSync(legacyMarkdown)) {
    unlinkSync(legacyMarkdown)
  }
}

function migrateLegacyTicketsFromDisk() {
  const ticketsDir = getTicketsDir()

  ensureTicketsDir()

  for (const entry of readdirSync(ticketsDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.json')) {
      migrateLegacyTicketFile(resolve(ticketsDir, entry.name))
      continue
    }

    if (!entry.isDirectory()) {
      continue
    }

    const projectDir = resolve(ticketsDir, entry.name)
    for (const child of readdirSync(projectDir, { withFileTypes: true })) {
      if (child.isFile() && child.name.endsWith('.json')) {
        migrateLegacyTicketFile(resolve(projectDir, child.name))
      }
    }
  }
}

function hydrateTicketsFromDisk() {
  const ticketsDir = getTicketsDir()

  ensureTicketsDir()
  migrateLegacyTicketsFromDisk()

  for (const projectEntry of readdirSync(ticketsDir, { withFileTypes: true })) {
    if (!projectEntry.isDirectory()) {
      continue
    }

    const projectDir = resolve(ticketsDir, projectEntry.name)
    for (const ticketEntry of readdirSync(projectDir, { withFileTypes: true })) {
      if (!ticketEntry.isDirectory()) {
        continue
      }

      const ticketDir = resolve(projectDir, ticketEntry.name)
      const summaryPath = resolve(ticketDir, 'ticket.json')
      if (!existsSync(summaryPath)) {
        continue
      }

      try {
        loadTicketFromStorage(ticketDir)
      } catch (error) {
        console.warn(`Failed to load persisted ticket from ${summaryPath}:`, error)
      }
    }
  }
}

export function reloadTicketsFromDisk() {
  for (const timer of pendingFlushes.values()) {
    clearTimeout(timer)
  }
  pendingFlushes.clear()
  tickets.clear()
  ticketRuns.clear()
  hydrateTicketsFromDisk()
  return listTickets()
}

function emitState(ticketId: string) {
  const ticket = tickets.get(ticketId)
  if (!ticket) {
    return
  }

  emitTicketEvent(ticketId, {
    type: 'state',
    data: {
      ticket: toPublicTicket(ticket),
      run: ticket.activeRunId ? toPublicTicketRun(ticket.id, ticket.activeRunId) : null,
    },
  })
}

function syncTicketCompletion(ticket: Ticket) {
  if (ticket.worktree?.status === 'merged') {
    ticket.status = 'completed'
    ticket.runState = 'completed'
    delete ticket.repairLoop
    return
  }

  if (ticket.worktree?.status === 'discarded') {
    ticket.status = 'discarded'
    ticket.runState = 'discarded'
    delete ticket.repairLoop
    return
  }

  if (ticket.steps.ready?.status === 'done') {
    ticket.status = 'awaiting_merge'
    ticket.runState = 'awaiting_merge'
    delete ticket.repairLoop
  }
}

function updateTicket(
  ticketId: string,
  updater: (ticket: Ticket) => void,
  options?: { persist?: boolean; broadcast?: boolean }
): Ticket | undefined {
  const ticket = tickets.get(ticketId)
  if (!ticket) {
    return undefined
  }

  updater(ticket)
  ticket.updatedAt = new Date().toISOString()
  syncActiveRun(ticket)

  if (options?.persist !== false) {
    saveTicketToDisk(ticket)
  }

  if (options?.broadcast !== false) {
    emitState(ticketId)
  }

  return ticket
}

function ensureStep(ticket: Ticket, stepId: string): StepResult {
  if (!ticket.steps[stepId]) {
    ticket.steps[stepId] = { status: 'pending', output: '' }
  }

  return ticket.steps[stepId]
}

function latestStageReviewVerdict(ticket: Ticket, subjectStepId: string) {
  const latest = [...ticket.stageReviews].reverse().find((review) => review.subjectStepId === subjectStepId)
  return latest?.verdict
}

function resetStep(step: StepResult) {
  step.status = 'pending'
  step.output = ''
  delete step.startedAt
  delete step.completedAt
  delete step.attempts
  delete step.cost
}

export function subscribeToTicketEvents(ticketId: string, listener: (event: TicketStreamEvent) => void) {
  const existing = listeners.get(ticketId) ?? new Set<(event: TicketStreamEvent) => void>()
  existing.add(listener)
  listeners.set(ticketId, existing)

  return () => {
    const current = listeners.get(ticketId)
    if (!current) return
    current.delete(listener)
    if (current.size === 0) {
      listeners.delete(ticketId)
    }
  }
}

export function emitTicketEvent(ticketId: string, event: TicketStreamEvent) {
  const ticket = tickets.get(ticketId)
  if (ticket?.activeRunId && event.type !== 'init') {
    const journalPath = buildRunJournalPath(ticket.id, ticket.projectId, ticket.activeRunId)
    const entry: PersistedTicketStreamEvent = {
      type: event.type,
      data: event.data,
      createdAt: new Date().toISOString(),
    }
    ensureDir(dirname(journalPath))
    writeFileSync(journalPath, `${JSON.stringify(entry)}\n`, { encoding: 'utf-8', flag: 'a' })
  }

  const current = listeners.get(ticketId)
  if (!current) return

  for (const listener of current) {
    try {
      listener(event)
    } catch (error) {
      console.error(`Ticket listener failed for ${ticketId}:`, error)
    }
  }
}

export function readTicketEventJournal(ticketId: string, runId: string) {
  const ticket = tickets.get(ticketId)
  if (!ticket) {
    return [] as PersistedTicketStreamEvent[]
  }

  const journalPath = buildRunJournalPath(ticketId, ticket.projectId, runId)
  if (!existsSync(journalPath)) {
    return [] as PersistedTicketStreamEvent[]
  }

  return readFileSync(journalPath, 'utf-8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as PersistedTicketStreamEvent)
}

export function readTicketControlState(ticketId: string) {
  const ticket = tickets.get(ticketId)
  if (!ticket) {
    return undefined
  }

  const summaryPath = buildTicketJsonPath(ticket.id, ticket.projectId)
  if (!existsSync(summaryPath)) {
    return {
      queuedExecution: ticket.queuedExecution ? { ...ticket.queuedExecution } : undefined,
      stopRequestedAt: ticket.stopRequestedAt,
    }
  }

  const rawSummary = JSON.parse(readFileSync(summaryPath, 'utf-8')) as PersistedTicketSummary
  return {
    queuedExecution: rawSummary.queuedExecution
      ? {
          startStepId: rawSummary.queuedExecution.startStepId,
          recoveryNotes: rawSummary.queuedExecution.recoveryNotes,
          queuedAt: rawSummary.queuedExecution.queuedAt,
        }
      : undefined,
    stopRequestedAt: rawSummary.stopRequestedAt,
  }
}

export function createTicket(opts: {
  title: string
  description: string
  projectId: string
  projectPath: string
  categoryId: string
  flowStepIds: string[]
  linkedRequestId?: string
  originTicketId?: string
}): Ticket {
  const id = `TKT-${nanoid(6)}`
  const now = new Date().toISOString()
  const activeRunId = 'run-001'
  const steps = createEmptySteps(opts.flowStepIds)

  const ticket: Ticket = {
    id,
    title: opts.title,
    description: opts.description,
    projectId: opts.projectId,
    projectPath: opts.projectPath,
    categoryId: opts.categoryId,
    flowStepIds: opts.flowStepIds,
    linkedRequestId: opts.linkedRequestId,
    blockedByTicketId: undefined,
    blockingReason: undefined,
    originTicketId: opts.originTicketId,
    activeRunId,
    runSummaries: [
      {
        id: activeRunId,
        status: 'created',
        currentPhase: null,
        attemptCount: 0,
        createdAt: now,
        updatedAt: now,
      },
    ],
    status: 'created',
    runState: 'created',
    currentPhase: null,
    recoveryRequired: false,
    queuedExecution: undefined,
    stopRequestedAt: undefined,
    repairLoop: undefined,
    planningThreadId: null,
    implementationThreadId: null,
    coordinatorThreadId: null,
    steps,
    attemptCount: 0,
    verificationRuns: [],
    reviewRuns: [],
    stageReviews: [],
    scopedVerification: undefined,
    timeline: [
      {
        id: nanoid(8),
        type: 'system',
        title: '티켓이 생성되었습니다.',
        createdAt: now,
      },
    ],
    createdAt: now,
    updatedAt: now,
  }

  const run = createRun(ticket, activeRunId, now)
  ticketRuns.set(id, new Map([[activeRunId, run]]))
  tickets.set(id, ticket)
  saveTicketToDisk(ticket)
  emitState(ticket.id)
  return ticket
}

export function getTicket(id: string): Ticket | undefined {
  return tickets.get(id)
}

export function getTicketRun(ticketId: string, runId: string) {
  return ticketRuns.get(ticketId)?.get(runId)
}

export function listTickets(projectId?: string): Ticket[] {
  const scopedTickets = Array.from(tickets.values()).filter((ticket) => !projectId || ticket.projectId === projectId)
  return scopedTickets.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
}

export function toPublicTicketSummary(ticket: Ticket): PublicTicketSummary {
  return {
    id: ticket.id,
    title: ticket.title,
    projectId: ticket.projectId,
    categoryId: ticket.categoryId,
    linkedRequestId: ticket.linkedRequestId,
    blockedByTicketId: ticket.blockedByTicketId,
    blockingReason: ticket.blockingReason,
    originTicketId: ticket.originTicketId,
    status: ticket.status,
    runState: ticket.runState,
    currentPhase: ticket.currentPhase,
    recoveryRequired: ticket.recoveryRequired,
    planningBlock: ticket.planningBlock
      ? {
          ...ticket.planningBlock,
          findings: [...ticket.planningBlock.findings],
          options: cloneRetryOptions(ticket.planningBlock.options),
        }
      : undefined,
    mergeBlock: cloneMergeBlock(ticket.mergeBlock),
    repairLoop: cloneRepairLoop(ticket.repairLoop),
    activeRunId: ticket.activeRunId,
    runSummaries: cloneRunSummaries(ticket.runSummaries),
    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt,
  }
}

export function toPublicTicket(ticket: Ticket): PublicTicketDetail {
  return {
    ...toPublicTicketSummary(ticket),
    description: ticket.description,
    flowStepIds: [...ticket.flowStepIds],
  }
}

function toPublicWorktree(worktree?: TicketWorktree): PublicTicketWorktree | undefined {
  if (!worktree) {
    return undefined
  }

  return {
    branchName: worktree.branchName,
    baseBranch: worktree.baseBranch,
    baseCommit: worktree.baseCommit,
    headCommit: worktree.headCommit,
    diffSummary: worktree.diffSummary,
    mergeCommit: worktree.mergeCommit,
    status: worktree.status,
    createdAt: worktree.createdAt,
    updatedAt: worktree.updatedAt,
  }
}

function scrubPathPrefix(text: string, pathValue: string | undefined, replacement: string) {
  if (!pathValue) {
    return text
  }

  return text.replaceAll(pathValue, replacement)
}

function sanitizeVerificationTextForBrowser(text: string, ticket: Pick<Ticket, 'projectPath'> | undefined, run: TicketRun) {
  let sanitized = text
  sanitized = scrubPathPrefix(sanitized, run.worktree?.worktreePath, '[worktree]')
  sanitized = scrubPathPrefix(sanitized, ticket?.projectPath, '[project]')
  return sanitized
}

function makeVerificationOutputExcerpt(text: string, maxChars = 2_400, maxLines = 40) {
  const trimmed = text.trim()
  if (!trimmed) {
    return { text: '(no output)', truncated: false }
  }

  const lines = trimmed.split('\n')
  const excerptLines = lines.length > maxLines ? lines.slice(-maxLines) : lines
  const lineTruncated = excerptLines.length !== lines.length
  const joined = excerptLines.join('\n')

  if (joined.length > maxChars) {
    return {
      text: `${joined.slice(0, maxChars)}\n\n[truncated]`,
      truncated: true,
    }
  }

  if (lineTruncated) {
    return {
      text: `${joined}\n\n[truncated]`,
      truncated: true,
    }
  }

  return { text: joined, truncated: false }
}

function formatPublicVerificationCommandStatus(status: VerificationCommandResult['status']) {
  if (status === 'passed') return 'PASS'
  if (status === 'skipped') return 'SKIPPED'
  return 'FAIL'
}

function formatPublicVerificationDiagnosisKind(kind: VerificationDiagnosis['kind']) {
  if (kind === 'environment') return '검증 환경'
  if (kind === 'test_regression') return '테스트 회귀'
  if (kind === 'plan_misalignment') return '계획 정렬 문제'
  if (kind === 'external_blocker') return '프로젝트 기준 회귀'
  return '추가 확인 필요'
}

function toPublicVerificationDiagnosis(
  diagnosis: VerificationDiagnosis | undefined,
  ticket: Pick<Ticket, 'projectPath'> | undefined,
  run: TicketRun
): PublicVerificationDiagnosis | undefined {
  if (!diagnosis) {
    return undefined
  }

  return {
    kind: diagnosis.kind,
    summary: sanitizeVerificationTextForBrowser(diagnosis.summary, ticket, run),
    failingTests: diagnosis.failingTests.slice(0, 5).map((test) => ({
      suite: sanitizeVerificationTextForBrowser(test.suite, ticket, run),
      name: sanitizeVerificationTextForBrowser(test.name, ticket, run),
      message: sanitizeVerificationTextForBrowser(test.message, ticket, run),
      path: test.path ? sanitizeVerificationTextForBrowser(test.path, ticket, run) : undefined,
    })),
  }
}

function buildPublicVerificationStepOutput(ticket: Pick<Ticket, 'projectPath'> | undefined, run: TicketRun) {
  if (run.verificationRuns.length === 0) {
    return run.steps.verify?.output ?? ''
  }

  return run.verificationRuns
    .map((verificationRun) => {
      const diagnosis = toPublicVerificationDiagnosis(verificationRun.diagnosis, ticket, run)
      const commands = verificationRun.commands
        .map((command) => {
          const details = [
            `### ${command.label} [${formatPublicVerificationCommandStatus(command.status)}]`,
            '',
            `- 단계: ${command.stage === 'scoped' ? '범위 검증' : '프로젝트 검증'}`,
            `- 명령어: \`${command.command}\``,
          ]

          if (command.exitCode != null) {
            details.push(`- 종료 코드: ${command.exitCode}`)
          }

          details.push(`- 소요 시간: ${command.durationMs ?? 0}ms`)

          if (command.status !== 'passed') {
            const excerpt = makeVerificationOutputExcerpt(
              sanitizeVerificationTextForBrowser(command.output, ticket, run)
            )
            details.push('', '```text', excerpt.text, '```')
          }

          return details.join('\n')
        })
        .join('\n\n')

      return [
        `## 검증 시도 ${verificationRun.attempt}`,
        '',
        `결과: **${verificationRun.status === 'passed' ? 'PASS' : 'FAIL'}**`,
        '',
        ...(diagnosis
          ? [
              '### 실패 진단',
              `- 분류: ${formatPublicVerificationDiagnosisKind(diagnosis.kind)}`,
              `- 요약: ${diagnosis.summary}`,
              ...(diagnosis.failingTests.length > 0
                ? [
                    '- 실패 테스트:',
                    ...diagnosis.failingTests.map((test) =>
                      `  - ${test.suite} :: ${test.name}${test.path ? ` / ${test.path}` : ''} / ${test.message}`
                    ),
                    '',
                  ]
                : []),
            ]
          : []),
        commands,
        '',
      ].join('\n')
    })
    .join('\n')
}

function toPublicStepResults(ticket: Pick<Ticket, 'projectPath'> | undefined, run: TicketRun) {
  const steps = cloneSteps(run.steps)
  if (steps.verify) {
    steps.verify.output = buildPublicVerificationStepOutput(ticket, run)
  }
  return steps
}

function sanitizeTimelineBodyForBrowser(
  body: string | undefined,
  ticket: Pick<Ticket, 'projectPath'> | undefined,
  run: TicketRun
) {
  if (!body) {
    return undefined
  }

  return sanitizeVerificationTextForBrowser(body, ticket, run)
}

function toPublicTimeline(ticket: Pick<Ticket, 'projectPath'> | undefined, run: TicketRun) {
  return run.timeline.map((entry) => ({
    ...entry,
    body: sanitizeTimelineBodyForBrowser(entry.body, ticket, run),
  }))
}

export function toPublicTicketRun(ticketId: string, runId: string): PublicTicketRunDetail | undefined {
  const ticket = tickets.get(ticketId)
  const run = ticketRuns.get(ticketId)?.get(runId)
  if (!run) {
    return undefined
  }

  return {
    id: run.id,
    status: run.status,
    currentPhase: run.currentPhase,
    attemptCount: run.attemptCount,
    steps: toPublicStepResults(ticket, run),
    verificationRuns: run.verificationRuns.map((verificationRun) => ({
      attempt: verificationRun.attempt,
      status: verificationRun.status,
      diagnosis: toPublicVerificationDiagnosis(verificationRun.diagnosis, ticket, run),
      startedAt: verificationRun.startedAt,
      completedAt: verificationRun.completedAt,
      commands: verificationRun.commands.map((command) => {
        const excerpt = makeVerificationOutputExcerpt(sanitizeVerificationTextForBrowser(command.output, ticket, run))

        return {
          id: command.id,
          label: command.label,
          command: command.command,
          stage: command.stage,
          required: command.required,
          status: command.status,
          outputExcerpt: excerpt.text,
          truncated: excerpt.truncated,
          exitCode: command.exitCode,
          durationMs: command.durationMs,
          startedAt: command.startedAt,
          completedAt: command.completedAt,
        }
      }),
    })),
    reviewRuns: cloneReviewRuns(run.reviewRuns),
    stageReviews: cloneStageReviews(run.stageReviews),
    finalReport: cloneFinalReport(run.finalReport),
    timeline: toPublicTimeline(ticket, run),
    worktree: toPublicWorktree(run.worktree),
    repairLoop: cloneRepairLoop(run.repairLoop),
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  }
}

export function deleteTicket(id: string): boolean {
  const ticket = tickets.get(id)
  if (!ticket) {
    return false
  }

  flushTicket(id)
  const pending = pendingFlushes.get(id)
  if (pending) {
    clearTimeout(pending)
    pendingFlushes.delete(id)
  }

  tickets.delete(id)
  ticketRuns.delete(id)
  rmSync(getTicketStorageDir(ticket.projectId, id), { recursive: true, force: true })

  const legacyJsonPath = buildLegacyTicketJsonPath(id)
  const legacyMarkdownPath = buildLegacyTicketMarkdownPath(id)
  if (existsSync(legacyJsonPath)) unlinkSync(legacyJsonPath)
  if (existsSync(legacyMarkdownPath)) unlinkSync(legacyMarkdownPath)
  emitTicketEvent(id, { type: 'state', data: { deleted: true, ticketId: id } })
  return true
}

export function updateStepStatus(ticketId: string, stepId: string, status: StepStatus) {
  updateTicket(ticketId, (ticket) => {
    const step = ensureStep(ticket, stepId)
    const now = new Date().toISOString()

    step.status = status

    if (status === 'running') {
      step.startedAt = now
      step.attempts = (step.attempts ?? 0) + 1
      ticket.status = 'running'
      ticket.runState = 'running'
      delete ticket.queuedExecution
      delete ticket.stopRequestedAt
    }

    if (
      status === 'done' ||
      status === 'approved' ||
      status === 'awaiting_approval' ||
      status === 'failed'
    ) {
      step.completedAt = now
    }

    if (status === 'awaiting_approval') {
      ticket.status = 'blocked'
      ticket.runState = 'blocked'
    }

    if (status === 'failed') {
      ticket.status = 'failed'
      ticket.runState = 'failed'
    }

    syncTicketCompletion(ticket)
  })
}

export function appendStepOutput(ticketId: string, stepId: string, text: string) {
  updateTicket(
    ticketId,
    (ticket) => {
      const step = ensureStep(ticket, stepId)
      step.output += text
    },
    { broadcast: false }
  )
}

export function replaceStepOutput(ticketId: string, stepId: string, output: string) {
  updateTicket(ticketId, (ticket) => {
    const step = ensureStep(ticket, stepId)
    step.output = output
  })
}

export function setTicketPlanningThreadId(ticketId: string, planningThreadId: string | null) {
  updateTicket(ticketId, (ticket) => {
    ticket.planningThreadId = planningThreadId
  })
}

export function setTicketImplementationThreadId(ticketId: string, implementationThreadId: string | null) {
  updateTicket(ticketId, (ticket) => {
    ticket.implementationThreadId = implementationThreadId
  })
}

export function setTicketCoordinatorThreadId(ticketId: string, coordinatorThreadId: string | null) {
  updateTicket(ticketId, (ticket) => {
    ticket.coordinatorThreadId = coordinatorThreadId
  })
}

export function setTicketAttemptCount(ticketId: string, attemptCount: number) {
  updateTicket(ticketId, (ticket) => {
    ticket.attemptCount = attemptCount
  })
}

export function appendVerificationRun(ticketId: string, run: VerificationRun) {
  updateTicket(ticketId, (ticket) => {
    ticket.verificationRuns.push(run)
  })
}

export function appendReviewRun(ticketId: string, run: ReviewRun) {
  updateTicket(ticketId, (ticket) => {
    ticket.reviewRuns.push(run)
  })
}

export function appendStageReview(ticketId: string, review: StageReview) {
  updateTicket(ticketId, (ticket) => {
    ticket.stageReviews.push(review)
  })
}

export function setFinalReport(ticketId: string, report: FinalReport) {
  updateTicket(ticketId, (ticket) => {
    ticket.finalReport = report
  })
}

export function appendTimelineEvent(
  ticketId: string,
  event: Omit<TicketTimelineEvent, 'id' | 'createdAt'>
) {
  updateTicket(ticketId, (ticket) => {
    ticket.timeline.push({
      ...event,
      id: nanoid(8),
      createdAt: new Date().toISOString(),
    })
  })
}

function formatTicketClarificationEntry(clarification: string, createdAt: string) {
  return [`### 사용자 보완 답변 (${createdAt})`, clarification.trim()].join('\n\n')
}

export function appendTicketClarification(ticketId: string, clarification: string) {
  const normalizedClarification = clarification.trim()
  if (!normalizedClarification) {
    return undefined
  }

  return updateTicket(ticketId, (ticket) => {
    const createdAt = new Date().toISOString()
    const nextEntry = formatTicketClarificationEntry(normalizedClarification, createdAt)
    const baseDescription = ticket.description.trimEnd()

    ticket.description = baseDescription ? `${baseDescription}\n\n${nextEntry}` : nextEntry
    ticket.timeline.push({
      id: nanoid(8),
      type: 'system',
      title: '사용자 보완 답변이 추가되었습니다.',
      body: normalizedClarification,
      createdAt,
    })
  })
}

export function setTicketWorktree(ticketId: string, worktree: TicketWorktree) {
  updateTicket(ticketId, (ticket) => {
    ticket.worktree = worktree
  })
}

export function clearTicketWorktree(ticketId: string) {
  updateTicket(ticketId, (ticket) => {
    delete ticket.worktree
  })
}

export function updateTicketWorktree(ticketId: string, patch: Partial<TicketWorktree>) {
  updateTicket(ticketId, (ticket) => {
    if (!ticket.worktree) {
      return
    }

    ticket.worktree = {
      ...ticket.worktree,
      ...patch,
      updatedAt: new Date().toISOString(),
    }
    syncTicketCompletion(ticket)
  })
}

function maybeResumeOriginTicketFromCompletedBlocker(blockerTicket: Ticket) {
  if (blockerTicket.status !== 'completed' || !blockerTicket.originTicketId) {
    return
  }

  const originTicket = tickets.get(blockerTicket.originTicketId)
  if (!originTicket || originTicket.blockedByTicketId !== blockerTicket.id) {
    return
  }

  if (!prepareTicketForMergeValidation(originTicket.id, 'verify')) {
    return
  }

  setTicketBlockerLink(originTicket.id, undefined)
  appendTimelineEvent(originTicket.id, {
    type: 'system',
    title: `차단 티켓 ${blockerTicket.id}이 완료되어 자동 검증을 재개합니다.`,
    body: '범위 밖 전체 검증 회귀가 해결되어 verify 단계부터 다시 실행합니다.',
  })
  enqueueTicketExecution(
    originTicket.id,
    'verify',
    `차단 티켓 ${blockerTicket.id}이 전체 검증 회귀를 해결했습니다. verify와 review를 다시 실행합니다.`
  )
}

export function setTicketStatus(ticketId: string, status: TicketRunState) {
  const updated = updateTicket(ticketId, (ticket) => {
    ticket.status = status
    ticket.runState = status
  })

  if (updated) {
    maybeResumeOriginTicketFromCompletedBlocker(updated)
  }
}

export function setTicketRunState(ticketId: string, runState: TicketRunState) {
  updateTicket(ticketId, (ticket) => {
    ticket.runState = runState
    ticket.status = runState
    if (runState !== 'queued') {
      delete ticket.queuedExecution
    }
    if (runState !== 'running' && runState !== 'queued') {
      delete ticket.stopRequestedAt
    }
  })
}

export function markTicketStopped(ticketId: string) {
  updateTicket(ticketId, (ticket) => {
    const now = new Date().toISOString()
    const activeStepId = ticket.currentPhase
    if (activeStepId) {
      const step = ensureStep(ticket, activeStepId)
      if (step.status === 'running') {
        step.status = 'failed'
        step.completedAt = now
      }
    }

    ticket.runState = 'stopped'
    ticket.status = 'stopped'
    delete ticket.queuedExecution
    delete ticket.stopRequestedAt
  })
}

export function setTicketCurrentPhase(ticketId: string, currentPhase: string | null) {
  updateTicket(ticketId, (ticket) => {
    ticket.currentPhase = currentPhase
  })
}

export function setTicketRepairLoop(ticketId: string, repairLoop?: TicketRepairLoop) {
  updateTicket(ticketId, (ticket) => {
    if (repairLoop) {
      ticket.repairLoop = cloneRepairLoop(repairLoop)
      return
    }

    delete ticket.repairLoop
  })
}

export function updateTicketRepairLoop(ticketId: string, patch: Partial<TicketRepairLoop>) {
  updateTicket(ticketId, (ticket) => {
    if (!ticket.repairLoop) {
      return
    }

    ticket.repairLoop = {
      ...ticket.repairLoop,
      ...patch,
    }
  })
}

export function clearTicketRepairLoop(ticketId: string) {
  updateTicket(ticketId, (ticket) => {
    delete ticket.repairLoop
  })
}

export function setTicketScopedVerification(ticketId: string, scopedVerification?: ScopedVerificationPlan) {
  updateTicket(ticketId, (ticket) => {
    ticket.scopedVerification = cloneScopedVerificationPlan(scopedVerification)
  })
}

export function setTicketBlockerLink(
  ticketId: string,
  blockedByTicketId?: string,
  blockingReason?: TicketBlockingReason
) {
  updateTicket(ticketId, (ticket) => {
    if (blockedByTicketId) {
      ticket.blockedByTicketId = blockedByTicketId
      ticket.blockingReason = blockingReason
      return
    }

    delete ticket.blockedByTicketId
    delete ticket.blockingReason
  })
}

export function enqueueTicketExecution(
  ticketId: string,
  startStepId: TicketQueuedExecution['startStepId'] = 'analyze',
  recoveryNotes?: string
) {
  const ticket = tickets.get(ticketId)
  if (!ticket) {
    throw new Error('Ticket not found')
  }

  if (ticket.runState === 'queued' || ticket.runState === 'running') {
    return false
  }

  updateTicket(ticketId, (current) => {
    current.recoveryRequired = false
    current.currentPhase = startStepId
    current.queuedExecution = {
      startStepId,
      recoveryNotes,
      queuedAt: new Date().toISOString(),
    }
    current.runState = 'queued'
    current.status = 'queued'
    delete current.stopRequestedAt
    current.timeline.push({
      id: nanoid(8),
      type: 'system',
      title: '자동 실행 대기열에 등록되었습니다.',
      body: `${startStepId} 단계부터 이어서 실행합니다.${recoveryNotes ? '\n\n복구 지침을 함께 반영합니다.' : ''}`,
      createdAt: new Date().toISOString(),
    })
  })

  return true
}

export function setTicketRecoveryRequired(ticketId: string, recoveryRequired: boolean) {
  updateTicket(ticketId, (ticket) => {
    ticket.recoveryRequired = recoveryRequired
  })
}

export function setTicketQueuedExecution(ticketId: string, queuedExecution?: TicketQueuedExecution) {
  updateTicket(ticketId, (ticket) => {
    if (queuedExecution) {
      ticket.queuedExecution = { ...queuedExecution }
      delete ticket.stopRequestedAt
      return
    }

    delete ticket.queuedExecution
  })
}

export function requestTicketStop(ticketId: string) {
  const updated = updateTicket(ticketId, (ticket) => {
    ticket.stopRequestedAt = new Date().toISOString()
  })

  return updated?.stopRequestedAt
}

export function clearTicketStopRequest(ticketId: string) {
  updateTicket(ticketId, (ticket) => {
    delete ticket.stopRequestedAt
  })
}

export function setTicketPlanningBlock(ticketId: string, planningBlock?: TicketPlanningBlock) {
  updateTicket(ticketId, (ticket) => {
    if (planningBlock) {
      ticket.planningBlock = {
        ...planningBlock,
        findings: [...planningBlock.findings],
        options: cloneRetryOptions(planningBlock.options),
      }
      return
    }

    delete ticket.planningBlock
  })
}

export function setTicketMergeBlock(ticketId: string, mergeBlock?: TicketMergeBlock) {
  updateTicket(ticketId, (ticket) => {
    if (mergeBlock) {
      ticket.mergeBlock = cloneMergeBlock(mergeBlock)
      return
    }

    delete ticket.mergeBlock
  })
}

export function setTicketMergeContext(ticketId: string, mergeContext?: TicketMergeContext) {
  updateTicket(ticketId, (ticket) => {
    if (mergeContext) {
      ticket.mergeContext = cloneMergeContext(mergeContext)
      return
    }

    delete ticket.mergeContext
  })
}

export function approveStep(ticketId: string, stepId: string): boolean {
  const ticket = tickets.get(ticketId)
  if (!ticket) return false

  const step = ticket.steps[stepId]
  if (!step || (step.status !== 'awaiting_approval' && step.status !== 'done')) return false

  step.status = 'approved'
  step.completedAt = new Date().toISOString()
  step.output = `${step.output}${step.output ? '\n\n' : ''}승인되었습니다.`
  ticket.status = 'running'
  ticket.runState = 'running'
  ticket.updatedAt = new Date().toISOString()
  syncActiveRun(ticket)
  saveTicketToDisk(ticket)
  emitState(ticketId)
  return true
}

export function rejectStep(ticketId: string, stepId: string, reason?: string): boolean {
  const ticket = tickets.get(ticketId)
  if (!ticket) return false

  const step = ticket.steps[stepId]
  if (!step || (step.status !== 'awaiting_approval' && step.status !== 'done')) return false

  step.status = 'rejected'
  step.output = `${step.output}${step.output ? '\n\n' : ''}거절되었습니다.${reason ? `\n\n사유: ${reason}` : ''}`
  ticket.status = 'created'
  ticket.runState = 'created'
  ticket.updatedAt = new Date().toISOString()
  syncActiveRun(ticket)
  saveTicketToDisk(ticket)
  emitState(ticketId)
  return true
}

function buildTicketRetryPlan(ticket: Ticket): TicketRetryPlan {
  const selectedOption = ticket.planningBlock?.options?.length === 1 ? ticket.planningBlock.options[0] : undefined
  if (selectedOption) {
    return {
      ...selectedOption,
      shouldCleanupWorktree:
        selectedOption.executionMode === 'new_run' &&
        Boolean(ticket.worktree && ticket.worktree.status !== 'merged' && ticket.worktree.status !== 'discarded'),
    }
  }

  const planVerdict = latestStageReviewVerdict(ticket, 'plan')
  const analyzeVerdict = latestStageReviewVerdict(ticket, 'analyze')
  const canResumeImplementInSameRun = planVerdict === 'pass'

  return {
    startStepId: canResumeImplementInSameRun ? 'implement' : analyzeVerdict === 'pass' ? 'plan' : 'analyze',
    id: 'default-retry',
    label: '마지막 안전 지점부터 다시 시작',
    executionMode: canResumeImplementInSameRun ? 'same_run' : 'new_run',
    sessionMode: canResumeImplementInSameRun ? 'reuse_thread' : 'new_thread',
    shouldCleanupWorktree:
      canResumeImplementInSameRun
        ? false
        : Boolean(ticket.worktree && ticket.worktree.status !== 'merged' && ticket.worktree.status !== 'discarded'),
  }
}

export function getTicketRetryPlan(ticketId: string, optionId?: string): TicketRetryPlan | undefined {
  const ticket = tickets.get(ticketId)
  if (!ticket) {
    return undefined
  }

  if (ticket.planningBlock?.options?.length) {
    const selectedOption = optionId
      ? ticket.planningBlock.options.find((option) => option.id === optionId)
      : ticket.planningBlock.options.length === 1
        ? ticket.planningBlock.options[0]
        : undefined

    if (!selectedOption) {
      return undefined
    }

    return {
      ...selectedOption,
      shouldCleanupWorktree:
        selectedOption.executionMode === 'new_run' &&
        Boolean(ticket.worktree && ticket.worktree.status !== 'merged' && ticket.worktree.status !== 'discarded'),
    }
  }

  return buildTicketRetryPlan(ticket)
}

export function applyTicketRetryPlan(ticketId: string, plan: TicketRetryPlan): TicketRetryPlan | undefined {
  if (plan.executionMode !== 'new_run') {
    return undefined
  }

  const ticket = tickets.get(ticketId)
  const runs = ticketRuns.get(ticketId)
  if (!ticket || !runs || !ticket.activeRunId) {
    return undefined
  }

  const previousRun = runs.get(ticket.activeRunId)
  if (!previousRun) {
    return undefined
  }

  const now = new Date().toISOString()
  const startStepId = plan.startStepId
  const newRunId = nextRunId(ticket.runSummaries)
  const newRun = cloneCarryOverRun(previousRun, ticket, startStepId, newRunId, now)
  runs.set(newRunId, newRun)

  ticket.activeRunId = newRunId
  ticket.runSummaries = [...ticket.runSummaries, buildRunSummary(newRun)]
  ticket.status = 'created'
  ticket.runState = 'created'
  ticket.currentPhase = startStepId
  ticket.recoveryRequired = false
  delete ticket.queuedExecution
  delete ticket.stopRequestedAt
  delete ticket.planningBlock
  delete ticket.mergeBlock
  delete ticket.mergeContext
  delete ticket.repairLoop
  ticket.planningThreadId = newRun.planningThreadId
  ticket.implementationThreadId = newRun.implementationThreadId
  ticket.coordinatorThreadId = newRun.coordinatorThreadId
  ticket.steps = newRun.steps
  ticket.attemptCount = newRun.attemptCount
  ticket.verificationRuns = newRun.verificationRuns
  ticket.reviewRuns = newRun.reviewRuns
  ticket.stageReviews = newRun.stageReviews
  delete ticket.finalReport
  ticket.timeline = newRun.timeline
  delete ticket.worktree
  ticket.scopedVerification = cloneScopedVerificationPlan(newRun.scopedVerification)
  ticket.updatedAt = now

  syncActiveRun(ticket)
  saveTicketToDisk(ticket)
  emitState(ticketId)

  return {
    id: plan.id,
    label: plan.label,
    startStepId,
    executionMode: plan.executionMode,
    sessionMode: plan.sessionMode,
    shouldCleanupWorktree: plan.shouldCleanupWorktree,
  }
}

export function resumeTicketFromCurrentRun(ticketId: string, plan: TicketRetryPlan): TicketRetryPlan | undefined {
  if (plan.executionMode !== 'same_run') {
    return undefined
  }

  const ticket = tickets.get(ticketId)
  if (!ticket) {
    return undefined
  }

  const now = new Date().toISOString()
  ticket.status = 'created'
  ticket.runState = 'created'
  ticket.currentPhase = plan.startStepId
  ticket.recoveryRequired = false
  delete ticket.queuedExecution
  delete ticket.stopRequestedAt
  delete ticket.planningBlock
  delete ticket.mergeBlock
  delete ticket.mergeContext
  delete ticket.finalReport
  delete ticket.repairLoop
  resetStep(ensureStep(ticket, 'review'))
  if (ticket.steps.verify) {
    resetStep(ticket.steps.verify)
  }
  if (ticket.steps.ready) {
    resetStep(ticket.steps.ready)
  }
  if (ticket.steps.implement.status === 'failed') {
    ticket.steps.implement.status = 'pending'
    delete ticket.steps.implement.completedAt
  }
  ticket.updatedAt = now

  syncActiveRun(ticket)
  saveTicketToDisk(ticket)
  emitState(ticketId)

  return {
    ...plan,
    shouldCleanupWorktree: false,
  }
}

export function prepareTicketForMergeValidation(ticketId: string, startStepId: 'verify' | 'review'): boolean {
  const ticket = tickets.get(ticketId)
  if (!ticket) {
    return false
  }

  const now = new Date().toISOString()
  ticket.status = 'created'
  ticket.runState = 'created'
  ticket.currentPhase = startStepId
  ticket.recoveryRequired = false
  delete ticket.queuedExecution
  delete ticket.stopRequestedAt
  delete ticket.planningBlock
  delete ticket.mergeBlock
  delete ticket.mergeContext
  delete ticket.finalReport
  delete ticket.repairLoop

  if (startStepId === 'verify' && ticket.steps.verify) {
    resetStep(ticket.steps.verify)
  }

  resetStep(ensureStep(ticket, 'review'))
  if (ticket.steps.ready) {
    resetStep(ticket.steps.ready)
  }

  ticket.updatedAt = now

  syncActiveRun(ticket)
  saveTicketToDisk(ticket)
  emitState(ticketId)
  return true
}

export function prepareTicketForRetry(ticketId: string): TicketRetryPlan | undefined {
  const plan = getTicketRetryPlan(ticketId)
  if (!plan) {
    return undefined
  }

  if (plan.executionMode === 'same_run') {
    return resumeTicketFromCurrentRun(ticketId, plan)
  }

  return applyTicketRetryPlan(ticketId, plan)
}

export function getNextStep(_ticketId: string, currentStepId: string, flowStepIds?: string[]): string | null {
  const steps = flowStepIds ?? []
  const idx = steps.findIndex((stepId) => stepId === currentStepId)
  if (idx === -1 || idx >= steps.length - 1) return null
  return steps[idx + 1] ?? null
}

export function markRecoverableTicketsFromStartup() {
  for (const ticket of tickets.values()) {
    if (ticket.runState !== 'queued' && ticket.runState !== 'running') {
      continue
    }

    ticket.runState = 'failed'
    ticket.status = 'failed'
    ticket.recoveryRequired = true
    delete ticket.queuedExecution
    delete ticket.stopRequestedAt
    delete ticket.repairLoop
    ticket.currentPhase = ticket.currentPhase ?? 'unknown'
    ticket.timeline.push({
      id: nanoid(8),
      type: 'system',
      title: '서버 재시작으로 자동 실행이 중단되었습니다.',
      body: 'Retry를 눌러 마지막 안전 지점부터 다시 시작할 수 있습니다.',
      createdAt: new Date().toISOString(),
    })
    ticket.updatedAt = new Date().toISOString()
    syncActiveRun(ticket)
    saveTicketToDisk(ticket)
  }
}
