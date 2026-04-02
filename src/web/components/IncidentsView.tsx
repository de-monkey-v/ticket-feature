import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { AppConfig, IncidentDetail, IncidentSummary } from '../lib/api'
import { analyzeIncident, deleteIncident, fetchIncident } from '../lib/api'
import { MarkdownContent } from './MarkdownContent'
import { WorkspaceHeader } from './WorkspaceHeader'

interface IncidentsViewProps {
  projectId: string
  config: AppConfig
  incidents: IncidentSummary[]
  selectedIncidentId: string | null
  onSelectIncident: (incidentId: string | null) => void
  onProjectChange: (projectId: string) => void
  onRefresh: () => Promise<void> | void
  onConfigUpdated: () => Promise<void> | void
  onIncidentDeleted: (incidentId: string) => void
}

type IncidentSectionKey = 'steps' | 'verification' | 'latestReview' | 'stageReviews' | 'timeline' | 'worktree'

const defaultSectionState: Record<IncidentSectionKey, boolean> = {
  steps: false,
  verification: false,
  latestReview: false,
  stageReviews: false,
  timeline: false,
  worktree: false,
}

function incidentStatusBadge(status: IncidentSummary['status']) {
  if (status === 'analyzed') return 'bg-emerald-900 text-emerald-300'
  if (status === 'analyzing') return 'bg-blue-900 text-blue-300'
  if (status === 'analysis_failed') return 'bg-red-900 text-red-300'
  return 'bg-amber-900 text-amber-300'
}

function incidentStatusLabel(status: IncidentSummary['status']) {
  if (status === 'captured') return '분석 대기'
  if (status === 'analyzing') return '분석 중'
  if (status === 'analyzed') return '분석 완료'
  if (status === 'analysis_failed') return '분석 실패'
  return status
}

function triggerLabel(kind: IncidentSummary['trigger']['kind']) {
  if (kind === 'analyze_failed') return '분석 실패'
  if (kind === 'verify_failed') return '검증 실패'
  if (kind === 'review_failed') return '리뷰 실패'
  if (kind === 'runner_exception') return '실행 예외'
  if (kind === 'retry_failed') return '재시도 실패'
  if (kind === 'merge_failed') return '머지 실패'
  if (kind === 'discard_failed') return '폐기 실패'
  return kind
}

function ticketRunStateLabel(runState: IncidentDetail['bundle']['ticket']['runState']) {
  if (runState === 'created') return '준비됨'
  if (runState === 'queued') return '대기 중'
  if (runState === 'running') return '실행 중'
  if (runState === 'stopped') return '중단됨'
  if (runState === 'blocked') return '일시 중단'
  if (runState === 'needs_decision') return '결정 필요'
  if (runState === 'needs_request_clarification') return '요구사항 보완 필요'
  if (runState === 'awaiting_merge') return '머지 대기'
  if (runState === 'completed') return '완료'
  if (runState === 'discarded') return '폐기됨'
  if (runState === 'failed') return '실패'
  return runState
}

function stepStatusLabel(status: string) {
  if (status === 'pending') return '대기'
  if (status === 'running') return '실행 중'
  if (status === 'done') return '완료'
  if (status === 'awaiting_approval') return '승인 대기'
  if (status === 'approved') return '승인됨'
  if (status === 'rejected') return '거절됨'
  if (status === 'failed') return '실패'
  return status
}

function verificationStatusLabel(status: string) {
  if (status === 'passed' || status === 'pass') return '통과'
  if (status === 'failed' || status === 'fail') return '실패'
  if (status === 'skipped') return '건너뜀'
  return status
}

function reviewVerdictLabel(verdict: 'pass' | 'fail') {
  return verdict === 'pass' ? '통과' : '실패'
}

function confidenceLabel(confidence: 'low' | 'medium' | 'high') {
  if (confidence === 'high') return '높음'
  if (confidence === 'medium') return '보통'
  return '낮음'
}

function compactText(text?: string, maxLength = 180) {
  const normalized = (text ?? '').replace(/\s+/g, ' ').trim()
  if (!normalized) {
    return ''
  }

  if (normalized.length <= maxLength) {
    return normalized
  }

  return `${normalized.slice(0, maxLength - 1)}…`
}

function formatTimestamp(value: string) {
  return new Date(value).toLocaleString()
}

function formatDuration(durationMs?: number) {
  if (durationMs == null) {
    return null
  }

  if (durationMs < 1_000) {
    return `${durationMs}ms`
  }

  return `${(durationMs / 1_000).toFixed(durationMs >= 10_000 ? 0 : 1)}s`
}

function IncidentSection({
  title,
  summary,
  isOpen,
  onToggle,
  children,
}: {
  title: string
  summary?: string
  isOpen: boolean
  onToggle: () => void
  children: ReactNode
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950/50">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-zinc-900/70"
        aria-expanded={isOpen}
      >
        <div className="min-w-0">
          <p className="text-sm font-medium text-zinc-100">{title}</p>
          {summary ? <p className="mt-1 text-xs text-zinc-500">{summary}</p> : null}
        </div>
        <span className={`shrink-0 text-zinc-500 transition-transform ${isOpen ? 'rotate-90' : ''}`} aria-hidden="true">
          <svg viewBox="0 0 20 20" className="h-4 w-4 fill-current">
            <path d="M7.1 4.8a1 1 0 0 1 1.4 0l4.5 4.5a1 1 0 0 1 0 1.4l-4.5 4.5a1 1 0 1 1-1.4-1.4L10.9 10 7.1 6.2a1 1 0 0 1 0-1.4Z" />
          </svg>
        </span>
      </button>
      {isOpen ? <div className="border-t border-zinc-800 px-4 py-4">{children}</div> : null}
    </div>
  )
}

function ExcerptBlock({
  content,
  truncated = false,
  emptyLabel = '표시할 기록이 없습니다.',
}: {
  content?: string
  truncated?: boolean
  emptyLabel?: string
}) {
  if (!content?.trim()) {
    return <p className="text-sm text-zinc-500">{emptyLabel}</p>
  }

  return (
    <div className="space-y-2">
      {truncated ? <p className="text-[11px] text-amber-300">일부만 표시 중입니다.</p> : null}
      <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-3 text-xs text-zinc-300">
        {content}
      </pre>
    </div>
  )
}

export function IncidentsView({
  projectId,
  config,
  incidents,
  selectedIncidentId,
  onSelectIncident,
  onProjectChange,
  onRefresh,
  onConfigUpdated,
  onIncidentDeleted,
}: IncidentsViewProps) {
  const [incident, setIncident] = useState<IncidentDetail | null>(null)
  const [isLoadingIncident, setIsLoadingIncident] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [isAnalyzing, setIsAnalyzing] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)
  const [openSections, setOpenSections] = useState(defaultSectionState)

  useEffect(() => {
    if (!selectedIncidentId) {
      setIncident(null)
      setLoadError(null)
      return
    }

    let disposed = false
    setIsLoadingIncident(true)
    setLoadError(null)

    void fetchIncident(selectedIncidentId)
      .then((detail) => {
        if (!disposed) {
          setIncident(detail)
        }
      })
      .catch((error) => {
        if (!disposed) {
          setIncident(null)
          setLoadError(error instanceof Error ? error.message : 'incident를 불러오지 못했습니다.')
        }
      })
      .finally(() => {
        if (!disposed) {
          setIsLoadingIncident(false)
        }
      })

    return () => {
      disposed = true
    }
  }, [selectedIncidentId])

  useEffect(() => {
    setOpenSections(defaultSectionState)
  }, [selectedIncidentId])

  const selectedSummary = useMemo(
    () => incidents.find((entry) => entry.id === selectedIncidentId) ?? null,
    [incidents, selectedIncidentId]
  )

  const latestFailedStep = useMemo(() => {
    if (!incident) {
      return null
    }

    const steps = [...incident.bundle.steps].reverse()
    return steps.find((step) => step.status === 'failed' || step.status === 'rejected') ?? steps.find((step) => step.outputExcerpt.trim()) ?? null
  }, [incident])

  const latestFailedCommand = useMemo(() => {
    if (!incident) {
      return null
    }

    const runs = [...incident.bundle.verificationRuns].reverse()
    for (const run of runs) {
      const commands = [...run.commands].reverse()
      const command = commands.find((entry) => entry.status === 'failed') ?? commands.find((entry) => entry.outputExcerpt.trim())
      if (command) {
        return { run, command }
      }
    }

    return null
  }, [incident])

  const latestReviewSummary = useMemo(() => {
    if (!incident) {
      return null
    }

    if (incident.bundle.latestReview) {
      return {
        label: '최신 리뷰',
        attempt: incident.bundle.latestReview.attempt,
        verdict: incident.bundle.latestReview.verdict,
        summary: incident.bundle.latestReview.summary,
      }
    }

    const review = [...incident.bundle.stageReviews].reverse()[0]
    if (!review) {
      return null
    }

    return {
      label: review.label,
      attempt: review.attempt,
      verdict: review.verdict,
      summary: review.summary,
    }
  }, [incident])

  const toggleSection = (key: IncidentSectionKey) => {
    setOpenSections((current) => ({
      ...current,
      [key]: !current[key],
    }))
  }

  const handleAnalyze = async () => {
    if (!selectedIncidentId || isAnalyzing) {
      return
    }

    setIsAnalyzing(true)
    setLoadError(null)

    try {
      const detail = await analyzeIncident(selectedIncidentId)
      setIncident(detail)
      await onRefresh()
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'incident 분석에 실패했습니다.')
    } finally {
      setIsAnalyzing(false)
    }
  }

  const handleDelete = async () => {
    if (!selectedIncidentId || isDeleting) {
      return
    }

    setIsDeleting(true)
    setLoadError(null)

    try {
      await deleteIncident(selectedIncidentId)
      onSelectIncident(null)
      onIncidentDeleted(selectedIncidentId)
      await onRefresh()
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'incident를 삭제하지 못했습니다.')
    } finally {
      setIsDeleting(false)
    }
  }

  const incidentsSubtitle = !projectId
    ? '프로젝트를 선택하면 incident를 확인할 수 있습니다'
    : incidents.length === 0
      ? '이 프로젝트에는 아직 incident가 없습니다'
      : selectedIncidentId && selectedSummary
        ? '선택한 incident를 분석하고 추적합니다'
        : '사이드바에서 확인할 incident를 선택하세요'
  const incidentsHeader = (
    <WorkspaceHeader
      authSession={config.auth.session}
      projects={config.allowedProjects}
      projectId={projectId}
      onProjectChange={onProjectChange}
      onConfigUpdated={onConfigUpdated}
      title="Incidents"
      subtitle={incidentsSubtitle}
    />
  )

  if (!projectId) {
    return (
      <div className="flex h-full flex-col">
        {incidentsHeader}
        <div className="flex flex-1 items-center justify-center p-6">
          <p className="text-sm text-zinc-500">incident를 보려면 프로젝트를 선택하세요.</p>
        </div>
      </div>
    )
  }

  if (incidents.length === 0) {
    return (
      <div className="flex h-full flex-col">
        {incidentsHeader}
        <div className="flex flex-1 items-center justify-center p-6">
          <div className="text-center">
            <p className="text-sm text-zinc-400">이 프로젝트에는 아직 incident가 없습니다.</p>
            <p className="mt-2 text-xs text-zinc-500">자동 복구가 끝까지 해결하지 못한 실패와 실행 예외만 여기에 남습니다.</p>
          </div>
        </div>
      </div>
    )
  }

  if (!selectedIncidentId || !selectedSummary) {
    return (
      <div className="flex h-full flex-col">
        {incidentsHeader}
        <div className="flex flex-1 items-center justify-center p-6">
          <p className="text-sm text-zinc-500">사이드바에서 확인할 incident를 선택하세요.</p>
        </div>
      </div>
    )
  }

  const displayStatus = incident?.status ?? selectedSummary.status

  return (
    <div className="flex h-full flex-col">
      {incidentsHeader}
      <div className="flex-1 overflow-y-auto p-6">
        <div className="mx-auto max-w-6xl space-y-6">
        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5">
          <div className="flex flex-wrap items-start gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-zinc-500">Incident Overview</p>
              <h2 className="mt-2 text-2xl font-bold text-zinc-100">{selectedSummary.title}</h2>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={handleAnalyze}
                disabled={isAnalyzing || displayStatus === 'analyzing'}
                className="rounded-lg bg-blue-700 px-3 py-2 text-xs font-medium text-blue-50 transition-colors hover:bg-blue-600 disabled:bg-zinc-800 disabled:text-zinc-500"
              >
                {isAnalyzing || displayStatus === 'analyzing'
                  ? '분석 중…'
                  : displayStatus === 'analyzed'
                    ? '원인 분석 다시 실행'
                    : '원인 분석 실행'}
              </button>
              <button
                type="button"
                onClick={handleDelete}
                disabled={isDeleting || displayStatus === 'analyzing'}
                className="rounded-lg bg-zinc-800 px-3 py-2 text-xs font-medium text-zinc-200 transition-colors hover:bg-zinc-700 disabled:bg-zinc-800 disabled:text-zinc-500"
              >
                {isDeleting ? '삭제 중…' : 'Incident 삭제'}
              </button>
            </div>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <span className="rounded-full bg-zinc-800 px-2 py-1 text-xs text-zinc-200">{triggerLabel(selectedSummary.trigger.kind)}</span>
            <span className={`rounded-full px-2 py-1 text-xs ${incidentStatusBadge(displayStatus)}`}>
              {incidentStatusLabel(displayStatus)}
            </span>
            <span className="text-xs font-mono text-zinc-500">{selectedSummary.id}</span>
          </div>

          <p className="mt-4 whitespace-pre-wrap text-sm text-zinc-300">{selectedSummary.trigger.message}</p>

          <div className="mt-4 grid gap-3 text-xs text-zinc-400 sm:grid-cols-2 xl:grid-cols-4">
            <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 px-3 py-3">
              <p className="text-zinc-500">연결된 티켓</p>
              <p className="mt-1 text-sm text-zinc-100">{selectedSummary.sourceId}</p>
            </div>
            <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 px-3 py-3">
              <p className="text-zinc-500">실패 단계</p>
              <p className="mt-1 text-sm text-zinc-100">{selectedSummary.trigger.phase ?? '기록 없음'}</p>
            </div>
            <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 px-3 py-3">
              <p className="text-zinc-500">기록 시각</p>
              <p className="mt-1 text-sm text-zinc-100">{formatTimestamp(selectedSummary.createdAt)}</p>
            </div>
            <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 px-3 py-3">
              <p className="text-zinc-500">최근 갱신</p>
              <p className="mt-1 text-sm text-zinc-100">{formatTimestamp(selectedSummary.updatedAt)}</p>
            </div>
          </div>

          <p className="mt-4 text-xs text-zinc-500">원인 분석을 먼저 읽고, 근거가 더 필요할 때만 아래 원문 증거를 펼쳐 보세요.</p>
        </div>

        {loadError ? (
          <div className="rounded-lg border border-red-900/60 bg-red-950/20 px-4 py-3 text-sm text-red-200">{loadError}</div>
        ) : null}

        {isLoadingIncident || !incident ? (
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 px-4 py-6 text-sm text-zinc-500">incident 세부 정보를 불러오는 중입니다…</div>
        ) : (
          <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1.7fr)_minmax(300px,0.95fr)]">
            <div className="space-y-6">
              <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5">
                <div className="mb-4 flex items-start justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-semibold text-zinc-100">원인 분석</h3>
                    <p className="mt-1 text-xs text-zinc-500">가장 먼저 읽어야 하는 요약입니다.</p>
                  </div>
                  {incident.analysis ? (
                    <span className="rounded-full bg-zinc-800 px-2 py-1 text-[11px] text-zinc-300">
                      신뢰도 {confidenceLabel(incident.analysis.confidence)}
                    </span>
                  ) : null}
                </div>

                {incident.analysis ? (
                  <div className="space-y-5">
                    <div>
                      <p className="text-xs uppercase tracking-[0.18em] text-zinc-500">요약</p>
                      <p className="mt-2 whitespace-pre-wrap text-sm text-zinc-300">{incident.analysis.summary}</p>
                    </div>
                    <div>
                      <p className="text-xs uppercase tracking-[0.18em] text-zinc-500">가능성 높은 원인</p>
                      <p className="mt-2 whitespace-pre-wrap text-sm text-zinc-300">{incident.analysis.likelyRootCause}</p>
                    </div>
                    {incident.analysis.impactedAreas.length > 0 ? (
                      <div>
                        <p className="text-xs uppercase tracking-[0.18em] text-zinc-500">영향 범위</p>
                        <div className="mt-2 flex flex-wrap gap-2">
                          {incident.analysis.impactedAreas.map((entry) => (
                            <span key={entry} className="rounded-full bg-zinc-800 px-2 py-1 text-xs text-zinc-300">
                              {entry}
                            </span>
                          ))}
                        </div>
                      </div>
                    ) : null}
                    <div>
                      <p className="text-xs uppercase tracking-[0.18em] text-zinc-500">근거</p>
                      <div className="mt-2 space-y-2 text-sm text-zinc-300">
                        {incident.analysis.evidence.map((entry) => (
                          <p key={entry}>- {entry}</p>
                        ))}
                      </div>
                    </div>
                    <div>
                      <p className="text-xs uppercase tracking-[0.18em] text-zinc-500">다음 액션</p>
                      <div className="mt-2 space-y-2 text-sm text-zinc-300">
                        {incident.analysis.nextActions.map((entry) => (
                          <p key={entry}>- {entry}</p>
                        ))}
                      </div>
                    </div>
                    <div>
                      <p className="text-xs uppercase tracking-[0.18em] text-zinc-500">권장 복구</p>
                      <div className="mt-2 space-y-2 text-sm text-zinc-300">
                        <p>
                          {incident.analysis.recommendedAction.type === 'rerun_from_step'
                            ? `${incident.analysis.recommendedAction.startStepId ?? 'manual'} 단계부터 다시 시작`
                            : '수동 개입 필요'}
                        </p>
                        <p>{incident.analysis.recommendedAction.rationale}</p>
                        <p className="text-xs text-zinc-500">incident 분석은 권장 경로만 제안하며 ticket 상태를 자동으로 바꾸지 않습니다.</p>
                      </div>
                    </div>
                    <div>
                      <p className="text-xs uppercase tracking-[0.18em] text-zinc-500">부족한 신호</p>
                      <div className="mt-2 space-y-2 text-sm text-zinc-300">
                        {incident.analysis.missingSignals.length > 0 ? (
                          incident.analysis.missingSignals.map((entry) => <p key={entry}>- {entry}</p>)
                        ) : (
                          <p>- 추가로 필요한 신호는 없습니다.</p>
                        )}
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="rounded-xl border border-dashed border-zinc-700 bg-zinc-950/50 px-4 py-4">
                    <p className="text-sm text-zinc-300">
                      아직 원인 분석이 없습니다. 이 화면은 분석 결과를 먼저 보고, 필요할 때만 원문 증거를 펼쳐 읽는 흐름으로 사용하세요.
                    </p>
                    <button
                      type="button"
                      onClick={handleAnalyze}
                      disabled={isAnalyzing || displayStatus === 'analyzing'}
                      className="mt-4 rounded-lg bg-blue-700 px-3 py-2 text-xs font-medium text-blue-50 transition-colors hover:bg-blue-600 disabled:bg-zinc-800 disabled:text-zinc-500"
                    >
                      {isAnalyzing || displayStatus === 'analyzing' ? '분석 중…' : '원인 분석 실행'}
                    </button>
                  </div>
                )}
              </div>

              <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5">
                <div className="mb-4">
                  <h3 className="text-sm font-semibold text-zinc-100">핵심 증거</h3>
                  <p className="mt-1 text-xs text-zinc-500">원문 로그를 열기 전에 확인할 짧은 단서들입니다.</p>
                </div>

                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                  <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-4">
                    <p className="text-xs uppercase tracking-[0.18em] text-zinc-500">마지막 실패 단계</p>
                    {latestFailedStep ? (
                      <>
                        <p className="mt-2 text-sm font-medium text-zinc-100">
                          {latestFailedStep.stepId} · {stepStatusLabel(latestFailedStep.status)}
                        </p>
                        <p className="mt-2 text-sm text-zinc-300">{compactText(latestFailedStep.outputExcerpt, 200) || '출력 없음'}</p>
                        {latestFailedStep.truncated ? <p className="mt-2 text-[11px] text-amber-300">원문은 아래 증거 섹션에 일부만 표시됩니다.</p> : null}
                      </>
                    ) : (
                      <p className="mt-2 text-sm text-zinc-500">기록된 단계 출력이 없습니다.</p>
                    )}
                  </div>

                  <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-4">
                    <p className="text-xs uppercase tracking-[0.18em] text-zinc-500">최근 검증 실패</p>
                    {latestFailedCommand ? (
                      <>
                        <p className="mt-2 text-sm font-medium text-zinc-100">
                          시도 {latestFailedCommand.run.attempt} · {latestFailedCommand.command.label}
                        </p>
                        <p className="mt-1 text-xs text-zinc-500">
                          {verificationStatusLabel(latestFailedCommand.command.status)}
                          {latestFailedCommand.command.exitCode != null ? ` · exit ${latestFailedCommand.command.exitCode}` : ''}
                          {formatDuration(latestFailedCommand.command.durationMs) ? ` · ${formatDuration(latestFailedCommand.command.durationMs)}` : ''}
                        </p>
                        <p className="mt-2 text-sm text-zinc-300">
                          {compactText(latestFailedCommand.command.outputExcerpt, 200) || '출력 없음'}
                        </p>
                        {latestFailedCommand.command.truncated ? (
                          <p className="mt-2 text-[11px] text-amber-300">원문은 아래 증거 섹션에 일부만 표시됩니다.</p>
                        ) : null}
                      </>
                    ) : (
                      <p className="mt-2 text-sm text-zinc-500">검증 기록이 없습니다.</p>
                    )}
                  </div>

                  <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-4">
                    <p className="text-xs uppercase tracking-[0.18em] text-zinc-500">최근 리뷰 판단</p>
                    {latestReviewSummary ? (
                      <>
                        <p className="mt-2 text-sm font-medium text-zinc-100">
                          {latestReviewSummary.label} · {reviewVerdictLabel(latestReviewSummary.verdict)}
                        </p>
                        <p className="mt-1 text-xs text-zinc-500">시도 {latestReviewSummary.attempt}</p>
                        <p className="mt-2 text-sm text-zinc-300">{compactText(latestReviewSummary.summary, 200)}</p>
                      </>
                    ) : (
                      <p className="mt-2 text-sm text-zinc-500">리뷰 기록이 없습니다.</p>
                    )}
                  </div>
                </div>
              </div>

              <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5">
                <div className="mb-4">
                  <h3 className="text-sm font-semibold text-zinc-100">원문 증거</h3>
                  <p className="mt-1 text-xs text-zinc-500">필요한 섹션만 펼쳐서 확인하세요.</p>
                </div>

                <div className="space-y-4">
                  <IncidentSection
                    title="단계 출력"
                    summary={`단계 ${incident.bundle.steps.length}개`}
                    isOpen={openSections.steps}
                    onToggle={() => toggleSection('steps')}
                  >
                    <div className="space-y-4">
                      {incident.bundle.steps.map((step) => (
                        <div key={step.stepId} className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-4">
                          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                            <p className="text-sm font-medium text-zinc-100">{step.stepId}</p>
                            <span className="text-xs text-zinc-500">{stepStatusLabel(step.status)}</span>
                          </div>
                          <ExcerptBlock content={step.outputExcerpt} truncated={step.truncated} emptyLabel="출력이 없습니다." />
                        </div>
                      ))}
                    </div>
                  </IncidentSection>

                  {incident.bundle.verificationRuns.length > 0 ? (
                    <IncidentSection
                      title="검증 기록"
                      summary={`시도 ${incident.bundle.verificationRuns.length}회`}
                      isOpen={openSections.verification}
                      onToggle={() => toggleSection('verification')}
                    >
                      <div className="space-y-4">
                        {incident.bundle.verificationRuns.map((run) => (
                          <div key={`${run.attempt}-${run.completedAt}`} className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-4">
                            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                              <p className="text-sm font-medium text-zinc-100">
                                시도 {run.attempt} · {verificationStatusLabel(run.status)}
                              </p>
                              <span className="text-xs text-zinc-500">{formatTimestamp(run.completedAt)}</span>
                            </div>
                            <div className="space-y-3">
                              {run.commands.map((command) => (
                                <div key={`${run.attempt}-${command.id}`} className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3">
                                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                                    <p className="text-sm text-zinc-200">{command.label}</p>
                                    <span className="text-xs text-zinc-500">
                                      {verificationStatusLabel(command.status)}
                                      {command.exitCode != null ? ` · exit ${command.exitCode}` : ''}
                                      {formatDuration(command.durationMs) ? ` · ${formatDuration(command.durationMs)}` : ''}
                                    </span>
                                  </div>
                                  <ExcerptBlock content={command.outputExcerpt} truncated={command.truncated} emptyLabel="출력이 없습니다." />
                                </div>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    </IncidentSection>
                  ) : null}

                  {incident.bundle.latestReview ? (
                    <IncidentSection
                      title="최신 리뷰"
                      summary={`${reviewVerdictLabel(incident.bundle.latestReview.verdict)} · 시도 ${incident.bundle.latestReview.attempt}`}
                      isOpen={openSections.latestReview}
                      onToggle={() => toggleSection('latestReview')}
                    >
                      <div className="space-y-4 rounded-xl border border-zinc-800 bg-zinc-950/60 p-4">
                        <div>
                          <p className="text-sm font-medium text-zinc-100">{incident.bundle.latestReview.summary}</p>
                          <p className="mt-1 text-xs text-zinc-500">{formatTimestamp(incident.bundle.latestReview.completedAt)}</p>
                        </div>
                        {incident.bundle.latestReview.blockingFindings.length > 0 ? (
                          <div>
                            <p className="text-xs uppercase tracking-[0.18em] text-zinc-500">차단 이슈</p>
                            <div className="mt-2 space-y-2 text-sm text-zinc-300">
                              {incident.bundle.latestReview.blockingFindings.map((entry) => (
                                <p key={entry}>- {entry}</p>
                              ))}
                            </div>
                          </div>
                        ) : null}
                        {incident.bundle.latestReview.residualRisks.length > 0 ? (
                          <div>
                            <p className="text-xs uppercase tracking-[0.18em] text-zinc-500">잔여 위험</p>
                            <div className="mt-2 space-y-2 text-sm text-zinc-300">
                              {incident.bundle.latestReview.residualRisks.map((entry) => (
                                <p key={entry}>- {entry}</p>
                              ))}
                            </div>
                          </div>
                        ) : null}
                        <ExcerptBlock
                          content={incident.bundle.latestReview.outputExcerpt}
                          truncated={incident.bundle.latestReview.truncated}
                          emptyLabel="리뷰 원문이 없습니다."
                        />
                      </div>
                    </IncidentSection>
                  ) : null}

                  <IncidentSection
                    title="단계 리뷰"
                    summary={
                      incident.bundle.stageReviews.length > 0
                        ? `스냅샷 ${incident.bundle.stageReviews.length}개`
                        : '기록된 단계 리뷰가 없습니다.'
                    }
                    isOpen={openSections.stageReviews}
                    onToggle={() => toggleSection('stageReviews')}
                  >
                    {incident.bundle.stageReviews.length === 0 ? (
                      <p className="text-sm text-zinc-500">단계 리뷰 스냅샷이 없습니다.</p>
                    ) : (
                      <div className="space-y-4">
                        {incident.bundle.stageReviews.map((review) => (
                          <div key={review.id} className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-4">
                            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                              <div>
                                <p className="text-sm font-medium text-zinc-100">{review.label}</p>
                                <p className="mt-1 text-xs text-zinc-500">
                                  {reviewVerdictLabel(review.verdict)} · 시도 {review.attempt} · {formatTimestamp(review.completedAt)}
                                </p>
                              </div>
                            </div>
                            <p className="mb-3 text-sm text-zinc-300">{review.summary}</p>
                            {review.blockingFindings.length > 0 ? (
                              <div className="mb-3 space-y-2 text-sm text-zinc-300">
                                {review.blockingFindings.map((entry) => (
                                  <p key={entry}>- {entry}</p>
                                ))}
                              </div>
                            ) : null}
                            <ExcerptBlock content={review.outputExcerpt} truncated={review.truncated} emptyLabel="리뷰 원문이 없습니다." />
                          </div>
                        ))}
                      </div>
                    )}
                  </IncidentSection>

                  <IncidentSection
                    title="타임라인"
                    summary={`이벤트 ${incident.bundle.timeline.length}개`}
                    isOpen={openSections.timeline}
                    onToggle={() => toggleSection('timeline')}
                  >
                    <div className="space-y-4">
                      {incident.bundle.timeline.map((entry) => (
                        <div key={entry.id} className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-4">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <p className="text-sm font-medium text-zinc-100">{entry.title}</p>
                            <span className="text-[11px] text-zinc-500">{formatTimestamp(entry.createdAt)}</span>
                          </div>
                          <p className="mt-1 text-[11px] text-zinc-500">
                            {entry.type}
                            {entry.stepId ? ` · ${entry.stepId}` : ''}
                            {entry.attempt != null ? ` · 시도 ${entry.attempt}` : ''}
                            {entry.status ? ` · ${entry.status}` : ''}
                          </p>
                          {entry.body ? <ExcerptBlock content={entry.body} emptyLabel="본문이 없습니다." /> : null}
                        </div>
                      ))}
                    </div>
                  </IncidentSection>

                  {incident.bundle.worktree ? (
                    <IncidentSection
                      title="워크트리"
                      summary={`${incident.bundle.worktree.branchName} · ${incident.bundle.worktree.status}`}
                      isOpen={openSections.worktree}
                      onToggle={() => toggleSection('worktree')}
                    >
                      <div className="space-y-4 rounded-xl border border-zinc-800 bg-zinc-950/60 p-4">
                        <div className="space-y-2 text-sm text-zinc-300">
                          <p>브랜치: {incident.bundle.worktree.branchName}</p>
                          <p>기준 브랜치: {incident.bundle.worktree.baseBranch}</p>
                          <p>기준 커밋: {incident.bundle.worktree.baseCommit}</p>
                          {incident.bundle.worktree.headCommit ? <p>HEAD 커밋: {incident.bundle.worktree.headCommit}</p> : null}
                          {incident.bundle.worktree.mergeCommit ? <p>Merge 커밋: {incident.bundle.worktree.mergeCommit}</p> : null}
                          <p>상태: {incident.bundle.worktree.status}</p>
                        </div>
                        <ExcerptBlock
                          content={incident.bundle.worktree.diffSummaryExcerpt}
                          truncated={incident.bundle.worktree.diffSummaryTruncated}
                          emptyLabel="diff 요약이 없습니다."
                        />
                      </div>
                    </IncidentSection>
                  ) : null}
                </div>
              </div>
            </div>

            <div className="space-y-6">
              <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5">
                <h3 className="text-sm font-semibold text-zinc-100">티켓 스냅샷</h3>
                <p className="mt-2 text-xs text-zinc-500">
                  {incident.bundle.ticket.id} · {incident.bundle.ticket.categoryId} · {ticketRunStateLabel(incident.bundle.ticket.runState)}
                </p>
                <h4 className="mt-2 text-base font-semibold text-zinc-100">{incident.bundle.ticket.title}</h4>
                <div className="mt-4 grid gap-3 text-xs text-zinc-400 sm:grid-cols-2 xl:grid-cols-1">
                  <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 px-3 py-3">
                    <p className="text-zinc-500">현재 단계</p>
                    <p className="mt-1 text-sm text-zinc-100">{incident.bundle.ticket.currentPhase ?? '기록 없음'}</p>
                  </div>
                  <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 px-3 py-3">
                    <p className="text-zinc-500">시도 횟수</p>
                    <p className="mt-1 text-sm text-zinc-100">{incident.bundle.ticket.attemptCount}</p>
                  </div>
                </div>
                <div className="mt-4 rounded-xl border border-zinc-800 bg-zinc-950/60 p-4">
                  <MarkdownContent content={incident.bundle.ticket.description} />
                </div>
              </div>

              <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5">
                <h3 className="text-sm font-semibold text-zinc-100">실패 맥락</h3>
                <div className="mt-4 space-y-3 text-sm text-zinc-300">
                  <div>
                    <p className="text-xs uppercase tracking-[0.18em] text-zinc-500">실패 유형</p>
                    <p className="mt-1">{triggerLabel(incident.trigger.kind)}</p>
                  </div>
                  <div>
                    <p className="text-xs uppercase tracking-[0.18em] text-zinc-500">시도 번호</p>
                    <p className="mt-1">{incident.trigger.attempt ?? '기록 없음'}</p>
                  </div>
                  <div>
                    <p className="text-xs uppercase tracking-[0.18em] text-zinc-500">실패 단계</p>
                    <p className="mt-1">{incident.trigger.phase ?? '기록 없음'}</p>
                  </div>
                  <div>
                    <p className="text-xs uppercase tracking-[0.18em] text-zinc-500">프로젝트</p>
                    <p className="mt-1">{incident.projectId}</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
        </div>
      </div>
    </div>
  )
}
