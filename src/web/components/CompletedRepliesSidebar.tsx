import { useEffect, useRef, useState } from 'react'

const OPEN_FEEDBACK_DELAY_MS = 120

function formatCompletedAt(value: string) {
  return new Date(value).toLocaleString()
}

export type CompletedReplySortOrder = 'newest' | 'oldest' | 'unread'

export interface CompletedReplyItem {
  id: string
  kindLabel: string
  scopeLabel: string
  promptPreview: string
  completedAt: string
  isUnread: boolean
  isRecovered: boolean
  onOpen: () => void
  onDismiss: () => void
}

interface CompletedRepliesSidebarProps {
  items: CompletedReplyItem[]
  collapsed: boolean
  sortOrder: CompletedReplySortOrder
  onToggleCollapse: () => void
  onSortOrderChange: (nextOrder: CompletedReplySortOrder) => void
  onDismissAll: () => void
}

export function CompletedRepliesSidebar({
  items,
  collapsed,
  sortOrder,
  onToggleCollapse,
  onSortOrderChange,
  onDismissAll,
}: CompletedRepliesSidebarProps) {
  const [openingItemId, setOpeningItemId] = useState<string | null>(null)
  const openTimerRef = useRef<number | null>(null)
  const unreadCount = items.filter((item) => item.isUnread).length

  useEffect(() => {
    return () => {
      if (openTimerRef.current !== null) {
        window.clearTimeout(openTimerRef.current)
      }
    }
  }, [])

  useEffect(() => {
    if (!openingItemId) {
      return
    }

    if (!items.some((item) => item.id === openingItemId)) {
      setOpeningItemId(null)
    }
  }, [items, openingItemId])

  const handleOpen = (item: CompletedReplyItem) => {
    if (openingItemId) {
      return
    }

    setOpeningItemId(item.id)

    if (openTimerRef.current !== null) {
      window.clearTimeout(openTimerRef.current)
    }

    openTimerRef.current = window.setTimeout(() => {
      openTimerRef.current = null
      item.onOpen()
      setOpeningItemId((current) => (current === item.id ? null : current))
    }, OPEN_FEEDBACK_DELAY_MS)
  }

  return (
    <div
      className={`flex h-full flex-col bg-zinc-950/95 transition-[width] duration-200 ${
        collapsed ? 'w-16' : 'w-80'
      }`}
    >
      <div className="border-b border-zinc-800 p-3">
        <div className={`flex items-start gap-2 ${collapsed ? 'justify-center' : 'justify-between'}`}>
          {collapsed ? null : (
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-zinc-500">Completed Replies</p>
                <span className="rounded-full border border-zinc-700 bg-zinc-900 px-2 py-0.5 text-[11px] font-medium text-zinc-200">
                  {items.length}
                </span>
                {unreadCount > 0 ? (
                  <span className="rounded-full border border-sky-900/70 bg-sky-950/40 px-2 py-0.5 text-[11px] font-medium text-sky-200">
                    읽지 않음 {unreadCount}
                  </span>
                ) : null}
              </div>
              <p className="mt-1 text-xs text-zinc-500">백그라운드에서 완료된 응답을 다시 열 수 있습니다.</p>
            </div>
          )}
          <button
            type="button"
            onClick={onToggleCollapse}
            aria-label={collapsed ? '완료된 답변 사이드바 펼치기' : '완료된 답변 사이드바 접기'}
            className="rounded-xl border border-zinc-700 bg-zinc-900 px-2.5 py-2 text-sm font-medium text-zinc-200 transition-colors hover:border-zinc-600 hover:bg-zinc-800"
          >
            {collapsed ? '<' : '>'}
          </button>
        </div>
        {collapsed ? (
          <div className="mt-3 flex flex-col items-center gap-2">
            <span className="rounded-full border border-zinc-700 bg-zinc-900 px-2 py-0.5 text-[11px] font-medium text-zinc-200">
              {items.length}
            </span>
            {unreadCount > 0 ? (
              <span className="rounded-full border border-sky-900/70 bg-sky-950/40 px-2 py-0.5 text-[10px] font-medium text-sky-200">
                {unreadCount}
              </span>
            ) : null}
            <span className="text-[10px] font-medium uppercase tracking-[0.18em] text-zinc-500">Done</span>
          </div>
        ) : (
          <div className="mt-3">
            <div className="flex items-end gap-2">
              <div className="min-w-0 flex-1">
                <label className="block text-[11px] font-medium uppercase tracking-[0.18em] text-zinc-500">
                  정렬
                </label>
                <select
                  aria-label="완료된 답변 정렬"
                  value={sortOrder}
                  onChange={(event) => onSortOrderChange(event.target.value as CompletedReplySortOrder)}
                  className="mt-2 w-full rounded-xl border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none transition-colors focus:border-zinc-500"
                >
                  <option value="newest">최신 순</option>
                  <option value="oldest">오래된 순</option>
                  <option value="unread">읽지 않음 우선</option>
                </select>
              </div>
              <button
                type="button"
                onClick={onDismissAll}
                disabled={items.length === 0}
                className="rounded-xl border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm font-medium text-zinc-200 transition-colors hover:border-zinc-600 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:border-zinc-800 disabled:bg-zinc-950 disabled:text-zinc-500"
              >
                전체 닫기
              </button>
            </div>
          </div>
        )}
      </div>

      {collapsed ? null : (
        <div className="flex-1 overflow-y-auto p-3">
          {items.length === 0 ? (
            <div className="flex h-full min-h-[240px] items-center justify-center rounded-2xl border border-dashed border-zinc-800 bg-zinc-900/40 p-6 text-center">
              <div>
                <p className="text-sm font-medium text-zinc-200">아직 완료된 응답이 없습니다.</p>
                <p className="mt-2 text-xs leading-6 text-zinc-500">
                  Explain이나 Direct Dev 응답이 백그라운드에서 끝나면 이 패널에 쌓입니다.
                </p>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              {items.map((item) => {
                const isOpening = openingItemId === item.id

                return (
                  <div
                    key={item.id}
                    className={`rounded-2xl border p-3 text-sm text-zinc-200 transition-all duration-150 ${
                      isOpening
                        ? 'scale-[0.985] border-sky-700/80 bg-sky-950/25 shadow-[0_0_0_1px_rgba(56,189,248,0.08)]'
                        : item.isUnread
                          ? 'border-sky-900/70 bg-sky-950/10'
                          : 'border-zinc-800 bg-zinc-900/70'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-zinc-500">
                          {item.kindLabel}
                        </p>
                        <p className="mt-1 truncate font-medium text-zinc-100">{item.scopeLabel}</p>
                      </div>
                      <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
                      {item.isUnread ? (
                        <span className="rounded-full border border-sky-900/70 bg-sky-950/40 px-2 py-0.5 text-[11px] font-medium text-sky-200">
                          읽지 않음
                        </span>
                      ) : null}
                      {item.isRecovered ? (
                        <span className="rounded-full border border-amber-900/70 bg-amber-950/40 px-2 py-0.5 text-[11px] font-medium text-amber-200">
                          새 세션 복구
                        </span>
                      ) : null}
                      <span className="rounded-full border border-emerald-900/70 bg-emerald-950/30 px-2 py-0.5 text-[11px] font-medium text-emerald-200">
                        완료
                      </span>
                      </div>
                    </div>
                    <p className="mt-3 line-clamp-3 text-sm leading-6 text-zinc-300">
                      {item.promptPreview || '완료된 응답입니다.'}
                    </p>
                    <p className="mt-3 text-[11px] text-zinc-500">{formatCompletedAt(item.completedAt)}</p>
                    <div className="mt-3 flex gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          handleOpen(item)
                        }}
                        disabled={isOpening}
                        className={`rounded-xl px-3 py-1.5 text-xs font-medium transition-all duration-150 ${
                          isOpening
                            ? 'cursor-progress bg-sky-200 text-sky-950'
                            : 'bg-zinc-100 text-zinc-950 hover:-translate-y-0.5 hover:bg-white active:translate-y-0 active:scale-[0.985]'
                        }`}
                      >
                        {isOpening ? '여는 중...' : '열기'}
                      </button>
                      <button
                        type="button"
                        onClick={item.onDismiss}
                        disabled={isOpening}
                        className={`rounded-xl border px-3 py-1.5 text-xs font-medium transition-all duration-150 ${
                          isOpening
                            ? 'cursor-not-allowed border-zinc-800 bg-zinc-900/60 text-zinc-500'
                            : 'border-zinc-700 bg-zinc-900 text-zinc-300 hover:-translate-y-0.5 hover:border-zinc-600 hover:bg-zinc-800 active:translate-y-0 active:scale-[0.985]'
                        }`}
                      >
                        닫기
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
