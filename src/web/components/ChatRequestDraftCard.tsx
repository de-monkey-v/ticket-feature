import type { AppConfig, RequestTemplateFields } from '../lib/api'

export interface ChatRequestDraft {
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

interface ChatRequestDraftCardProps {
  draft: ChatRequestDraft
  categories: AppConfig['flows']['ticket']['categories']
  onChange: (draftId: string, patch: Partial<ChatRequestDraft>) => void
  onSave: (draftId: string) => void
  onRefine: (draftId: string) => void
  onDiscard: (draftId: string) => void
}

function statusLabel(status: ChatRequestDraft['status']) {
  switch (status) {
    case 'drafting':
      return 'Drafting'
    case 'saving':
      return 'Saving'
    case 'saved':
      return 'Saved'
    case 'error':
      return 'Error'
    default:
      return 'Draft'
  }
}

export function ChatRequestDraftCard({
  draft,
  categories,
  onChange,
  onSave,
  onRefine,
  onDiscard,
}: ChatRequestDraftCardProps) {
  const isLocked = draft.status === 'drafting' || draft.status === 'saving' || draft.status === 'saved'
  const canSave =
    !isLocked &&
    draft.title.trim() &&
    draft.template.problem.trim() &&
    draft.template.desiredOutcome.trim() &&
    draft.template.userScenarios.trim() &&
    draft.categoryId
  const canRefine = draft.status !== 'drafting' && draft.status !== 'saving' && draft.status !== 'saved'
  const canDiscard = draft.status !== 'saving'

  return (
    <div className="rounded-2xl border border-emerald-800/70 bg-emerald-950/20 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-emerald-200">Request Draft</p>
          <p className="text-xs text-emerald-100/70">
            {draft.status === 'drafting'
              ? 'Codex가 현재 대화를 request 초안으로 정리하는 중입니다.'
              : draft.status === 'saved'
                ? `저장 완료: ${draft.requestId}`
                : 'Codex가 현재 대화를 request 초안으로 정리했습니다.'}
          </p>
        </div>
        <span className="rounded-full border border-emerald-800 bg-emerald-950/60 px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-emerald-200">
          {statusLabel(draft.status)}
        </span>
      </div>

      <div className="mt-3 grid gap-3">
        <div className="grid gap-1">
          <label className="text-xs font-medium text-zinc-400">Requester</label>
          <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2 text-sm text-zinc-300">
            Codex Chat
          </div>
        </div>

        <div className="grid gap-1">
          <label className="text-xs font-medium text-zinc-400">Title</label>
          <input
            value={draft.title}
            onChange={(e) => onChange(draft.id, { title: e.target.value })}
            disabled={isLocked}
            className="w-full rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2 text-sm text-zinc-100 focus:border-emerald-600 focus:outline-none disabled:cursor-not-allowed disabled:text-zinc-500"
          />
        </div>

        <div className="grid gap-1">
          <label className="text-xs font-medium text-zinc-400">Category</label>
          <select
            value={draft.categoryId}
            onChange={(e) => onChange(draft.id, { categoryId: e.target.value })}
            disabled={isLocked}
            className="w-full rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2 text-sm text-zinc-100 focus:border-emerald-600 focus:outline-none disabled:cursor-not-allowed disabled:text-zinc-500"
          >
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.label}
              </option>
            ))}
          </select>
        </div>

        <div className="grid gap-1">
          <label className="text-xs font-medium text-zinc-400">Problem</label>
          <textarea
            value={draft.template.problem}
            onChange={(e) => onChange(draft.id, { template: { ...draft.template, problem: e.target.value } })}
            disabled={isLocked}
            rows={4}
            className="w-full resize-none rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2 text-sm text-zinc-100 focus:border-emerald-600 focus:outline-none disabled:cursor-not-allowed disabled:text-zinc-500"
          />
        </div>

        <div className="grid gap-1">
          <label className="text-xs font-medium text-zinc-400">Desired Outcome</label>
          <textarea
            value={draft.template.desiredOutcome}
            onChange={(e) =>
              onChange(draft.id, { template: { ...draft.template, desiredOutcome: e.target.value } })
            }
            disabled={isLocked}
            rows={4}
            className="w-full resize-none rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2 text-sm text-zinc-100 focus:border-emerald-600 focus:outline-none disabled:cursor-not-allowed disabled:text-zinc-500"
          />
        </div>

        <div className="grid gap-1">
          <label className="text-xs font-medium text-zinc-400">User Scenarios</label>
          <textarea
            value={draft.template.userScenarios}
            onChange={(e) => onChange(draft.id, { template: { ...draft.template, userScenarios: e.target.value } })}
            disabled={isLocked}
            rows={4}
            className="w-full resize-none rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2 text-sm text-zinc-100 focus:border-emerald-600 focus:outline-none disabled:cursor-not-allowed disabled:text-zinc-500"
          />
        </div>

        <div className="grid gap-1">
          <label className="text-xs font-medium text-zinc-400">Constraints</label>
          <textarea
            value={draft.template.constraints ?? ''}
            onChange={(e) => onChange(draft.id, { template: { ...draft.template, constraints: e.target.value } })}
            disabled={isLocked}
            rows={3}
            className="w-full resize-none rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2 text-sm text-zinc-100 focus:border-emerald-600 focus:outline-none disabled:cursor-not-allowed disabled:text-zinc-500"
          />
        </div>

        <div className="grid gap-1">
          <label className="text-xs font-medium text-zinc-400">Non-Goals</label>
          <textarea
            value={draft.template.nonGoals ?? ''}
            onChange={(e) => onChange(draft.id, { template: { ...draft.template, nonGoals: e.target.value } })}
            disabled={isLocked}
            rows={3}
            className="w-full resize-none rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2 text-sm text-zinc-100 focus:border-emerald-600 focus:outline-none disabled:cursor-not-allowed disabled:text-zinc-500"
          />
        </div>

        <div className="grid gap-1">
          <label className="text-xs font-medium text-zinc-400">Open Questions</label>
          <textarea
            value={draft.template.openQuestions ?? ''}
            onChange={(e) => onChange(draft.id, { template: { ...draft.template, openQuestions: e.target.value } })}
            disabled={isLocked}
            rows={3}
            className="w-full resize-none rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2 text-sm text-zinc-100 focus:border-emerald-600 focus:outline-none disabled:cursor-not-allowed disabled:text-zinc-500"
          />
        </div>

        {draft.rationale ? (
          <div className="rounded-lg border border-emerald-900/60 bg-emerald-950/30 px-3 py-2">
            <p className="text-xs font-medium text-emerald-200">Codex Note</p>
            <p className="mt-1 whitespace-pre-wrap text-xs text-emerald-100/80">{draft.rationale}</p>
          </div>
        ) : null}

        {draft.error ? <p className="text-xs text-red-400">{draft.error}</p> : null}

        {draft.status !== 'saved' ? (
          <div className="rounded-lg border border-zinc-800 bg-zinc-950/50 px-3 py-2 text-xs text-zinc-400">
            Explain에서 더 이야기한 뒤 <span className="font-medium text-zinc-200">채팅 반영해 다시 정리</span>를 누르면
            현재 대화와 이 초안 내용을 함께 반영해 다시 정리합니다.
          </div>
        ) : null}

        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-[11px] text-zinc-500">
            {draft.explainThreadId ? `Explain thread: ${draft.explainThreadId}` : 'Explain thread 없음'}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => onDiscard(draft.id)}
              disabled={!canDiscard}
              className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm font-medium text-zinc-200 transition-colors hover:bg-zinc-800 disabled:cursor-not-allowed disabled:border-zinc-800 disabled:bg-zinc-900 disabled:text-zinc-500"
            >
              초안 취소
            </button>
            <button
              type="button"
              onClick={() => onRefine(draft.id)}
              disabled={!canRefine}
              className="rounded-lg border border-emerald-800 bg-emerald-950/60 px-3 py-2 text-sm font-medium text-emerald-100 transition-colors hover:bg-emerald-900/70 disabled:cursor-not-allowed disabled:border-zinc-800 disabled:bg-zinc-900 disabled:text-zinc-500"
            >
              {draft.status === 'error' ? '다시 정리 시도' : '채팅 반영해 다시 정리'}
            </button>
            <button
              onClick={() => onSave(draft.id)}
              disabled={!canSave}
              className="rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-zinc-800 disabled:text-zinc-500"
            >
              {draft.status === 'saving' ? 'Saving...' : draft.status === 'saved' ? 'Saved' : 'Save Request'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
