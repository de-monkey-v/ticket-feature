import { useEffect, useMemo, useRef } from 'react'
import type { StageReview, TicketDetail, TicketRunDetail, TicketTimelineEvent } from '../lib/api'
import { extractAttemptSection, resolveAttemptItem } from '../lib/ticket-attempts'
import { MarkdownContent } from './MarkdownContent'

interface TicketTimelineModalProps {
  ticket: TicketDetail
  run: TicketRunDetail | null
  entry: TicketTimelineEvent | null
  currentStep: string | null
  streamingOutputs: Record<string, string>
  isStreaming: boolean
  onClose: () => void
}

function getStepOutput(run: TicketRunDetail | null, stepId: string, streamingOutputs: Record<string, string>) {
  return `${run?.steps[stepId]?.output || ''}${streamingOutputs[stepId] || ''}`.trim()
}

function findStageReviewOutput(
  reviews: StageReview[],
  subjectStepId: 'analyze' | 'plan',
  attempt?: number
) {
  const candidates = reviews.filter((review) => review.subjectStepId === subjectStepId)

  return resolveAttemptItem(candidates, attempt)?.output.trim() || ''
}

function getRelatedOutput(run: TicketRunDetail | null, entry: TicketTimelineEvent, streamingOutputs: Record<string, string>) {
  if (!run || !entry.stepId) {
    return ''
  }

  if (entry.stepId === 'analyze_review') {
    return findStageReviewOutput(run.stageReviews, 'analyze', entry.attempt)
  }

  if (entry.stepId === 'plan_review') {
    return findStageReviewOutput(run.stageReviews, 'plan', entry.attempt)
  }

  if (entry.stepId === 'review') {
    const reviewRun = resolveAttemptItem(run.reviewRuns, entry.attempt)

    return reviewRun?.output.trim() || getStepOutput(run, 'review', streamingOutputs)
  }

  if (entry.stepId === 'verify') {
    return extractAttemptSection(getStepOutput(run, 'verify', streamingOutputs), '검증 시도', entry.attempt)
  }

  if (entry.stepId === 'implement') {
    return extractAttemptSection(getStepOutput(run, 'implement', streamingOutputs), '구현 시도', entry.attempt)
  }

  return getStepOutput(run, entry.stepId, streamingOutputs)
}

function getOutputLabel(stepId?: string) {
  if (!stepId) return '상세 정보'
  if (stepId === 'implement') return '실시간 구현 출력'
  if (stepId === 'verify') return '검증 요약'
  if (stepId === 'review' || stepId === 'analyze_review' || stepId === 'plan_review') return '리뷰 결과'
  if (stepId === 'ready') return '최종 보고'
  return '단계 출력'
}

function getCurrentAttemptForStep(run: TicketRunDetail | null, stepId: string) {
  if (!run) {
    return 0
  }

  if (stepId === 'analyze_review') {
    return run.stageReviews.filter((review) => review.subjectStepId === 'analyze').length + 1
  }

  if (stepId === 'plan_review') {
    return run.stageReviews.filter((review) => review.subjectStepId === 'plan').length + 1
  }

  return run.attemptCount
}

export function isLiveTimelineEntry(
  run: TicketRunDetail | null,
  entry: TicketTimelineEvent,
  currentStep: string | null,
  isStreaming: boolean
) {
  if (!entry.stepId || currentStep !== entry.stepId || !isStreaming) {
    return false
  }

  if (entry.attempt == null) {
    return true
  }

  return entry.attempt === getCurrentAttemptForStep(run, entry.stepId)
}

export function TicketTimelineModal({
  ticket,
  run,
  entry,
  currentStep,
  streamingOutputs,
  isStreaming,
  onClose,
}: TicketTimelineModalProps) {
  const outputContainerRef = useRef<HTMLDivElement | null>(null)
  const isLiveEntry = entry ? isLiveTimelineEntry(run, entry, currentStep, isStreaming) : false
  const relatedOutput = useMemo(
    () => (entry ? getRelatedOutput(run, entry, streamingOutputs) : ''),
    [entry, run, streamingOutputs]
  )

  useEffect(() => {
    if (!entry) {
      return
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose()
      }
    }

    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', handleKeyDown)

    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [entry, onClose])

  useEffect(() => {
    if (!isLiveEntry) {
      return
    }

    const container = outputContainerRef.current
    if (!container) {
      return
    }

    container.scrollTop = container.scrollHeight
  }, [isLiveEntry, relatedOutput])

  if (!entry) {
    return null
  }

  return (
    <div
      className="fixed inset-0 z-50 overflow-y-auto overflow-x-hidden bg-black/80 p-4 backdrop-blur-sm sm:p-8"
      role="dialog"
      aria-modal="true"
      aria-label="Timeline 상세"
      onClick={onClose}
    >
      <div
        className="mx-auto flex min-h-[min(88vh,820px)] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-zinc-700 bg-zinc-950 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 border-b border-zinc-800 px-5 py-4">
          <div className="min-w-0">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className="rounded-full border border-zinc-700 bg-zinc-900 px-2 py-1 text-[11px] text-zinc-300">
                {entry.type}
              </span>
              {entry.status ? (
                <span className="rounded-full border border-zinc-700 bg-zinc-900 px-2 py-1 text-[11px] text-zinc-300">
                  {entry.status}
                </span>
              ) : null}
              {entry.attempt != null ? (
                <span className="rounded-full border border-zinc-700 bg-zinc-900 px-2 py-1 text-[11px] text-zinc-300">
                  attempt {entry.attempt}
                </span>
              ) : null}
              {isLiveEntry ? (
                <span className="rounded-full border border-blue-500/40 bg-blue-950/60 px-2 py-1 text-[11px] font-medium text-blue-200">
                  LIVE
                </span>
              ) : null}
              {run ? (
                <span className="rounded-full border border-zinc-700 bg-zinc-900 px-2 py-1 text-[11px] text-zinc-300">
                  {run.id}
                </span>
              ) : null}
            </div>
            <h3 className="text-lg font-semibold text-zinc-100">{entry.title}</h3>
            <p className="mt-1 text-xs text-zinc-500">
              {entry.createdAt}
              {entry.stepId ? ` · step: ${entry.stepId}` : ''}
              {entry.stepId && run?.currentPhase === entry.stepId ? ' · current phase' : ''}
              {ticket.activeRunId === run?.id ? ' · active run' : ''}
            </p>
          </div>
          <button
            type="button"
            autoFocus
            className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-200 transition hover:border-zinc-500 hover:bg-zinc-900"
            onClick={onClose}
          >
            닫기
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {entry.body ? (
            <div className="mb-4 rounded-xl border border-zinc-800 bg-zinc-900/70 p-4">
              <p className="mb-2 text-xs font-medium uppercase tracking-[0.18em] text-zinc-500">Summary</p>
              <p className="whitespace-pre-wrap text-sm text-zinc-200">{entry.body}</p>
            </div>
          ) : null}

          <div className="rounded-xl border border-zinc-800 bg-zinc-900/50">
            <div className="flex items-center justify-between gap-3 border-b border-zinc-800 px-4 py-3">
              <div>
                <p className="text-sm font-medium text-zinc-100">{getOutputLabel(entry.stepId)}</p>
                <p className="text-xs text-zinc-500">
                  {isLiveEntry
                    ? '실행 중인 출력이 실시간으로 갱신됩니다.'
                    : '이 timeline 항목과 연결된 실행 결과입니다.'}
                </p>
              </div>
              {entry.stepId ? <p className="text-xs font-mono text-zinc-500">{entry.stepId}</p> : null}
            </div>
            <div ref={outputContainerRef} className="max-h-[58vh] overflow-y-auto px-4 py-4">
              {relatedOutput ? (
                <MarkdownContent content={relatedOutput} />
              ) : (
                <p className="text-sm text-zinc-500">
                  {isLiveEntry
                    ? '아직 표시할 실시간 출력이 없습니다. 이벤트가 수집되면 여기에 이어서 표시됩니다.'
                    : '이 timeline 항목에 연결된 상세 출력이 아직 없습니다.'}
                </p>
              )}
            </div>
          </div>
        </div>

        <div className="border-t border-zinc-800 px-5 py-3 text-xs text-zinc-400">
          배경을 클릭하거나 Esc 키를 누르면 닫힙니다.
        </div>
      </div>
    </div>
  )
}
