import { useEffect, useMemo, useState } from 'react'
import type {
  AppConfig,
  PublicVerificationRun,
  ReviewRun,
  StageReview,
  TicketFlowAgent,
  TicketCategory,
  TicketDetail,
  TicketMergeIssueKind,
  TicketMergeResolutionAction,
  TicketRunDetail,
  TicketTimelineEvent,
} from '../lib/api'
import { createTicket } from '../lib/api'
import { resolveAttemptNumber } from '../lib/ticket-attempts'
import { useTicket } from '../hooks/useTicket'
import { MarkdownContent } from './MarkdownContent'
import { TicketStepPanel } from './TicketStepPanel'
import { isLiveTimelineEntry, TicketTimelineModal } from './TicketTimelineModal'
import { WorkspaceHeader } from './WorkspaceHeader'

interface TicketViewProps {
  projectId: string
  config: AppConfig
  ticketCount: number
  isCreatingTicket: boolean
  selectedTicketId: string | null
  onTicketCreated: (id: string) => void
  onTicketDeleted: () => void
  onProjectChange: (projectId: string) => void
  onStartCreate: () => void
  onCancelCreate: () => void
  onRefresh: () => void
  onConfigUpdated: () => Promise<void> | void
  onOpenIncident: (ticketId: string) => Promise<void> | void
}

function statusBadge(status: string) {
  if (status === 'completed') return 'bg-green-900 text-green-300'
  if (status === 'awaiting_merge') return 'bg-emerald-900 text-emerald-300'
  if (status === 'running') return 'bg-blue-900 text-blue-300'
  if (status === 'queued') return 'bg-sky-900 text-sky-300'
  if (status === 'stopped') return 'bg-orange-900 text-orange-300'
  if (status === 'blocked') return 'bg-amber-900 text-amber-300'
  if (status === 'needs_decision' || status === 'needs_request_clarification') {
    return 'bg-amber-900 text-amber-300'
  }
  if (status === 'failed' || status === 'discarded') return 'bg-red-900 text-red-300'
  return 'bg-zinc-800 text-zinc-400'
}

function statusLabel(status: string) {
  if (status === 'created') return '준비됨'
  if (status === 'queued') return '대기 중'
  if (status === 'running') return '실행 중'
  if (status === 'stopped') return '중단됨'
  if (status === 'blocked') return '일시 중단'
  if (status === 'needs_decision') return '결정 필요'
  if (status === 'needs_request_clarification') return '요구사항 보완 필요'
  if (status === 'awaiting_merge') return '머지 대기'
  if (status === 'completed') return '완료'
  if (status === 'discarded') return '폐기됨'
  if (status === 'failed') return '실패'
  return status
}

function repairLoopGateLabel(gate: 'verify' | 'review' | 'merge') {
  if (gate === 'verify') return '검증 수선'
  if (gate === 'review') return '리뷰 수선'
  return 'merge 재검증'
}

function repairLoopStatusLabel(status: 'repairing' | 'waiting_verify' | 'waiting_review') {
  if (status === 'repairing') return '구현 수정 중'
  if (status === 'waiting_verify') return '검증 대기'
  return '리뷰 대기'
}

function mergeFeedbackToneClasses(tone: 'success' | 'warning' | 'info' | 'error') {
  if (tone === 'success') {
    return 'border border-green-900/60 bg-green-950/20 text-green-100'
  }

  if (tone === 'warning') {
    return 'border border-amber-900/60 bg-amber-950/20 text-amber-100'
  }

  if (tone === 'error') {
    return 'border border-red-900/60 bg-red-950/20 text-red-100'
  }

  return 'border border-sky-900/60 bg-sky-950/20 text-sky-100'
}

function mergeIssueLabel(issue: TicketMergeIssueKind) {
  if (issue === 'base_branch_changed') return '기준 브랜치 변경'
  if (issue === 'base_commit_changed') return '기준 커밋 전진'
  if (issue === 'head_changed_after_review') return 'review 이후 HEAD 변경'
  if (issue === 'rebase_conflict_text') return '문서/텍스트 rebase 충돌'
  if (issue === 'rebase_conflict_code') return '코드 rebase 충돌'
  if (issue === 'rebase_failed') return 'rebase 실패'
  if (issue === 'merge_conflict') return 'merge 충돌'
  return 'merge 문제'
}

function mergeResolutionDescription(action: TicketMergeResolutionAction) {
  if (action === 'rebase_and_revalidate') {
    return '현재 worktree 커밋을 유지한 채 최신 기준 브랜치 위로 rebase하고 verify/review를 다시 실행합니다.'
  }

  if (action === 'revalidate_current_worktree') {
    return '현재 worktree 상태를 그대로 두고 verify/review만 다시 실행합니다.'
  }

  if (action === 'reapply_on_latest_base') {
    return '최신 main 기준 새 run에서 기존 reviewed 변경 의도만 다시 적용한 뒤 verify/review를 다시 진행합니다.'
  }

  if (action === 'restart_from_plan') {
    return '현재 기준 브랜치에서 새 run을 만들고 plan 단계부터 다시 시작합니다.'
  }

  return '현재 worktree를 폐기하고 이 작업을 더 진행하지 않습니다.'
}

function compactText(text?: string, maxLength = 140) {
  const normalized = (text ?? '').replace(/\s+/g, ' ').trim()
  if (!normalized) {
    return ''
  }

  if (normalized.length <= maxLength) {
    return normalized
  }

  return `${normalized.slice(0, maxLength - 1)}…`
}

function attemptHistoryStatusBadge(status: 'success' | 'failed' | 'running' | 'pending') {
  if (status === 'success') return 'border-green-900/60 bg-green-950/30 text-green-300'
  if (status === 'failed') return 'border-red-900/60 bg-red-950/30 text-red-300'
  if (status === 'running') return 'border-blue-900/60 bg-blue-950/30 text-blue-300'
  return 'border-zinc-800 bg-zinc-900 text-zinc-300'
}

function attemptHistoryStatusLabel(status: 'success' | 'failed' | 'running' | 'pending') {
  if (status === 'success') return '성공'
  if (status === 'failed') return '실패'
  if (status === 'running') return '진행 중'
  return '대기'
}

function attemptStepStatusBadge(status: string) {
  if (status === 'passed' || status === 'pass' || status === 'done') {
    return 'border-green-900/60 bg-green-950/30 text-green-300'
  }

  if (status === 'failed' || status === 'fail') {
    return 'border-red-900/60 bg-red-950/30 text-red-300'
  }

  if (status === 'running') {
    return 'border-blue-900/60 bg-blue-950/30 text-blue-300'
  }

  return 'border-zinc-800 bg-zinc-900 text-zinc-400'
}

function attemptStepStatusLabel(status: string) {
  if (status === 'passed' || status === 'pass') return '통과'
  if (status === 'done') return '완료'
  if (status === 'failed' || status === 'fail') return '실패'
  if (status === 'running') return '실행 중'
  return status || '대기'
}

function currentPhaseLabelForDisplay(currentPhase: string | null, displayPhases: FlowPhaseDisplay[]) {
  if (!currentPhase) {
    return 'idle'
  }

  return displayPhases.find((phase) => phase.id === currentPhase)?.name ?? currentPhase
}

function currentPhaseAgentForDisplay(currentPhase: string | null, displayPhases: FlowPhaseDisplay[]) {
  if (!currentPhase) {
    return undefined
  }

  return displayPhases.find((phase) => phase.id === currentPhase)?.agent
}

function formatAgentRole(role?: string) {
  if (!role) {
    return undefined
  }

  if (role === 'planner') return 'Plan'
  if (role === 'builder') return 'Build'
  if (role === 'reviewer') return 'Review'
  if (role === 'verifier') return 'Verify'
  if (role === 'coordinator') return 'Coordinate'
  return role
}

interface FlowPhaseDisplay {
  id: string
  name: string
  agent?: TicketFlowAgent
  sourceStepId?: string
  subjectStepId?: 'analyze' | 'plan'
}

function buildFlowPhaseDisplay(
  steps: TicketCategory['steps'],
  options?: { reviewAgent?: TicketFlowAgent }
): FlowPhaseDisplay[] {
  const phases: FlowPhaseDisplay[] = []
  const reviewAgent = options?.reviewAgent

  for (const step of steps) {
    phases.push({
      id: step.id,
      name: step.name,
      agent: step.agent,
      sourceStepId: step.id,
    })

    if (step.id === 'analyze') {
      phases.push({
        id: 'analyze_review',
        name: 'Analyze Review',
        agent: reviewAgent,
        subjectStepId: 'analyze',
      })
    }

    if (step.id === 'plan') {
      phases.push({
        id: 'plan_review',
        name: 'Plan Review',
        agent: reviewAgent,
        subjectStepId: 'plan',
      })
    }
  }

  return phases
}

function getLatestStageReview(reviews: StageReview[], subjectStepId: 'analyze' | 'plan') {
  return [...reviews].reverse().find((review) => review.subjectStepId === subjectStepId)
}

interface AttemptHistoryStep {
  id: 'implement' | 'verify' | 'review'
  label: string
  status: string
  summary: string
  entry: TicketTimelineEvent | null
}

interface AttemptHistoryGroup {
  attempt: number
  status: 'success' | 'failed' | 'running' | 'pending'
  outcome: string
  steps: AttemptHistoryStep[]
  contextEntries: TicketTimelineEvent[]
}

interface AttemptHistoryDraft {
  attempt: number
  implementEntry: TicketTimelineEvent | null
  verifyEntry: TicketTimelineEvent | null
  reviewEntry: TicketTimelineEvent | null
  verificationRun: PublicVerificationRun | null
  reviewRun: ReviewRun | null
  contextEntries: TicketTimelineEvent[]
}

function buildImplementAttemptSummary(entry: TicketTimelineEvent | null) {
  if (!entry) {
    return '구현 기록이 아직 없습니다.'
  }

  if (entry.status === 'running') {
    return compactText(entry.body, 120) || '구현을 진행 중입니다.'
  }

  if (entry.status === 'done') {
    return '구현을 마쳤습니다.'
  }

  return compactText(entry.title, 120) || '구현 기록이 있습니다.'
}

function buildVerificationAttemptSummary(run: PublicVerificationRun | null, entry: TicketTimelineEvent | null) {
  if (run) {
    if (run.diagnosis?.summary) {
      return compactText(run.diagnosis.summary, 140)
    }

    const failedCount = run.commands.filter((command) => command.status === 'failed').length
    const commandCount = run.commands.length

    if (run.status === 'passed') {
      return commandCount > 0 ? `${commandCount}개 검증 명령을 통과했습니다.` : '자동 검증을 통과했습니다.'
    }

    if (failedCount > 0) {
      return `${failedCount}개 명령이 실패했습니다.`
    }

    return '자동 검증이 실패했습니다.'
  }

  if (!entry) {
    return '검증 기록이 아직 없습니다.'
  }

  if (entry.status === 'running') {
    return '자동 검증을 진행 중입니다.'
  }

  return compactText(entry.title, 120) || '자동 검증 기록이 있습니다.'
}

function buildReviewAttemptSummary(run: ReviewRun | null, entry: TicketTimelineEvent | null) {
  if (run) {
    return compactText(run.summary, 140) || (run.verdict === 'pass' ? '코드 리뷰를 통과했습니다.' : '코드 리뷰가 실패했습니다.')
  }

  if (!entry) {
    return '리뷰 기록이 아직 없습니다.'
  }

  if (entry.status === 'running') {
    return '코드 리뷰를 진행 중입니다.'
  }

  return compactText(entry.body || entry.title, 140) || '코드 리뷰 기록이 있습니다.'
}

function buildAttemptHistory(run: TicketRunDetail | null): AttemptHistoryGroup[] {
  if (!run) {
    return []
  }

  const attempts = new Set<number>()

  for (let attempt = 1; attempt <= run.attemptCount; attempt += 1) {
    attempts.add(attempt)
  }

  for (const verificationRun of run.verificationRuns) {
    attempts.add(verificationRun.attempt)
  }

  for (const reviewRun of run.reviewRuns) {
    attempts.add(reviewRun.attempt)
  }

  for (const entry of run.timeline) {
    if (entry.attempt != null && (entry.stepId === 'implement' || entry.stepId === 'verify' || entry.stepId === 'review')) {
      attempts.add(entry.attempt)
    }
  }

  if (attempts.size === 0) {
    return []
  }

  const drafts = new Map<number, AttemptHistoryDraft>()

  const ensureDraft = (attempt: number) => {
    let draft = drafts.get(attempt)

    if (!draft) {
      draft = {
        attempt,
        implementEntry: null,
        verifyEntry: null,
        reviewEntry: null,
        verificationRun: null,
        reviewRun: null,
        contextEntries: [],
      }
      drafts.set(attempt, draft)
    }

    return draft
  }

  let currentAttempt: number | null = null

  for (const entry of run.timeline) {
    if (entry.attempt != null && (entry.stepId === 'implement' || entry.stepId === 'verify' || entry.stepId === 'review')) {
      const draft = ensureDraft(entry.attempt)
      currentAttempt = entry.attempt

      if (entry.stepId === 'implement') {
        draft.implementEntry = entry
      }

      if (entry.stepId === 'verify') {
        draft.verifyEntry = entry
      }

      if (entry.stepId === 'review') {
        draft.reviewEntry = entry
      }

      continue
    }

    if (entry.type === 'system' && currentAttempt != null) {
      ensureDraft(currentAttempt).contextEntries.push(entry)
    }
  }

  for (const verificationRun of run.verificationRuns) {
    ensureDraft(verificationRun.attempt).verificationRun = verificationRun
  }

  for (const reviewRun of run.reviewRuns) {
    ensureDraft(reviewRun.attempt).reviewRun = reviewRun
  }

  return Array.from(drafts.values())
    .sort((left, right) => left.attempt - right.attempt)
    .map((draft) => {
      const steps: AttemptHistoryStep[] = [
        {
          id: 'implement',
          label: 'Implement',
          status: draft.implementEntry?.status ?? 'pending',
          summary: buildImplementAttemptSummary(draft.implementEntry),
          entry: draft.implementEntry,
        },
      ]

      if (draft.verifyEntry || draft.verificationRun) {
        steps.push({
          id: 'verify',
          label: 'Verify',
          status: draft.verificationRun?.status ?? draft.verifyEntry?.status ?? 'pending',
          summary: buildVerificationAttemptSummary(draft.verificationRun, draft.verifyEntry),
          entry: draft.verifyEntry,
        })
      }

      if (draft.reviewEntry || draft.reviewRun) {
        steps.push({
          id: 'review',
          label: 'Review',
          status: draft.reviewRun?.verdict ?? draft.reviewEntry?.status ?? 'pending',
          summary: buildReviewAttemptSummary(draft.reviewRun, draft.reviewEntry),
          entry: draft.reviewEntry,
        })
      }

      const latestContextEntry = draft.contextEntries.at(-1) ?? null
      let status: AttemptHistoryGroup['status'] = 'pending'
      let outcome = '구현을 시작했습니다.'

      if (draft.reviewRun?.verdict === 'pass' || draft.reviewEntry?.status === 'pass') {
        status = 'success'
        outcome = '리뷰를 통과하고 최종 단계로 진행했습니다.'
      } else if (
        draft.reviewRun?.verdict === 'fail' ||
        draft.reviewEntry?.status === 'fail' ||
        draft.reviewEntry?.status === 'failed'
      ) {
        status = 'failed'
        outcome = compactText(latestContextEntry?.title, 140) || '리뷰 피드백으로 다시 작업이 필요해졌습니다.'
      } else if (draft.reviewEntry?.status === 'running') {
        status = 'running'
        outcome = '코드 리뷰를 진행 중입니다.'
      } else if (draft.verificationRun?.status === 'failed' || draft.verifyEntry?.status === 'failed') {
        status = 'failed'
        outcome = compactText(latestContextEntry?.title, 140) || '자동 검증을 통과하지 못했습니다.'
      } else if (draft.verifyEntry?.status === 'running') {
        status = 'running'
        outcome = '자동 검증을 진행 중입니다.'
      } else if (draft.verificationRun?.status === 'passed') {
        outcome = '자동 검증을 통과했습니다.'
      } else if (draft.implementEntry?.status === 'running') {
        status = 'running'
        outcome = '구현을 진행 중입니다.'
      } else if (draft.implementEntry?.status === 'done') {
        outcome = '구현을 마쳤습니다.'
      }

      return {
        attempt: draft.attempt,
        status,
        outcome,
        steps,
        contextEntries: draft.contextEntries.slice(-2),
      }
    })
}

function getPhaseOutput(run: TicketRunDetail | null, phase: FlowPhaseDisplay, streamingOutputs: Record<string, string>) {
  if (phase.subjectStepId) {
    const latestReview = getLatestStageReview(run?.stageReviews ?? [], phase.subjectStepId)
    return `${latestReview?.output || ''}${streamingOutputs[phase.id] || ''}`
  }

  const sourceStepId = phase.sourceStepId ?? phase.id
  return `${run?.steps[sourceStepId]?.output || ''}${streamingOutputs[phase.id] || ''}`
}

function getPhaseStatus(
  ticket: TicketDetail | null,
  run: TicketRunDetail | null,
  phase: FlowPhaseDisplay,
  currentStep: string | null,
  isStreaming: boolean
) {
  if (!ticket) {
    return 'pending'
  }

  const isActivePhase =
    (currentStep === phase.id || run?.currentPhase === phase.id) && (isStreaming || ticket.runState === 'running')

  if (isActivePhase) {
    return 'running'
  }

  if (phase.subjectStepId) {
    const latestReview = getLatestStageReview(run?.stageReviews ?? [], phase.subjectStepId)
    if (!latestReview) {
      return 'pending'
    }

    return latestReview.verdict === 'pass' ? 'done' : 'failed'
  }

  return run?.steps[phase.sourceStepId ?? phase.id]?.status || 'pending'
}

function createCollapsedPanelState(panelIds: string[]) {
  return Object.fromEntries(panelIds.map((panelId) => [panelId, false]))
}

function syncCollapsedPanelState(current: Record<string, boolean>, panelIds: string[]) {
  const next: Record<string, boolean> = {}

  for (const panelId of panelIds) {
    next[panelId] = current[panelId] ?? false
  }

  return next
}

export function TicketView({
  projectId,
  config,
  ticketCount,
  isCreatingTicket,
  selectedTicketId,
  onTicketCreated,
  onTicketDeleted,
  onProjectChange,
  onStartCreate,
  onCancelCreate,
  onRefresh,
  onConfigUpdated,
  onOpenIncident,
}: TicketViewProps) {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [clarificationInput, setClarificationInput] = useState('')
  const [categoryId, setCategoryId] = useState(config.flows.ticket.categories[0]?.id ?? '')
  const [selectedAttempt, setSelectedAttempt] = useState<number | null>(null)
  const [selectedTimelineEventId, setSelectedTimelineEventId] = useState<string | null>(null)
  const [isStopping, setIsStopping] = useState(false)
  const [panelOpenState, setPanelOpenState] = useState<Record<string, boolean>>({})
  const [mergeFeedback, setMergeFeedback] = useState<{
    tone: 'success' | 'warning' | 'info' | 'error'
    message: string
  } | null>(null)
  const {
    ticket,
    run,
    selectedRunId,
    selectRun,
    currentStep,
    streamingOutputs,
    isStreaming,
    loadTicket,
    connectToTicketStream,
    merge,
    resolveMerge,
    discard,
    remove,
    retry,
    stop,
    abort,
  } = useTicket()

  useEffect(() => {
    if (!selectedTicketId) {
      abort()
      return
    }

    let disposed = false

    void loadTicket(selectedTicketId)
      .then((result) => {
        if (!disposed && result) {
          void connectToTicketStream(selectedTicketId)
        }
      })
      .catch((error) => {
        if (error.name !== 'AbortError') {
          console.error('Failed to load ticket:', error)
        }
      })

    return () => {
      disposed = true
      abort()
    }
  }, [selectedTicketId, loadTicket, connectToTicketStream, abort])

  useEffect(() => {
    if (!config.flows.ticket.categories.some((category) => category.id === categoryId)) {
      setCategoryId(config.flows.ticket.categories[0]?.id ?? '')
    }
  }, [categoryId, config])

  useEffect(() => {
    if (ticket?.updatedAt) {
      onRefresh()
    }
  }, [ticket?.updatedAt])

  useEffect(() => {
    setSelectedTimelineEventId(null)
  }, [selectedTicketId])

  useEffect(() => {
    setClarificationInput('')
  }, [selectedTicketId])

  useEffect(() => {
    setMergeFeedback(null)
  }, [selectedTicketId])

  useEffect(() => {
    setSelectedAttempt(null)
  }, [selectedRunId, selectedTicketId])

  const activeCategory = useMemo(() => {
    const sourceCategoryId = ticket?.categoryId ?? categoryId
    return config.flows.ticket.categories.find((category) => category.id === sourceCategoryId)
  }, [categoryId, config, ticket])

  const reviewAgent = activeCategory?.steps.find((step) => step.id === 'review')?.agent

  const displayPhases = useMemo(() => {
    return activeCategory ? buildFlowPhaseDisplay(activeCategory.steps, { reviewAgent }) : []
  }, [activeCategory, reviewAgent])

  const currentPhaseLabel = useMemo(
    () => currentPhaseLabelForDisplay(run?.currentPhase ?? ticket?.currentPhase ?? null, displayPhases),
    [displayPhases, run?.currentPhase, ticket?.currentPhase]
  )

  const currentPhaseAgent = useMemo(
    () => currentPhaseAgentForDisplay(run?.currentPhase ?? ticket?.currentPhase ?? null, displayPhases),
    [displayPhases, run?.currentPhase, ticket?.currentPhase]
  )

  const phasePanels = useMemo(
    () =>
      displayPhases.map((phase) => ({
        ...phase,
        output: getPhaseOutput(run, phase, streamingOutputs),
        status: ticket ? getPhaseStatus(ticket, run, phase, currentStep, isStreaming) : 'pending',
      })),
    [currentStep, displayPhases, isStreaming, run, streamingOutputs, ticket]
  )

  const finalReportOutput = run?.finalReport?.output ?? ''

  const panelIds = useMemo(
    () => [...phasePanels.map((phase) => phase.id), ...(run?.finalReport ? ['final-report'] : [])],
    [phasePanels, run?.finalReport]
  )

  const flowStepExpandableIds = useMemo(
    () => phasePanels.filter((phase) => phase.output.trim().length > 0).map((phase) => phase.id),
    [phasePanels]
  )

  const hasOpenFlowStep = flowStepExpandableIds.some((panelId) => panelOpenState[panelId])

  useEffect(() => {
    setPanelOpenState(createCollapsedPanelState(panelIds))
  }, [displayPhases, selectedRunId, selectedTicketId])

  useEffect(() => {
    setPanelOpenState((current) => syncCollapsedPanelState(current, panelIds))
  }, [panelIds])

  const planningBlockMessage = useMemo(() => {
    if (!ticket?.planningBlock) {
      return null
    }

    if (ticket.planningBlock.source === 'review') {
      if (ticket.status === 'needs_decision') {
        return {
          title: '리뷰 피드백을 반영하는 방법을 선택해야 합니다.',
          action: '선택 후 새 run 시작',
        }
      }

      if (ticket.status === 'needs_request_clarification') {
        return {
          title: '리뷰를 해결하려면 요구사항 보완이 먼저 필요합니다.',
          action: '보완 후 계획부터 다시 시작',
        }
      }
    }

    if (ticket.planningBlock.source === 'verify') {
      if (ticket.status === 'needs_decision') {
        return {
          title: '자동 검증 실패를 어떻게 반영할지 선택해야 합니다.',
          action: '선택 후 새 run 시작',
        }
      }

      if (ticket.status === 'needs_request_clarification') {
        return {
          title: '자동 검증 실패를 해결하려면 요구사항 보완이 먼저 필요합니다.',
          action: '보완 후 계획부터 다시 시작',
        }
      }
    }

    if (ticket?.status === 'needs_decision') {
      return {
        title: '계획을 계속 진행하려면 결정이 필요합니다.',
        action: '결정 반영 후 다시 시도',
      }
    }

    if (ticket?.status === 'needs_request_clarification') {
      return {
        title: '계획을 계속 진행하려면 요구사항 보완이 필요합니다.',
        action: '요구사항 보완 후 다시 시도',
      }
    }

    return null
  }, [ticket?.planningBlock, ticket?.status])

  const selectedTimelineEvent = useMemo(() => {
    if (!run || !selectedTimelineEventId) {
      return null
    }

    return run.timeline.find((entry) => entry.id === selectedTimelineEventId) ?? null
  }, [selectedTimelineEventId, run])

  const attemptHistory = useMemo(() => buildAttemptHistory(run), [run])
  const implementAttempts = useMemo(() => attemptHistory.map((attemptGroup) => attemptGroup.attempt), [attemptHistory])
  const verificationAttempts = useMemo(
    () => run?.verificationRuns.map((verificationRun) => verificationRun.attempt) ?? [],
    [run?.verificationRuns]
  )
  const defaultSelectedAttempt = useMemo(
    () => resolveAttemptNumber(verificationAttempts, null) ?? resolveAttemptNumber(implementAttempts, null),
    [implementAttempts, verificationAttempts]
  )

  useEffect(() => {
    setSelectedAttempt((current) => {
      if (implementAttempts.length === 0) {
        return null
      }

      if (current != null && implementAttempts.includes(current)) {
        return current
      }

      return defaultSelectedAttempt
    })
  }, [defaultSelectedAttempt, implementAttempts])

  const handleCreate = async () => {
    if (!title.trim() || !description.trim() || !categoryId || !projectId) return

    const result = await createTicket({
      title,
      description,
      projectId,
      categoryId,
    })
    setTitle('')
    setDescription('')
    onTicketCreated(result.ticketId)
  }

  const handleMerge = async () => {
    if (!ticket) return
    const result = await merge(ticket.id)
    if (result.ok) {
      setMergeFeedback({
        tone: result.warning ? 'warning' : 'success',
        message: result.warning ?? '머지가 완료되어 변경사항이 main 브랜치에 반영되었습니다.',
      })
    } else if (result.needsDecision) {
      setMergeFeedback({
        tone: 'info',
        message: result.error ?? '자동 merge가 막혀 복구 경로 선택이 필요합니다.',
      })
    } else if (result.error) {
      setMergeFeedback({
        tone: 'error',
        message: result.error,
      })
    }
    onRefresh()
  }

  const handleDiscard = async () => {
    if (!ticket) return
    await discard(ticket.id)
    setMergeFeedback({
      tone: 'info',
      message: '머지 대기 중이던 worktree를 폐기했습니다.',
    })
    onRefresh()
  }

  const handleResolveMerge = async (optionId: string) => {
    if (!ticket) return

    const result = await resolveMerge(ticket.id, optionId)
    if (result.ok) {
      setMergeFeedback({
        tone: 'info',
        message: '선택한 merge 복구 경로로 티켓을 다시 실행합니다.',
      })
    } else if (result.needsDecision) {
      setMergeFeedback({
        tone: 'info',
        message: result.error ?? 'merge 복구 경로를 다시 선택해야 합니다.',
      })
    } else if (result.error) {
      setMergeFeedback({
        tone: 'error',
        message: result.error,
      })
    }

    onRefresh()
  }

  const handleRetry = async (options?: { optionId?: string; clarification?: string }) => {
    if (!ticket) return
    await retry(ticket.id, options)
    if (options?.clarification?.trim()) {
      setClarificationInput('')
    }
    onRefresh()
  }

  const handleStop = async () => {
    if (!ticket || isStopping) return

    setIsStopping(true)
    try {
      await stop(ticket.id)
      onRefresh()
    } finally {
      setIsStopping(false)
    }
  }

  const handleDelete = async () => {
    if (!ticket) return
    await remove(ticket.id)
    onTicketDeleted()
    onRefresh()
  }

  const handleTogglePanel = (panelId: string) => {
    setPanelOpenState((current) => ({
      ...current,
      [panelId]: !current[panelId],
    }))
  }

  const handleToggleAllFlowSteps = () => {
    setPanelOpenState((current) => {
      const next = { ...current }
      const nextValue = !hasOpenFlowStep

      for (const panelId of flowStepExpandableIds) {
        next[panelId] = nextValue
      }

      return next
    })
  }

  const canDeleteTicket = ticket ? ticket.runState !== 'queued' && ticket.runState !== 'running' : false
  const needsClarification = ticket?.status === 'needs_request_clarification'
  const selectedProject = config.allowedProjects.find((project) => project.id === projectId)
  const ticketSubtitle = isCreatingTicket
    ? '새 ticket을 생성합니다'
    : selectedTicketId
      ? '선택한 ticket을 검토합니다'
      : ticketCount > 0
        ? '가장 최근 ticket을 불러오는 중입니다'
        : '프로젝트 ticket이 아직 없습니다'
  const ticketHeader = (
    <WorkspaceHeader
      authSession={config.auth.session}
      projects={config.allowedProjects}
      projectId={projectId}
      onProjectChange={onProjectChange}
      onConfigUpdated={onConfigUpdated}
      title="Ticket"
      subtitle={ticketSubtitle}
    />
  )

  if (isCreatingTicket) {
    return (
      <div className="flex h-full flex-col">
        {ticketHeader}
        <div className="flex flex-1 items-center justify-center p-6">
          <div className="w-full max-w-2xl">
            <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-bold">New Ticket</h2>
                <p className="mt-1 text-xs text-zinc-500">티켓 목록과 상세는 그대로 두고, 새 티켓을 만들 때만 이 화면으로 들어옵니다.</p>
              </div>
              <button
                onClick={onCancelCreate}
                className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 transition-colors hover:bg-zinc-800"
              >
                {ticketCount > 0 ? 'Back to Latest' : 'Back'}
              </button>
            </div>
            <div className="mb-3 grid grid-cols-1 gap-4 md:grid-cols-2">
              <div>
                <label className="mb-1 block text-xs text-zinc-400">Current Project</label>
                <div className="mb-3 rounded-lg border border-zinc-800 bg-zinc-900/50 px-4 py-2 text-sm text-zinc-200">
                  {selectedProject?.label ?? 'No accessible projects'}
                </div>
                <label className="mb-1 block text-xs text-zinc-400">Category</label>
                <select
                  value={categoryId}
                  onChange={(e) => setCategoryId(e.target.value)}
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-2 text-sm focus:border-zinc-500 focus:outline-none"
                >
                  {config.flows.ticket.categories.map((category) => (
                    <option key={category.id} value={category.id}>
                      {category.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 px-4 py-3">
                <p className="mb-1 text-xs text-zinc-400">Selected Flow</p>
                <p className="mb-2 text-sm text-zinc-200">{activeCategory?.description}</p>
                <div className="flex flex-wrap gap-2">
                  {displayPhases.map((phase) => (
                    <span key={phase.id} className="rounded-full bg-zinc-800 px-2 py-1 text-xs text-zinc-300">
                      {phase.name}
                      {phase.agent ? ` · ${phase.agent.displayName}` : ''}
                    </span>
                  ))}
                </div>
                <p className="mt-3 text-xs text-zinc-500">
                  티켓 생성 직후 자동으로 analyze부터 시작하고, 모든 review/verify를 통과하면 merge 대기 상태로 전환됩니다.
                </p>
              </div>
            </div>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Ticket title"
              className="mb-3 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-2 text-sm placeholder-zinc-500 focus:border-zinc-500 focus:outline-none"
            />
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Describe what you want to change..."
              rows={6}
              className="mb-3 w-full resize-none rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-2 text-sm placeholder-zinc-500 focus:border-zinc-500 focus:outline-none"
            />
            <button
              onClick={handleCreate}
              disabled={!title.trim() || !description.trim() || !categoryId || !projectId}
              className="w-full rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium transition-colors hover:bg-blue-700 disabled:bg-zinc-700 disabled:text-zinc-500"
            >
              Create Ticket
            </button>
          </div>
        </div>
      </div>
    )
  }

  if (!selectedTicketId) {
    return (
      <div className="flex h-full flex-col">
        {ticketHeader}
        <div className="flex flex-1 items-center justify-center p-6">
          <div className="w-full max-w-3xl rounded-2xl border border-zinc-800 bg-zinc-900/50 p-8 text-center">
            <p className="text-sm font-medium text-zinc-200">
              {ticketCount > 0 ? '가장 최근 ticket을 여는 중입니다.' : '아직 ticket이 없습니다.'}
            </p>
            <p className="mt-2 text-sm text-zinc-500">
              {ticketCount > 0
                ? '잠시 뒤에도 바뀌지 않으면 왼쪽 목록에서 ticket을 직접 선택할 수 있습니다.'
                : '새 작업을 시작할 때만 ticket 생성 화면으로 들어가면 됩니다.'}
            </p>
            <button
              onClick={onStartCreate}
              className="mt-5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700"
            >
              New Ticket
            </button>
          </div>
        </div>
      </div>
    )
  }

  if (!ticket || ticket.id !== selectedTicketId) {
    return (
      <div className="flex h-full flex-col">
        {ticketHeader}
        <div className="flex flex-1 items-center justify-center p-6">
          <div className="text-center">
            <p className="text-sm text-zinc-400">티켓을 불러오는 중...</p>
          </div>
        </div>
      </div>
    )
  }

  const ticketCategory = config.flows.ticket.categories.find((category) => category.id === ticket.categoryId) as
    | TicketCategory
    | undefined

  return (
    <>
      <div className="flex h-full flex-col">
        {ticketHeader}
        <div className="flex-1 overflow-y-auto p-6">
          <div className="mx-auto max-w-6xl">
          <div className="mb-6">
            <div className="mb-1 flex flex-wrap items-center gap-2">
              <span className="text-xs font-mono text-zinc-500">{ticket.id}</span>
              <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-xs text-zinc-300">
                {ticketCategory?.label ?? ticket.categoryId}
              </span>
              <span className={`rounded-full px-2 py-0.5 text-xs ${statusBadge(ticket.runState)}`}>
                {statusLabel(ticket.runState)}
              </span>
              {ticket.recoveryRequired && (
                <span className="rounded-full bg-red-950/40 px-2 py-0.5 text-xs text-red-300">
                  recovery required
                </span>
              )}
              {(ticket.runState === 'queued' || ticket.runState === 'running') && (
                <button
                  onClick={handleStop}
                  disabled={isStopping}
                  className="ml-auto rounded bg-amber-700 px-3 py-1 text-xs font-medium text-amber-50 transition-colors hover:bg-amber-600 disabled:bg-zinc-800 disabled:text-zinc-500"
                >
                  {isStopping ? '중단 중' : '중단'}
                </button>
              )}
              <button
                onClick={onStartCreate}
                className={`${ticket.runState === 'queued' || ticket.runState === 'running' ? '' : 'ml-auto '}rounded border border-zinc-700 bg-zinc-900 px-3 py-1 text-xs font-medium text-zinc-200 transition-colors hover:bg-zinc-800`}
              >
                New Ticket
              </button>
              <button
                onClick={handleDelete}
                disabled={!canDeleteTicket}
                aria-label="Delete ticket"
                className="inline-flex h-8 w-8 items-center justify-center rounded border border-zinc-700 bg-zinc-900 text-zinc-300 transition-colors hover:border-red-800 hover:bg-red-950/30 hover:text-red-200 disabled:border-zinc-800 disabled:bg-zinc-900 disabled:text-zinc-600 disabled:hover:border-zinc-800 disabled:hover:bg-zinc-900 disabled:hover:text-zinc-600"
                title={!canDeleteTicket ? '실행 중인 ticket은 삭제할 수 없습니다.' : 'Delete ticket'}
              >
                <svg
                  aria-hidden="true"
                  viewBox="0 0 16 16"
                  className="h-3.5 w-3.5 translate-y-px"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M5.5 3.25h5" />
                  <path d="M3.75 4.75h8.5" />
                  <path d="M5 4.75v6a1 1 0 0 0 1 1h4a1 1 0 0 0 1-1v-6" />
                  <path d="M7 6.5v3.25" />
                  <path d="M9 6.5v3.25" />
                </svg>
              </button>
            </div>
            <h2 className="text-xl font-bold">{ticket.title}</h2>
            <div className="mt-1">
              <MarkdownContent content={ticket.description} />
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-zinc-500">
              <span>Selected run: {run?.id ?? ticket.activeRunId ?? 'none'}</span>
              <span>Attempts: {run?.attemptCount ?? 0}</span>
              <span>
                Current phase: {currentPhaseLabel}
                {currentPhaseAgent ? ` · ${currentPhaseAgent.displayName}` : ''}
              </span>
              {run?.worktree && (
                <span>
                  Worktree branch: <span className="text-zinc-300">{run.worktree.branchName}</span>
                </span>
              )}
              {ticket.runSummaries.length > 1 && (
                <label className="ml-auto flex items-center gap-2">
                  <span>Run</span>
                  <select
                    value={selectedRunId ?? ''}
                    onChange={(event) => {
                      if (ticket && event.target.value) {
                        void selectRun(ticket.id, event.target.value)
                      }
                    }}
                    className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-200 focus:outline-none focus:border-zinc-500"
                  >
                    {ticket.runSummaries
                      .slice()
                      .reverse()
                      .map((runSummary) => (
                        <option key={runSummary.id} value={runSummary.id}>
                          {runSummary.id} · {statusLabel(runSummary.status)}
                        </option>
                      ))}
                  </select>
                </label>
              )}
            </div>
          </div>
        </div>

        {ticket.repairLoop && (
          <div className="mb-6 rounded-lg border border-sky-900/60 bg-sky-950/20 px-4 py-4">
            <div className="mb-2 flex items-center gap-2 flex-wrap">
              <p className="text-sm font-medium text-sky-100">
                {repairLoopGateLabel(ticket.repairLoop.gate)}를 같은 run에서 계속 진행 중입니다.
              </p>
              <span className="rounded-full bg-sky-900/40 px-2 py-1 text-[11px] text-sky-200">
                {ticket.repairLoop.cycle}회차
              </span>
              <span className="rounded-full bg-sky-900/20 px-2 py-1 text-[11px] text-sky-100/90">
                {repairLoopStatusLabel(ticket.repairLoop.status)}
              </span>
            </div>
            <p className="text-xs text-sky-100/80">{compactText(ticket.repairLoop.failureSummary, 240)}</p>
            <p className="mt-3 text-xs text-sky-100/70">자동 수선은 계속 진행됩니다. 강제로 멈추려면 상단의 `중단`을 사용하세요.</p>
          </div>
        )}

        {(ticket.status === 'needs_decision' || ticket.status === 'needs_request_clarification') && planningBlockMessage && (
          <div className="mb-6 rounded-lg border border-amber-900/60 bg-amber-950/20 px-4 py-4">
            <p className="text-sm text-amber-100 mb-2">{planningBlockMessage.title}</p>
            <p className="text-xs text-amber-100/80 mb-3">{ticket.planningBlock?.summary}</p>
            {ticket.planningBlock?.findings?.length ? (
              <div className="mb-3 space-y-1 text-xs text-amber-50/90">
                {ticket.planningBlock.findings.map((finding) => (
                  <p key={finding}>- {finding}</p>
                ))}
              </div>
            ) : null}
            {needsClarification ? (
              <div className="mb-3 space-y-2">
                <p className="text-xs text-amber-100/80">
                  여기에 적은 보완 답변은 ticket 설명에 추가된 뒤 새 run으로 이어집니다.
                </p>
                <textarea
                  value={clarificationInput}
                  onChange={(event) => setClarificationInput(event.target.value)}
                  placeholder="추가 요구사항, 원하는 API 형태, 예외 정책 등을 적어 주세요..."
                  rows={5}
                  className="w-full resize-none rounded-lg border border-amber-900/70 bg-zinc-950/70 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-amber-700 focus:outline-none"
                />
              </div>
            ) : null}
            <div className="flex flex-wrap gap-2">
              {(ticket.planningBlock?.options?.length ? ticket.planningBlock.options : [{ id: 'default', label: planningBlockMessage.action }]).map((option) => (
                <button
                  key={option.id}
                  onClick={() =>
                    void handleRetry({
                      optionId: option.id === 'default' ? undefined : option.id,
                      clarification: needsClarification ? clarificationInput : undefined,
                    })
                  }
                  disabled={isStreaming || (needsClarification && !clarificationInput.trim())}
                  className="px-4 py-2 bg-amber-700 hover:bg-amber-600 disabled:bg-zinc-700 rounded text-sm font-medium transition-colors"
                >
                  {needsClarification ? `${option.label} + 보완 답변 전송` : option.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {(ticket.status === 'stopped' || ticket.status === 'failed' || ticket.recoveryRequired) && (
          <div
            className={`mb-6 rounded-lg px-4 py-4 ${
              ticket.status === 'stopped'
                ? 'border border-amber-900/60 bg-amber-950/20'
                : 'border border-red-900/60 bg-red-950/20'
            }`}
          >
            <p className={`text-sm mb-3 ${ticket.status === 'stopped' ? 'text-amber-100' : 'text-red-200'}`}>
              {ticket.status === 'stopped'
                ? '사용자 요청으로 자동 실행을 중단했습니다. 마지막 안전 지점부터 다시 시작할 수 있습니다.'
                : ticket.recoveryRequired
                  ? '서버 재시작 등으로 자동 실행이 중단되었습니다. 마지막 안전 지점부터 다시 시작할 수 있습니다.'
                  : '자동 복구가 최종 결과에 도달하지 못했습니다. incident에 마지막 실패 증거와 분석 결과가 기록됩니다.'}
            </p>
            <div className="flex gap-2">
              {ticket.status === 'failed' && !ticket.recoveryRequired && (
                <button
                  onClick={() => void onOpenIncident(ticket.id)}
                  className="px-4 py-2 rounded text-sm font-medium bg-red-700 text-red-50 hover:bg-red-600 transition-colors"
                >
                  Incident 보기
                </button>
              )}
              <button
                onClick={() => void handleRetry()}
                disabled={isStreaming}
                className={`px-4 py-2 disabled:bg-zinc-700 rounded text-sm font-medium transition-colors ${
                  ticket.status === 'stopped' || ticket.recoveryRequired
                    ? 'bg-amber-700 hover:bg-amber-600'
                    : 'bg-zinc-800 hover:bg-zinc-700'
                }`}
              >
                {ticket.status === 'stopped' || ticket.recoveryRequired ? '다시 시도' : '수동 재시도'}
              </button>
            </div>
          </div>
        )}

        {mergeFeedback && (
          <div className={`mb-6 rounded-lg px-4 py-4 ${mergeFeedbackToneClasses(mergeFeedback.tone)}`}>
            <p className="text-sm">{mergeFeedback.message}</p>
          </div>
        )}

        {ticket.status === 'awaiting_merge' && !ticket.mergeBlock && (
          <div className="mb-6 rounded-lg border border-emerald-900/60 bg-emerald-950/20 px-4 py-4">
            <p className="text-sm text-emerald-200 mb-3">
              자동 실행과 최종 보고가 끝났습니다. reviewed worktree를 메인 브랜치에 반영할지 결정하세요.
            </p>
            <div className="flex gap-2">
              <button
                onClick={handleDiscard}
                className="px-4 py-2 bg-zinc-700 hover:bg-zinc-600 rounded text-sm font-medium transition-colors"
              >
                Discard
              </button>
              <button
                onClick={handleMerge}
                className="px-4 py-2 bg-green-600 hover:bg-green-700 rounded text-sm font-medium transition-colors"
              >
                Merge
              </button>
            </div>
          </div>
        )}

        {ticket.status === 'awaiting_merge' && ticket.mergeBlock && (
          <div className="mb-6 rounded-lg border border-amber-900/60 bg-amber-950/20 px-4 py-4">
            <div className="mb-3 flex items-center gap-2 flex-wrap">
              <p className="text-sm font-medium text-amber-100">자동 merge가 현재 상태에서는 안전하지 않습니다.</p>
              <span className="rounded-full bg-amber-900/40 px-2 py-1 text-[11px] text-amber-200">
                {mergeIssueLabel(ticket.mergeBlock.issue)}
              </span>
            </div>
            <p className="text-sm text-amber-100/90">{ticket.mergeBlock.summary}</p>
            {ticket.mergeBlock.conflictFiles.length > 0 && (
              <div className="mt-3">
                <p className="text-xs font-medium uppercase tracking-[0.18em] text-amber-200/80">Conflict Files</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {ticket.mergeBlock.conflictFiles.map((file) => (
                    <span
                      key={file}
                      className="rounded-full border border-amber-900/60 bg-amber-950/40 px-2 py-1 text-xs text-amber-100"
                    >
                      {file}
                    </span>
                  ))}
                </div>
              </div>
            )}
            {ticket.mergeBlock.findings.length > 0 && (
              <div className="mt-3 space-y-1 text-xs text-amber-50/90">
                {ticket.mergeBlock.findings.map((finding) => (
                  <p key={finding}>- {finding}</p>
                ))}
              </div>
            )}
            <div className="mt-4 flex flex-wrap gap-2">
              {ticket.mergeBlock.options.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => void handleResolveMerge(option.id)}
                  disabled={isStreaming}
                  className={`rounded px-4 py-2 text-sm font-medium transition-colors ${
                    option.recommended
                      ? 'bg-amber-600 text-amber-50 hover:bg-amber-500 disabled:bg-zinc-700'
                      : 'bg-zinc-800 text-zinc-100 hover:bg-zinc-700 disabled:bg-zinc-800'
                  }`}
                >
                  {option.label}
                  {option.recommended ? ' (권장)' : ''}
                </button>
              ))}
            </div>
            <div className="mt-4 space-y-2 text-xs text-amber-100/80">
              {ticket.mergeBlock.options.map((option) => (
                <p key={`${option.id}-description`}>
                  <span className="font-medium text-amber-100">{option.label}:</span> {mergeResolutionDescription(option.action)}
                </p>
              ))}
            </div>
          </div>
        )}

        {run?.worktree && (
          <div className="mb-6 rounded-lg border border-zinc-800 bg-zinc-900/50 px-4 py-3 text-sm">
            <p className="font-medium text-zinc-100 mb-2">Execution Environment</p>
            <div className="grid gap-2 text-zinc-400">
              <div>Base branch: {run.worktree.baseBranch}</div>
              <div>Base commit: {run.worktree.baseCommit}</div>
              {run.worktree.headCommit && <div>Review commit: {run.worktree.headCommit}</div>}
              <div>Worktree status: {run.worktree.status}</div>
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)] gap-6">
          <div>
            <div className="mb-6">
              <div className="mb-3 flex items-center justify-between gap-3">
                <h3 className="text-sm font-semibold text-zinc-200">Flow Steps</h3>
                <button
                  type="button"
                  onClick={handleToggleAllFlowSteps}
                  disabled={flowStepExpandableIds.length === 0}
                  className="rounded border border-zinc-700 px-3 py-1 text-xs font-medium text-zinc-300 transition-colors hover:border-zinc-500 hover:text-zinc-100 disabled:cursor-not-allowed disabled:border-zinc-800 disabled:text-zinc-600"
                >
                  {hasOpenFlowStep ? 'Collapse all' : 'Expand all'}
                </button>
              </div>
              {phasePanels.map((phase) => {
                return (
                  <div key={phase.id} className="mb-4">
                    <TicketStepPanel
                      stepId={phase.id}
                      stepName={phase.name}
                      agentDisplayName={phase.agent?.displayName}
                      agentRole={formatAgentRole(phase.agent?.role)}
                      status={phase.status}
                      output={phase.output}
                      runId={run?.id}
                      attemptOptions={
                        phase.id === 'implement'
                          ? implementAttempts
                          : phase.id === 'verify'
                            ? implementAttempts
                            : phase.id === 'review'
                              ? implementAttempts
                              : undefined
                      }
                      selectedAttempt={selectedAttempt}
                      onSelectAttempt={setSelectedAttempt}
                      verificationRuns={phase.id === 'verify' ? run?.verificationRuns : undefined}
                      reviewRuns={phase.id === 'review' ? run?.reviewRuns : undefined}
                      isOpen={panelOpenState[phase.id] ?? false}
                      onToggle={() => handleTogglePanel(phase.id)}
                      canRun={false}
                      onRun={() => undefined}
                    />
                  </div>
                )
              })}
            </div>

            {run?.finalReport && (
              <div className="mb-6 rounded-lg border border-emerald-900/50 bg-emerald-950/10 p-4">
                <h3 className="text-sm font-semibold text-emerald-200 mb-3">Final Report</h3>
                <TicketStepPanel
                  stepId="final-report"
                  stepName="Final Report"
                  agentDisplayName={config.flows.ticket.coordinator?.agent?.displayName}
                  agentRole={formatAgentRole(config.flows.ticket.coordinator?.agent?.role)}
                  status={ticket.status === 'awaiting_merge' || ticket.status === 'completed' ? 'done' : 'pending'}
                  output={finalReportOutput}
                  isOpen={panelOpenState['final-report'] ?? false}
                  onToggle={() => handleTogglePanel('final-report')}
                  canRun={false}
                  onRun={() => undefined}
                />
              </div>
            )}
          </div>

          <div className="space-y-6">
            <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
              <div className="mb-3 flex items-start justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold text-zinc-200">Attempt History</h3>
                  <p className="mt-1 text-xs text-zinc-500">
                    선택한 run의 Implement / Verify / Review 재시도를 묶어서 보여줍니다. 세부 출력은 항목을 클릭해 확인하세요.
                  </p>
                </div>
                <span className="rounded-full border border-zinc-800 bg-zinc-900 px-2 py-1 text-[11px] text-zinc-400">
                  {attemptHistory.length} attempts
                </span>
              </div>

              {attemptHistory.length === 0 ? (
                <p className="text-sm text-zinc-500">이 run에는 아직 구현 시도 기록이 없습니다.</p>
              ) : (
                <div className="space-y-4">
                  {attemptHistory.map((attemptGroup) => (
                    <div key={attemptGroup.attempt} className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3">
                      <div className="mb-3 flex items-start justify-between gap-3">
                        <div>
                          <p className="text-sm font-medium text-zinc-100">Attempt {attemptGroup.attempt}</p>
                          <p className="mt-1 text-sm text-zinc-300">{attemptGroup.outcome}</p>
                        </div>
                        <span
                          className={`rounded-full border px-2 py-1 text-[11px] ${attemptHistoryStatusBadge(attemptGroup.status)}`}
                        >
                          {attemptHistoryStatusLabel(attemptGroup.status)}
                        </span>
                      </div>

                      <div className="space-y-2">
                        {attemptGroup.steps.map((step) => {
                          const isLiveEntry = step.entry
                            ? isLiveTimelineEntry(run, step.entry, currentStep, isStreaming)
                            : false

                          const content = (
                            <>
                              <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0 flex-1">
                                  <div className="flex flex-wrap items-center gap-2">
                                    <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-zinc-500">
                                      {step.label}
                                    </p>
                                    {isLiveEntry ? (
                                      <span className="rounded-full border border-blue-500/40 bg-blue-950/50 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.18em] text-blue-200">
                                        live
                                      </span>
                                    ) : null}
                                  </div>
                                  <p className="mt-1 text-sm text-zinc-200">{step.summary}</p>
                                </div>
                                <span
                                  className={`rounded-full border px-2 py-1 text-[11px] ${attemptStepStatusBadge(step.status)}`}
                                >
                                  {attemptStepStatusLabel(step.status)}
                                </span>
                              </div>
                              {step.entry ? <p className="mt-2 text-xs text-zinc-500">클릭해서 상세 보기</p> : null}
                            </>
                          )

                          if (!step.entry) {
                            return (
                              <div key={step.id} className="rounded-lg border border-zinc-800 bg-zinc-900/50 px-3 py-3">
                                {content}
                              </div>
                            )
                          }

                          return (
                            <button
                              key={step.id}
                              type="button"
                              onClick={() => setSelectedTimelineEventId(step.entry?.id ?? null)}
                              className={`w-full rounded-lg border border-zinc-800 bg-zinc-900/50 px-3 py-3 text-left transition hover:border-zinc-600 hover:bg-zinc-900 ${
                                isLiveEntry ? 'ring-1 ring-blue-500/50' : ''
                              }`}
                            >
                              {content}
                            </button>
                          )
                        })}
                      </div>

                      {attemptGroup.contextEntries.length > 0 ? (
                        <div className="mt-3 border-t border-zinc-800 pt-3">
                          <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-zinc-500">Context</p>
                          <div className="mt-2 space-y-2">
                            {attemptGroup.contextEntries.map((entry) => (
                              <button
                                key={entry.id}
                                type="button"
                                onClick={() => setSelectedTimelineEventId(entry.id)}
                                className="w-full rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-3 text-left transition hover:border-zinc-600 hover:bg-zinc-900"
                              >
                                <p className="text-sm text-zinc-200">{entry.title}</p>
                                {entry.body ? (
                                  <p className="mt-1 text-xs text-zinc-500">{compactText(entry.body, 160)}</p>
                                ) : null}
                              </button>
                            ))}
                          </div>
                        </div>
                      ) : null}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
        </div>
      </div>

      <TicketTimelineModal
        ticket={ticket}
        run={run}
        entry={selectedTimelineEvent}
        currentStep={currentStep}
        streamingOutputs={streamingOutputs}
        isStreaming={isStreaming}
        onClose={() => setSelectedTimelineEventId(null)}
      />
    </>
  )
}
