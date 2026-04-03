import { authorizedFetch } from './auth'

export type AccessPermission = 'explain' | 'requests' | 'tickets' | 'direct'
export type ChatInitialScrollTarget = 'bottom' | 'last_user_message'
export type ModelReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh'

export interface TicketFlowAgent {
  role: string
  displayName: string
}

export interface TicketFlowStep {
  id: string
  name: string
  requiresApproval: boolean
  runMode: 'manual' | 'automatic' | 'display'
  agent?: TicketFlowAgent
}

export interface TicketCategory {
  id: string
  label: string
  description: string
  steps: TicketFlowStep[]
}

export interface AppConfig {
  defaultProjectId: string
  allowedProjects: {
    id: string
    label: string
    deletable: boolean
  }[]
  auth: {
    session: {
      kind: 'open' | 'shared_admin' | 'access_token' | 'account_session'
      label: string
      isAdmin: boolean
      permissions: AccessPermission[]
      mustChangePassword: boolean
      accountId?: string
      accountName?: string
      tokenId?: string
      tokenLabel?: string
      expiresAt?: string | null
    }
  }
  chat: {
    initialScrollTarget: ChatInitialScrollTarget
  }
  explain: {
    availableModels: Array<{
      id: string
      label: string
      supportedReasoningEfforts: ModelReasoningEffort[]
      defaultReasoningEffort: ModelReasoningEffort
    }>
    selectedModel: string
    selectedReasoningEffort: ModelReasoningEffort
  }
  direct: {
    availableModels: Array<{
      id: string
      label: string
      supportedReasoningEfforts: ModelReasoningEffort[]
      defaultReasoningEffort: ModelReasoningEffort
    }>
    selectedModel: string
    selectedReasoningEffort: ModelReasoningEffort
  }
  requests: {
    screening: {
      availableModels: Array<{
        id: string
        label: string
      }>
      selectedModel: string
    }
  }
  flows: {
    ticket: {
      categories: TicketCategory[]
      coordinator?: {
        enabled: boolean
        agent?: TicketFlowAgent
      }
    }
  }
}

export interface ProjectBrowserEntry {
  name: string
  path: string
}

export interface ProjectBrowserResult {
  currentPath: string
  parentPath: string | null
  entries: ProjectBrowserEntry[]
}

export interface AccessTokenSummary {
  id: string
  accountId: string
  accountName: string
  label: string
  isAdmin: boolean
  permissions: AccessPermission[]
  projectIds: string[]
  expiresAt: string | null
  createdAt: string
  updatedAt: string
  revokedAt: string | null
  lastUsedAt: string | null
  tokenPreview: string
  status: 'active' | 'expired' | 'revoked' | 'disabled'
}

export interface AccessSessionSummary {
  id: string
  accountId: string
  accountName: string
  label: string
  expiresAt: string | null
  createdAt: string
  updatedAt: string
  revokedAt: string | null
  lastUsedAt: string | null
  tokenPreview: string
  status: 'active' | 'expired' | 'revoked' | 'disabled'
}

export interface AccessAccountSummary {
  id: string
  name: string
  description?: string
  disabled: boolean
  isAdmin: boolean
  permissions: AccessPermission[]
  projectIds: string[]
  mustChangePassword: boolean
  hasPassword: boolean
  passwordUpdatedAt: string | null
  lastLoginAt: string | null
  createdAt: string
  updatedAt: string
  tokens: AccessTokenSummary[]
  sessions: AccessSessionSummary[]
}

export interface AccessControlSummary {
  accounts: AccessAccountSummary[]
  tokens: AccessTokenSummary[]
  sessions: AccessSessionSummary[]
}

export interface StepResult {
  status: 'pending' | 'running' | 'done' | 'awaiting_approval' | 'approved' | 'rejected' | 'failed'
  output: string
  startedAt?: string
  completedAt?: string
  attempts?: number
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

export interface GoalAlignment {
  status: 'aligned' | 'partial' | 'misaligned' | 'not_available'
  evidence: string[]
}

export interface AcceptanceCriterionAssessment {
  criterion: string
  status: 'met' | 'partial' | 'unmet'
  evidence: string[]
}

export interface GoalAssessment {
  request: GoalAlignment
  ticket: GoalAlignment
  acceptanceCriteria: AcceptanceCriterionAssessment[]
}

export interface FinalReport {
  summary: string
  changedAreas: string[]
  verificationSummary: string[]
  goalAssessment: GoalAssessment
  qualityAssessment: {
    correctness: 'low' | 'medium' | 'high'
    maintainability: 'low' | 'medium' | 'high'
    testConfidence: 'low' | 'medium' | 'high'
    risk: 'low' | 'medium' | 'high'
  }
  blockingFindings: string[]
  residualRisks: string[]
  mergeRecommendation: 'merge' | 'hold'
  output: string
  createdAt: string
}

export interface TicketRepairLoop {
  gate: 'verify' | 'review' | 'merge'
  cycle: number
  status: 'repairing' | 'waiting_verify' | 'waiting_review'
  failureSummary: string
  startedAt: string
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

export interface VerificationCommandResult {
  id: string
  label: string
  command: string
  required: boolean
  status: 'passed' | 'failed' | 'skipped'
  output: string
  exitCode?: number
  durationMs?: number
  startedAt: string
  completedAt: string
}

export interface VerificationRun {
  attempt: number
  status: 'passed' | 'failed'
  commands: VerificationCommandResult[]
  startedAt: string
  completedAt: string
}

export interface PublicVerificationCommandResult {
  id: string
  label: string
  command: string
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
  kind: 'environment' | 'test_regression' | 'plan_misalignment' | 'unknown'
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

export interface TicketWorktree {
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

export interface RequestTemplateFields {
  problem: string
  desiredOutcome: string
  userScenarios: string
  constraints?: string
  nonGoals?: string
  openQuestions?: string
}

export interface TicketPlanningBlock {
  kind: 'needs_decision' | 'needs_request_clarification'
  source: 'plan_review' | 'review' | 'verify'
  summary: string
  findings: string[]
  options?: Array<{
    id: string
    label: string
    startStepId: 'analyze' | 'plan' | 'implement'
    executionMode: 'same_run' | 'new_run'
    sessionMode: 'reuse_thread' | 'new_thread'
  }>
}

export type TicketMergeIssueKind =
  | 'base_branch_changed'
  | 'base_commit_changed'
  | 'head_changed_after_review'
  | 'merge_conflict'
  | 'rebase_conflict_text'
  | 'rebase_conflict_code'
  | 'rebase_failed'
  | 'unknown'

export type TicketMergeResolutionAction =
  | 'rebase_and_revalidate'
  | 'revalidate_current_worktree'
  | 'reapply_on_latest_base'
  | 'restart_from_plan'
  | 'discard_worktree'

export interface TicketMergeOption {
  id: string
  label: string
  action: TicketMergeResolutionAction
  rationale: string
  recommended?: boolean
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

export interface TicketRunSummary {
  id: string
  status: TicketRunState
  currentPhase: string | null
  attemptCount: number
  createdAt: string
  updatedAt: string
}

export interface TicketSummary {
  id: string
  title: string
  projectId: string
  categoryId: string
  linkedRequestId?: string
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

export interface TicketDetail extends TicketSummary {
  description: string
  flowStepIds: string[]
}

export interface TicketRunDetail {
  id: string
  status: TicketRunState
  currentPhase: string | null
  steps: Record<string, StepResult>
  attemptCount: number
  verificationRuns: PublicVerificationRun[]
  reviewRuns: ReviewRun[]
  stageReviews: StageReview[]
  finalReport?: FinalReport
  timeline: TicketTimelineEvent[]
  worktree?: TicketWorktree
  repairLoop?: TicketRepairLoop
  createdAt: string
  updatedAt: string
}

export type Ticket = TicketDetail

export type BackgroundRunKind =
  | 'explain_reply'
  | 'direct_reply'
  | 'explain_request_draft'
  | 'manual_request_draft'
  | 'ticket_run'

export type BackgroundRunStatus = 'queued' | 'running' | 'stopping' | 'completed' | 'stopped' | 'failed'
export type BackgroundRunScopeType = 'explain_thread' | 'direct_session' | 'request_compose' | 'ticket'

export interface BackgroundRunSummary {
  id: string
  kind: BackgroundRunKind
  permission: AccessPermission
  projectId: string
  scopeType: BackgroundRunScopeType
  scopeId: string
  scopeLabel: string
  messagePreview: string
  status: BackgroundRunStatus
  latestLabel?: string
  latestDetail?: string
  error?: string
  result?: unknown
  createdAt: string
  startedAt: string
  updatedAt: string
  completedAt?: string
  stoppedAt?: string
}

export interface BackgroundRunStartResult {
  run: BackgroundRunSummary
  existing: boolean
}

export interface ClientRequest {
  id: string
  requester: string
  title: string
  description: string
  template: RequestTemplateFields
  projectId: string
  categoryId: string
  source: 'manual' | 'chat'
  explainThreadId?: string
  status: 'new' | 'ticket_created'
  readinessStatus: 'ready_for_ticket' | 'needs_clarification'
  readinessNotes: string[]
  linkedTicketId?: string
  createdAt: string
  updatedAt: string
}

export interface GeneratedRequestDraft {
  title: string
  categoryId: string
  template: RequestTemplateFields
  rationale?: string
}

export interface IncidentTrigger {
  kind:
    | 'analyze_failed'
    | 'verify_failed'
    | 'review_failed'
    | 'runner_exception'
    | 'retry_failed'
    | 'merge_failed'
    | 'discard_failed'
  message: string
  phase?: string | null
  attempt?: number
}

export interface IncidentAnalysis {
  summary: string
  likelyRootCause: string
  evidence: string[]
  impactedAreas: string[]
  nextActions: string[]
  missingSignals: string[]
  confidence: 'low' | 'medium' | 'high'
  recommendedAction: {
    type: 'rerun_from_step' | 'manual_intervention'
    startStepId?: 'analyze' | 'plan' | 'implement' | null
    rationale: string
  }
}

export interface IncidentSummary {
  id: string
  source: 'ticket'
  sourceId: string
  projectId: string
  title: string
  status: 'captured' | 'analyzing' | 'analyzed' | 'analysis_failed'
  trigger: IncidentTrigger
  createdAt: string
  updatedAt: string
}

export interface IncidentDetail extends IncidentSummary {
  bundle: {
    ticket: {
      id: string
      title: string
      description: string
      projectId: string
      categoryId: string
      linkedRequestId?: string
      status: Ticket['status']
      runState: Ticket['runState']
      currentPhase: string | null
      attemptCount: number
    }
    steps: Array<{
      stepId: string
      status: StepResult['status']
      outputExcerpt: string
      truncated: boolean
    }>
    verificationRuns: Array<{
      attempt: number
      status: VerificationRun['status']
      commands: Array<{
        id: string
        label: string
        required: boolean
        status: VerificationCommandResult['status']
        outputExcerpt: string
        truncated: boolean
        exitCode?: number
        durationMs?: number
        startedAt: string
        completedAt: string
      }>
      startedAt: string
      completedAt: string
    }>
    latestReview?: {
      attempt: number
      verdict: ReviewRun['verdict']
      summary: string
      blockingFindings: string[]
      residualRisks: string[]
      releaseNotes: string[]
      outputExcerpt: string
      truncated: boolean
      startedAt: string
      completedAt: string
    }
    stageReviews: Array<{
      id: string
      subjectStepId: string
      label: string
      attempt: number
      verdict: StageReview['verdict']
      summary: string
      blockingFindings: string[]
      residualRisks: string[]
      outputExcerpt: string
      truncated: boolean
      startedAt: string
      completedAt: string
    }>
    timeline: Array<{
      id: string
      type: TicketTimelineEvent['type']
      title: string
      body?: string
      stepId?: string
      attempt?: number
      status?: string
      createdAt: string
    }>
    worktree?: {
      branchName: string
      baseBranch: string
      baseCommit: string
      headCommit?: string
      mergeCommit?: string
      diffSummaryExcerpt?: string
      diffSummaryTruncated?: boolean
      status: TicketWorktree['status']
      createdAt: string
      updatedAt: string
    }
  }
  analysis?: IncidentAnalysis
}

async function readJson<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    const message =
      payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string'
        ? payload.error
        : `HTTP ${response.status}`
    throw new Error(message)
  }

  return payload as T
}

async function readMergeActionResult(response: Response): Promise<{
  ok: boolean
  warning?: string
  error?: string
  needsDecision?: boolean
  mergeBlock?: TicketMergeBlock
}> {
  const payload = (await response.json().catch(() => ({}))) as {
    ok?: boolean
    warning?: string
    error?: string
    code?: string
    mergeBlock?: TicketMergeBlock
  }

  if (response.ok) {
    return {
      ok: true,
      warning: payload.warning,
    }
  }

  if (response.status === 409 && payload.code === 'MERGE_DECISION_REQUIRED') {
    return {
      ok: false,
      error: payload.error || 'Merge decision is required',
      needsDecision: true,
      mergeBlock: payload.mergeBlock,
    }
  }

  return {
    ok: false,
    error: payload.error || `HTTP ${response.status}`,
  }
}

export async function fetchConfig(): Promise<AppConfig> {
  const res = await authorizedFetch('/api/config')
  return readJson(res)
}

export async function createProject(data: { label: string; path: string }): Promise<AppConfig> {
  const res = await authorizedFetch('/api/config/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  return readJson(res)
}

export async function deleteProject(projectId: string): Promise<AppConfig> {
  const res = await authorizedFetch(`/api/config/projects/${encodeURIComponent(projectId)}`, {
    method: 'DELETE',
  })
  return readJson(res)
}

export async function browseProjectDirectories(path?: string): Promise<ProjectBrowserResult> {
  const query = path ? `?path=${encodeURIComponent(path)}` : ''
  const res = await authorizedFetch(`/api/config/projects/browse${query}`)
  return readJson(res)
}

export async function inferProjectName(path: string): Promise<{ label: string }> {
  const res = await authorizedFetch(`/api/config/projects/infer-name?path=${encodeURIComponent(path)}`)
  return readJson(res)
}

export async function pickProjectFolder(): Promise<{ path: string }> {
  const res = await authorizedFetch('/api/config/projects/pick-folder', {
    method: 'POST',
  })
  return readJson(res)
}

export async function fetchAccessControl(): Promise<AccessControlSummary> {
  const res = await authorizedFetch('/api/access')
  return readJson(res)
}

export async function createAccessAccount(data: {
  name: string
  description?: string
  isAdmin?: boolean
  permissions?: AccessPermission[]
  projectIds?: string[]
  password?: string
}): Promise<AccessAccountSummary> {
  const res = await authorizedFetch('/api/access/accounts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  return readJson(res)
}

export async function updateAccessAccount(data: {
  accountId: string
  name: string
  description?: string
  disabled?: boolean
  isAdmin?: boolean
  permissions?: AccessPermission[]
  projectIds?: string[]
}): Promise<AccessAccountSummary> {
  const { accountId, ...payload } = data
  const res = await authorizedFetch(`/api/access/accounts/${encodeURIComponent(accountId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return readJson(res)
}

export async function setAccessAccountPassword(data: {
  accountId: string
  password: string
}): Promise<AccessAccountSummary> {
  const res = await authorizedFetch(`/api/access/accounts/${encodeURIComponent(data.accountId)}/password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: data.password }),
  })
  return readJson(res)
}

export async function clearAccessAccountPassword(accountId: string): Promise<AccessAccountSummary> {
  const res = await authorizedFetch(`/api/access/accounts/${encodeURIComponent(accountId)}/password`, {
    method: 'DELETE',
  })
  return readJson(res)
}

export async function deleteAccessAccount(accountId: string): Promise<{ ok: true }> {
  const res = await authorizedFetch(`/api/access/accounts/${encodeURIComponent(accountId)}`, {
    method: 'DELETE',
  })
  return readJson(res)
}

export async function createAccessToken(data: {
  accountId: string
  label: string
  isAdmin?: boolean
  permissions?: AccessPermission[]
  projectIds?: string[]
  expiresAt?: string | null
}): Promise<{ token: string; record: AccessTokenSummary }> {
  const res = await authorizedFetch('/api/access/tokens', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  return readJson(res)
}

export async function revokeAccessToken(tokenId: string): Promise<AccessTokenSummary> {
  const res = await authorizedFetch(`/api/access/tokens/${encodeURIComponent(tokenId)}/revoke`, {
    method: 'POST',
  })
  return readJson(res)
}

export async function deleteAccessToken(tokenId: string): Promise<{ ok: true }> {
  const res = await authorizedFetch(`/api/access/tokens/${encodeURIComponent(tokenId)}`, {
    method: 'DELETE',
  })
  return readJson(res)
}

export async function revokeAccessSession(sessionId: string): Promise<AccessSessionSummary> {
  const res = await authorizedFetch(`/api/access/sessions/${encodeURIComponent(sessionId)}/revoke`, {
    method: 'POST',
  })
  return readJson(res)
}

export async function deleteAccessSession(sessionId: string): Promise<{ ok: true }> {
  const res = await authorizedFetch(`/api/access/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'DELETE',
  })
  return readJson(res)
}

export async function loginAccessAccount(data: {
  name: string
  password: string
}): Promise<{ token: string; session: AccessSessionSummary }> {
  const res = await fetch('/api/access/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  return readJson(res)
}

export async function logoutAccessSession(): Promise<{ ok: true }> {
  const res = await authorizedFetch('/api/access/logout', {
    method: 'POST',
  })
  return readJson(res)
}

export async function changeOwnPassword(data: {
  currentPassword: string
  newPassword: string
}): Promise<{ ok: true }> {
  const res = await authorizedFetch('/api/access/me/password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  return readJson(res)
}

export async function updateExplainSettings(data: {
  projectId: string
  model: string
  reasoningEffort: ModelReasoningEffort
}): Promise<AppConfig> {
  const res = await authorizedFetch('/api/config/preferences/explain', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  return readJson(res)
}

export async function updateDirectSettings(data: {
  projectId: string
  model: string
  reasoningEffort: ModelReasoningEffort
}): Promise<AppConfig> {
  const res = await authorizedFetch('/api/config/preferences/direct', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  return readJson(res)
}

export async function updateChatSettings(data: {
  projectId: string
  initialScrollTarget: ChatInitialScrollTarget
}): Promise<AppConfig> {
  const res = await authorizedFetch('/api/config/preferences/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  return readJson(res)
}

export async function updateRequestScreeningSettings(data: {
  model: string
}): Promise<AppConfig> {
  const res = await authorizedFetch('/api/config/requests/screening', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  return readJson(res)
}

export async function fetchTickets(projectId?: string): Promise<TicketSummary[]> {
  const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''
  const res = await authorizedFetch(`/api/tickets${query}`)
  return readJson(res)
}

export async function fetchTicket(id: string, signal?: AbortSignal): Promise<TicketDetail> {
  const res = await authorizedFetch(`/api/tickets/${id}`, { signal })
  return readJson(res)
}

export async function fetchTicketRun(ticketId: string, runId: string, signal?: AbortSignal): Promise<TicketRunDetail> {
  const res = await authorizedFetch(`/api/tickets/${ticketId}/runs/${runId}`, { signal })
  return readJson(res)
}

export async function createTicket(data: {
  title: string
  description: string
  projectId: string
  categoryId: string
  linkedRequestId?: string
}): Promise<{ ticketId: string; title: string; ticket: TicketDetail; run: TicketRunDetail | null }> {
  const res = await authorizedFetch('/api/tickets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  return readJson(res)
}

export async function retryTicket(
  ticketId: string,
  options?: {
    optionId?: string
    clarification?: string
  }
): Promise<{ ok: boolean }> {
  const optionId = options?.optionId
  const clarification = options?.clarification?.trim()
  const hasBody = Boolean(optionId || clarification)

  const res = await authorizedFetch(`/api/tickets/${ticketId}/retry`, {
    method: 'POST',
    headers: hasBody ? { 'Content-Type': 'application/json' } : undefined,
    body: hasBody
      ? JSON.stringify({
          optionId,
          clarification,
        })
      : undefined,
  })
  return readJson(res)
}

export async function stopTicket(ticketId: string): Promise<{ ok: boolean }> {
  const res = await authorizedFetch(`/api/tickets/${ticketId}/stop`, {
    method: 'POST',
  })
  return readJson(res)
}

export async function mergeTicket(ticketId: string): Promise<{
  ok: boolean
  warning?: string
  error?: string
  needsDecision?: boolean
  mergeBlock?: TicketMergeBlock
}> {
  const res = await authorizedFetch(`/api/tickets/${ticketId}/merge`, {
    method: 'POST',
  })
  return readMergeActionResult(res)
}

export async function resolveTicketMerge(ticketId: string, optionId: string): Promise<{
  ok: boolean
  warning?: string
  error?: string
  needsDecision?: boolean
  mergeBlock?: TicketMergeBlock
}> {
  const res = await authorizedFetch(`/api/tickets/${ticketId}/merge/resolve`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ optionId }),
  })
  return readMergeActionResult(res)
}

export async function discardTicket(ticketId: string): Promise<{ ok: boolean }> {
  const res = await authorizedFetch(`/api/tickets/${ticketId}/discard`, {
    method: 'POST',
  })
  return readJson(res)
}

export async function deleteTicket(ticketId: string): Promise<{ ok: boolean }> {
  const res = await authorizedFetch(`/api/tickets/${ticketId}`, {
    method: 'DELETE',
  })
  return readJson(res)
}

export async function fetchClientRequests(projectId?: string): Promise<ClientRequest[]> {
  const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''
  const res = await authorizedFetch(`/api/client-requests${query}`)
  return readJson(res)
}

export async function fetchIncidents(projectId?: string, ticketId?: string): Promise<IncidentSummary[]> {
  const params = new URLSearchParams()
  if (projectId) {
    params.set('projectId', projectId)
  }
  if (ticketId) {
    params.set('ticketId', ticketId)
  }

  const query = params.toString()
  const res = await authorizedFetch(`/api/incidents${query ? `?${query}` : ''}`)
  return readJson(res)
}

export async function fetchIncident(incidentId: string): Promise<IncidentDetail> {
  const res = await authorizedFetch(`/api/incidents/${incidentId}`)
  return readJson(res)
}

export async function analyzeIncident(incidentId: string): Promise<IncidentDetail> {
  const res = await authorizedFetch(`/api/incidents/${incidentId}/analyze`, {
    method: 'POST',
  })
  return readJson(res)
}

export async function deleteIncident(incidentId: string): Promise<{ ok: boolean }> {
  const res = await authorizedFetch(`/api/incidents/${incidentId}`, {
    method: 'DELETE',
  })
  return readJson(res)
}

export async function createClientRequest(data: {
  requester: string
  title: string
  template: RequestTemplateFields
  projectId: string
  categoryId: string
  source?: 'manual' | 'chat'
  explainThreadId?: string
}): Promise<ClientRequest> {
  const res = await authorizedFetch('/api/client-requests', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  return readJson(res)
}

export async function generateExplainRequestDraft(data: {
  projectId: string
  messages: Array<{
    role: 'user' | 'assistant'
    content: string
  }>
  model?: string
  reasoningEffort?: 'none' | 'low' | 'medium' | 'high' | 'xhigh'
  intent?: 'manual' | 'implementation_request'
  existingDraft?: GeneratedRequestDraft
}): Promise<GeneratedRequestDraft> {
  const res = await authorizedFetch('/api/chat/request-draft', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  return readJson(res)
}

export async function startExplainBackgroundRun(data: {
  projectId: string
  threadKey: string
  scopeLabel: string
  message: string
  threadId?: string
  model?: string
  reasoningEffort?: 'none' | 'low' | 'medium' | 'high' | 'xhigh'
  messages: Array<{ id: string; role: 'user' | 'assistant'; content: string }>
  drafts: Array<{
    id: string
    title: string
    categoryId: string
    template: RequestTemplateFields
    rationale?: string
    explainThreadId?: string
    status: 'drafting' | 'draft' | 'saving' | 'saved' | 'error'
    requestId?: string
    error?: string
    createdAt: string
    updatedAt: string
  }>
}): Promise<BackgroundRunStartResult> {
  const res = await authorizedFetch('/api/chat/runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  return readJson(res)
}

export async function startExplainRequestDraftRun(data: {
  projectId: string
  threadKey: string
  scopeLabel: string
  messages: Array<{ role: 'user' | 'assistant'; content: string }>
  model?: string
  reasoningEffort?: 'none' | 'low' | 'medium' | 'high' | 'xhigh'
  intent?: 'manual' | 'implementation_request'
  existingDraft?: GeneratedRequestDraft
  draft: {
    id: string
    title: string
    categoryId: string
    template: RequestTemplateFields
    rationale?: string
    explainThreadId?: string
    status: 'drafting' | 'draft' | 'saving' | 'saved' | 'error'
    requestId?: string
    error?: string
    createdAt: string
    updatedAt: string
  }
}): Promise<BackgroundRunStartResult> {
  const res = await authorizedFetch('/api/chat/request-draft-runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  return readJson(res)
}

export async function generateClientRequestDraft(data: {
  requester: string
  title: string
  template: RequestTemplateFields
  projectId: string
  categoryId: string
}): Promise<GeneratedRequestDraft> {
  const res = await authorizedFetch('/api/client-requests/draft', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  return readJson(res)
}

export async function startClientRequestDraftRun(data: {
  requester: string
  title: string
  template: RequestTemplateFields
  projectId: string
  categoryId: string
  scopeLabel?: string
}): Promise<BackgroundRunStartResult> {
  const res = await authorizedFetch('/api/client-requests/draft-runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  return readJson(res)
}

export async function startDirectBackgroundRun(data: {
  message: string
  threadId?: string
  projectId: string
  model?: string
  reasoningEffort?: 'none' | 'low' | 'medium' | 'high' | 'xhigh'
  agentRole?: string
  sessionMessages?: Array<{ id: string; role: 'user' | 'assistant'; content: string }>
  sessionId: string
  scopeLabel: string
  messages: Array<{ id: string; role: 'user' | 'assistant'; content: string }>
}): Promise<BackgroundRunStartResult> {
  const res = await authorizedFetch('/api/direct/runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  return readJson(res)
}

export async function fetchBackgroundRuns(projectId: string): Promise<BackgroundRunSummary[]> {
  const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''
  const res = await authorizedFetch(`/api/background-runs${query}`)
  const payload = await readJson<{ runs?: BackgroundRunSummary[] }>(res)
  return payload.runs ?? []
}

export async function fetchBackgroundRun(runId: string): Promise<BackgroundRunSummary> {
  const res = await authorizedFetch(`/api/background-runs/${encodeURIComponent(runId)}`)
  return readJson(res)
}

export async function stopBackgroundRun(runId: string): Promise<BackgroundRunSummary> {
  const res = await authorizedFetch(`/api/background-runs/${encodeURIComponent(runId)}/stop`, {
    method: 'POST',
  })
  return readJson(res)
}

export async function createTicketFromClientRequest(
  requestId: string
): Promise<{ requestId: string; ticket: TicketDetail; run: TicketRunDetail | null }> {
  const res = await authorizedFetch(`/api/client-requests/${requestId}/create-ticket`, {
    method: 'POST',
  })
  return readJson(res)
}

export async function deleteClientRequest(requestId: string): Promise<{ ok: boolean }> {
  const res = await authorizedFetch(`/api/client-requests/${requestId}`, {
    method: 'DELETE',
  })
  return readJson(res)
}
