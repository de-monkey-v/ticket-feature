import { useEffect } from 'react'

interface ShortcutsHelpDialogProps {
  open: boolean
  onClose: () => void
}

const SHORTCUT_GROUPS = [
  {
    title: 'Navigation',
    items: [
      { keys: 'Alt+P', description: '프로젝트 전환 팝업 열기' },
      { keys: 'Alt+1-5', description: '현재 대화 목록에서 빠르게 선택' },
    ],
  },
  {
    title: 'Composer',
    items: [
      { keys: 'Alt+N', description: '새 thread 또는 session 만들기' },
      { keys: 'Alt+E', description: '입력창으로 바로 이동' },
    ],
  },
  {
    title: 'Help',
    items: [
      { keys: '?', description: '이 단축키 도움말 열기' },
      { keys: 'Esc', description: '열린 팝업 또는 모달 닫기' },
    ],
  },
]

export function ShortcutsHelpDialog({ open, onClose }: ShortcutsHelpDialogProps) {
  useEffect(() => {
    if (!open) {
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
  }, [onClose, open])

  if (!open) {
    return null
  }

  return (
    <div
      className="fixed inset-0 z-50 overflow-y-auto overflow-x-hidden bg-black/80 p-4 backdrop-blur-sm sm:p-8"
      role="dialog"
      aria-modal="true"
      aria-label="단축키 도움말"
      onClick={onClose}
    >
      <div
        className="mx-auto flex min-h-[min(82vh,720px)] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-zinc-700 bg-zinc-950 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 border-b border-zinc-800 px-5 py-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-lg font-semibold text-zinc-100">Keyboard Shortcuts</h3>
              <span className="rounded-full border border-violet-900/70 bg-violet-950/30 px-2 py-0.5 text-[11px] font-medium text-violet-200">
                ?
              </span>
            </div>
            <p className="mt-1 text-sm text-zinc-400">자주 쓰는 이동과 작성 단축키를 여기서 다시 확인할 수 있습니다.</p>
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

        <div className="flex-1 overflow-y-auto px-5 py-5">
          <div className="grid gap-4 md:grid-cols-3">
            {SHORTCUT_GROUPS.map((group) => (
              <section key={group.title} className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-4">
                <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-zinc-500">{group.title}</p>
                <div className="mt-4 space-y-3">
                  {group.items.map((item) => (
                    <div key={item.keys} className="rounded-xl border border-zinc-800 bg-zinc-950/70 px-3 py-3">
                      <div className="inline-flex rounded-full border border-zinc-700 bg-zinc-900 px-2 py-0.5 text-xs font-medium text-zinc-100">
                        {item.keys}
                      </div>
                      <p className="mt-2 text-sm text-zinc-300">{item.description}</p>
                    </div>
                  ))}
                </div>
              </section>
            ))}
          </div>
        </div>

        <div className="border-t border-zinc-800 px-5 py-3 text-xs text-zinc-500">
          입력창에서는 `?`를 그대로 입력할 수 있고, 비입력 영역에서만 도움말이 열립니다.
        </div>
      </div>
    </div>
  )
}
