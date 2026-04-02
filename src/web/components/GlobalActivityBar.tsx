export interface GlobalActivityItem {
  id: string
  title: string
  detail: string
  statusLabel: string
  tone: 'active' | 'success' | 'warning' | 'error'
  isTerminal?: boolean
  onOpen?: () => void
  onStop?: () => void
  onDismiss?: () => void
}

interface GlobalActivityBarProps {
  items: GlobalActivityItem[]
}

function toneClassName(tone: GlobalActivityItem['tone']) {
  if (tone === 'success') {
    return 'border-emerald-900/70 bg-emerald-950/20 text-emerald-100'
  }

  if (tone === 'warning') {
    return 'border-amber-900/70 bg-amber-950/20 text-amber-100'
  }

  if (tone === 'error') {
    return 'border-red-900/70 bg-red-950/20 text-red-100'
  }

  return 'border-sky-900/70 bg-sky-950/20 text-sky-100'
}

export function GlobalActivityBar({ items }: GlobalActivityBarProps) {
  if (items.length === 0) {
    return null
  }

  return (
    <div className="border-b border-zinc-800 bg-zinc-950/95 px-6 py-3">
      <div className="flex items-center gap-3 overflow-x-auto">
        <p className="shrink-0 text-xs font-medium uppercase tracking-[0.18em] text-zinc-500">Activity</p>
        {items.map((item) => (
          <div
            key={item.id}
            className={`min-w-[280px] shrink-0 rounded-2xl border px-4 py-3 ${toneClassName(item.tone)}`}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{item.title}</p>
                <p className="mt-1 text-xs opacity-80">{item.detail}</p>
              </div>
              <span className="shrink-0 rounded-full border border-current/20 px-2 py-0.5 text-[11px] font-medium">
                {item.statusLabel}
              </span>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {item.onOpen ? (
                <button
                  type="button"
                  onClick={item.onOpen}
                  className="rounded-lg bg-zinc-900/70 px-3 py-1.5 text-xs text-zinc-100 transition hover:bg-zinc-800"
                >
                  열기
                </button>
              ) : null}
              {item.onStop ? (
                <button
                  type="button"
                  onClick={item.onStop}
                  className="rounded-lg border border-red-900/70 bg-red-950/30 px-3 py-1.5 text-xs font-medium text-red-100 transition hover:bg-red-950/50"
                >
                  중지
                </button>
              ) : null}
              {item.isTerminal && item.onDismiss ? (
                <button
                  type="button"
                  onClick={item.onDismiss}
                  className="rounded-lg border border-zinc-800 bg-zinc-900/70 px-3 py-1.5 text-xs text-zinc-300 transition hover:bg-zinc-800"
                >
                  닫기
                </button>
              ) : null}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
