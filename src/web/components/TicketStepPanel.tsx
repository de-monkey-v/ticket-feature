import { useMemo } from 'react'
import type { PublicVerificationRun, ReviewRun } from '../lib/api'
import { extractAttemptSection, resolveAttemptNumber } from '../lib/ticket-attempts'
import { MarkdownContent } from './MarkdownContent'

interface TicketStepPanelProps {
  stepId: string
  stepName: string
  agentDisplayName?: string
  agentRole?: string
  status: string
  output: string
  runId?: string
  attemptOptions?: number[]
  selectedAttempt?: number | null
  onSelectAttempt?: (attempt: number) => void
  verificationRuns?: PublicVerificationRun[]
  reviewRuns?: ReviewRun[]
  isOpen: boolean
  onToggle: () => void
  canRun: boolean
  onRun: () => void
}

const statusColors: Record<string, string> = {
  pending: 'bg-zinc-800 text-zinc-400',
  running: 'bg-blue-900 text-blue-300',
  done: 'bg-green-900 text-green-300',
  awaiting_approval: 'bg-yellow-900 text-yellow-300',
  approved: 'bg-green-900 text-green-300',
  rejected: 'bg-red-900 text-red-300',
  failed: 'bg-red-900 text-red-300',
}

export function TicketStepPanel({
  stepId,
  stepName,
  agentDisplayName,
  agentRole,
  status,
  output,
  runId,
  attemptOptions = [],
  selectedAttempt,
  onSelectAttempt,
  verificationRuns = [],
  reviewRuns = [],
  isOpen,
  onToggle,
  canRun,
  onRun,
}: TicketStepPanelProps) {
  const hasAttemptSelection =
    (stepId === 'implement' || stepId === 'verify' || stepId === 'review') && attemptOptions.length > 0 && !!onSelectAttempt
  const hasVerificationRuns = stepId === 'verify' && verificationRuns.length > 0
  const hasReviewRuns = stepId === 'review' && reviewRuns.length > 0
  const hasOutput = output.trim().length > 0 || hasVerificationRuns || hasReviewRuns
  const resolvedAttempt = useMemo(
    () => (hasAttemptSelection ? resolveAttemptNumber(attemptOptions, selectedAttempt) : null),
    [attemptOptions, hasAttemptSelection, selectedAttempt]
  )

  const selectedVerificationRun = useMemo(() => {
    if (!hasVerificationRuns) {
      return null
    }

    return verificationRuns.find((verificationRun) => verificationRun.attempt === resolvedAttempt) ?? null
  }, [hasVerificationRuns, resolvedAttempt, verificationRuns])

  const selectedReviewRun = useMemo(() => {
    if (!hasReviewRuns) {
      return null
    }

    return reviewRuns.find((reviewRun) => reviewRun.attempt === resolvedAttempt) ?? null
  }, [hasReviewRuns, resolvedAttempt, reviewRuns])

  const selectedOutput = useMemo(() => {
    if (stepId === 'implement') {
      return extractAttemptSection(output, '구현 시도', resolvedAttempt)
    }

    if (stepId === 'verify') {
      if (selectedVerificationRun) {
        return extractAttemptSection(output, '검증 시도', selectedVerificationRun.attempt)
      }

      return resolvedAttempt != null ? '선택한 시도의 검증 기록이 아직 없습니다.' : output
    }

    if (stepId === 'review') {
      if (selectedReviewRun) {
        return selectedReviewRun.output.trim()
      }

      return resolvedAttempt != null ? '선택한 시도의 리뷰 기록이 아직 없습니다.' : output
    }

    return output
  }, [output, resolvedAttempt, selectedReviewRun, selectedVerificationRun, stepId])

  const canToggle = hasOutput

  return (
    <div className="border border-zinc-800 rounded-lg overflow-hidden">
      <div className="flex items-center gap-2 bg-zinc-900/50 px-4 py-3">
        <button
          type="button"
          onClick={() => {
            if (canToggle) {
              onToggle()
            }
          }}
          className={`flex min-w-0 flex-1 items-center justify-between gap-3 text-left ${
            canToggle ? 'cursor-pointer' : 'cursor-default'
          }`}
          aria-expanded={canToggle ? isOpen : undefined}
          aria-controls={`ticket-step-panel-${stepId}`}
        >
          <div className="flex min-w-0 items-center gap-2 flex-wrap">
            {status === 'running' ? (
              <span
                className="h-4 w-4 flex-none rounded-full border-2 border-blue-400/30 border-t-blue-400 animate-spin"
                aria-hidden="true"
              />
            ) : null}
            <span className="truncate font-medium text-sm">{stepName}</span>
            {agentDisplayName ? (
              <span className="rounded-full border border-violet-900/60 bg-violet-950/30 px-2 py-0.5 text-[11px] text-violet-200">
                {agentDisplayName}
                {agentRole ? ` · ${agentRole}` : ''}
              </span>
            ) : null}
            <span
              className={`text-xs px-2 py-0.5 rounded-full ${statusColors[status] || statusColors.pending}`}
            >
              {status}
            </span>
          </div>
          {canToggle ? (
            <span
              className={`flex-none text-zinc-500 transition-transform duration-200 ${isOpen ? 'rotate-90' : ''}`}
              aria-hidden="true"
            >
              <svg viewBox="0 0 20 20" className="h-4 w-4 fill-current">
                <path d="M7.1 4.8a1 1 0 0 1 1.4 0l4.5 4.5a1 1 0 0 1 0 1.4l-4.5 4.5a1 1 0 1 1-1.4-1.4L10.9 10 7.1 6.2a1 1 0 0 1 0-1.4Z" />
              </svg>
            </span>
          ) : null}
        </button>
        {canRun && (
          <button
            onClick={onRun}
            className="rounded bg-blue-600 px-3 py-1 text-xs font-medium transition-colors hover:bg-blue-700"
          >
            Run
          </button>
        )}
      </div>

      {hasOutput && isOpen ? (
        <div id={`ticket-step-panel-${stepId}`} className="border-t border-zinc-800 px-4 py-3 text-sm">
          {hasAttemptSelection && resolvedAttempt != null ? (
            <div className="space-y-4">
              <div className="flex flex-wrap gap-2">
                {attemptOptions.map((attemptNumber) => {
                  const attemptVerificationRun = verificationRuns.find((verificationRun) => verificationRun.attempt === attemptNumber)
                  const attemptReviewRun = reviewRuns.find((reviewRun) => reviewRun.attempt === attemptNumber)
                  const isSelected = attemptNumber === resolvedAttempt

                  return (
                    <button
                      key={attemptNumber}
                      type="button"
                      onClick={() => onSelectAttempt(attemptNumber)}
                      className={`rounded-md border px-3 py-2 text-left text-xs transition-colors ${
                        isSelected
                          ? 'border-blue-500 bg-blue-950/40 text-blue-100'
                          : 'border-zinc-700 bg-zinc-900 text-zinc-300 hover:border-zinc-500 hover:text-zinc-100'
                      }`}
                    >
                      <div className="font-medium">Attempt {attemptNumber}</div>
                      {attemptVerificationRun ? (
                        <div className="mt-1 text-[11px] opacity-80">
                          {attemptVerificationRun.status === 'passed' ? 'PASS' : 'FAIL'}
                        </div>
                      ) : null}
                      {attemptReviewRun ? (
                        <div className="mt-1 text-[11px] opacity-80">
                          {attemptReviewRun.verdict === 'pass' ? 'PASS' : 'FAIL'}
                        </div>
                      ) : null}
                    </button>
                  )
                })}
              </div>

              <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 px-3 py-3 text-xs text-zinc-300">
                <div className="flex flex-wrap gap-x-4 gap-y-2">
                  <span>
                    {stepName} attempt: <span className="text-zinc-100">{resolvedAttempt}</span>
                  </span>
                  {stepId !== 'implement' ? (
                    <span>
                      Linked implement attempt: <span className="text-zinc-100">{resolvedAttempt}</span>
                    </span>
                  ) : null}
                  {runId ? (
                    <span>
                      Run: <span className="font-mono text-zinc-100">{runId}</span>
                    </span>
                  ) : null}
                  {selectedVerificationRun ? (
                    <span>
                      Status:{' '}
                      <span className={selectedVerificationRun.status === 'passed' ? 'text-green-300' : 'text-red-300'}>
                        {selectedVerificationRun.status === 'passed' ? 'PASS' : 'FAIL'}
                      </span>
                    </span>
                  ) : null}
                  {selectedReviewRun ? (
                    <span>
                      Verdict:{' '}
                      <span className={selectedReviewRun.verdict === 'pass' ? 'text-green-300' : 'text-red-300'}>
                        {selectedReviewRun.verdict === 'pass' ? 'PASS' : 'FAIL'}
                      </span>
                    </span>
                  ) : null}
                </div>
              </div>

              <MarkdownContent content={selectedOutput} />
            </div>
          ) : (
            <MarkdownContent content={output} />
          )}
        </div>
      ) : null}
    </div>
  )
}
