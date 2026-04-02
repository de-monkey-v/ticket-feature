import {
  getStreamingAssistantEffectClassName,
  type ExplainTextEffectId,
} from '../lib/explain-effects'
import { MarkdownContent } from './MarkdownContent'

interface ChatMessageProps {
  role: 'user' | 'assistant'
  content: string
  canEdit?: boolean
  onEdit?: () => void
  isPending?: boolean
  pendingLabel?: string
  pendingDetail?: string
  streamTextEffect?: ExplainTextEffectId
}

export function shouldRenderPendingAssistantPlaceholder(role: ChatMessageProps['role'], isPending: boolean, content: string) {
  return role === 'assistant' && isPending && !content.trim()
}

export function shouldRenderPendingAssistantFooter(role: ChatMessageProps['role'], isPending: boolean, content: string) {
  return role === 'assistant' && isPending && Boolean(content.trim())
}

export function ChatMessage({
  role,
  content,
  canEdit = false,
  onEdit,
  isPending = false,
  pendingLabel,
  pendingDetail,
  streamTextEffect = 'plain',
}: ChatMessageProps) {
  const showPendingAssistant = shouldRenderPendingAssistantPlaceholder(role, isPending, content)
  const showPendingFooter = shouldRenderPendingAssistantFooter(role, isPending, content)
  const streamingAssistantEffectClassName =
    role === 'assistant' && isPending ? getStreamingAssistantEffectClassName(streamTextEffect) : ''

  if (showPendingAssistant) {
    return (
      <div className="py-4">
        <div className="max-w-[80%] rounded-2xl rounded-tl-sm border border-sky-900/70 bg-sky-950/20 px-4 py-3 text-sky-100">
          <div className="flex items-start gap-3">
            <span className="mt-1.5 h-2.5 w-2.5 flex-none rounded-full bg-sky-400 animate-pulse" />
            <div className="min-w-0">
              <p className="text-sm font-medium">{pendingLabel || '응답 준비 중'}</p>
              <p className="mt-1 text-xs text-sky-100/80">
                {pendingDetail || 'Codex가 답변을 준비하고 있습니다.'}
              </p>
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className={`py-4 ${role === 'user' ? 'flex justify-end' : ''}`}>
      <div className={`min-w-0 max-w-[80%] ${role === 'user' ? 'flex flex-col items-end gap-2' : ''}`}>
        {role === 'user' ? (
          <div className="rounded-2xl rounded-br-sm bg-blue-600 px-4 py-2 text-white">
            <p className="text-sm whitespace-pre-wrap break-words">{content}</p>
          </div>
        ) : (
          <div className="min-w-0 space-y-2">
            <div className={`min-w-0 text-zinc-200 ${streamingAssistantEffectClassName}`.trim()}>
              <MarkdownContent content={content} />
            </div>
            {showPendingFooter ? (
              <div className="inline-flex max-w-full items-center gap-2 rounded-full border border-sky-900/70 bg-sky-950/20 px-3 py-1 text-xs text-sky-100/90">
                <span className="h-2 w-2 flex-none rounded-full bg-sky-400 animate-pulse" />
                <span className="truncate font-medium">{pendingLabel || '답변 생성 중'}</span>
                {pendingDetail ? <span className="truncate text-sky-100/70">· {pendingDetail}</span> : null}
              </div>
            ) : null}
          </div>
        )}

        {role === 'user' && canEdit ? (
          <button
            type="button"
            onClick={onEdit}
            className="text-xs font-medium text-zinc-500 transition-colors hover:text-zinc-300"
          >
            수정
          </button>
        ) : null}
      </div>
    </div>
  )
}
