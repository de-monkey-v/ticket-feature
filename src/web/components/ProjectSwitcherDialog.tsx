import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { AppConfig } from '../lib/api'
import { clampSelectionIndex, moveSelectionIndex } from '../lib/keyboard-shortcuts'

interface ProjectSwitcherDialogProps {
  open: boolean
  projects: AppConfig['allowedProjects']
  projectId: string
  highlightedIndex: number
  onHighlightChange: (index: number) => void
  onProjectChange: (projectId: string) => void
  onClose: () => void
}

export function ProjectSwitcherDialog({
  open,
  projects,
  projectId,
  highlightedIndex,
  onHighlightChange,
  onProjectChange,
  onClose,
}: ProjectSwitcherDialogProps) {
  const listRef = useRef<HTMLDivElement>(null)
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([])

  useEffect(() => {
    if (!open) {
      return
    }

    listRef.current?.focus()
  }, [open])

  useEffect(() => {
    if (!open) {
      return
    }

    const safeIndex = clampSelectionIndex(highlightedIndex, projects.length)
    if (safeIndex === -1) {
      return
    }

    const target = optionRefs.current[safeIndex]
    if (!target) {
      return
    }

    window.requestAnimationFrame(() => {
      target.scrollIntoView({
        block: 'nearest',
      })
    })
  }, [highlightedIndex, open, projects.length])

  if (!open || projects.length === 0) {
    return null
  }

  const safeIndex = clampSelectionIndex(highlightedIndex, projects.length)

  const handleEscapeKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing || event.key !== 'Escape') {
      return
    }

    event.preventDefault()
    onClose()
  }

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing) {
      return
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault()
      onHighlightChange(moveSelectionIndex(highlightedIndex, 'previous', projects.length))
      return
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault()
      onHighlightChange(moveSelectionIndex(highlightedIndex, 'next', projects.length))
      return
    }

    if (event.key !== 'Enter' || event.currentTarget !== event.target) {
      return
    }

    const nextProject = safeIndex === -1 ? null : projects[safeIndex]
    if (!nextProject) {
      return
    }

    event.preventDefault()
    onProjectChange(nextProject.id)
  }

  return (
    <div
      data-project-switcher="true"
      role="dialog"
      aria-modal="true"
      aria-label="프로젝트 전환"
      className="fixed inset-0 z-50 bg-black/70 p-4 backdrop-blur-sm sm:p-6"
      onClick={onClose}
    >
      <div
        className="mx-auto flex h-full max-h-[480px] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-zinc-700 bg-zinc-950 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={handleEscapeKeyDown}
      >
        <div className="flex items-start justify-between gap-4 border-b border-zinc-800 px-5 py-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <p className="text-sm font-medium text-zinc-100">Project Switcher</p>
              <span className="rounded-full border border-zinc-700 bg-zinc-900 px-2 py-0.5 text-[11px] font-medium text-zinc-300">
                Alt+P
              </span>
            </div>
            <p className="mt-1 text-xs text-zinc-500">화살표로 이동하고 Enter로 프로젝트를 바꿉니다.</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-200 transition hover:border-zinc-500 hover:bg-zinc-900"
          >
            닫기
          </button>
        </div>

        <div className="flex-1 overflow-hidden px-3 py-3">
          <div
            ref={listRef}
            role="listbox"
            tabIndex={0}
            aria-label="프로젝트 목록"
            aria-activedescendant={safeIndex === -1 ? undefined : `project-switcher-option-${projects[safeIndex]?.id}`}
            onKeyDown={handleKeyDown}
            className="h-full overflow-y-auto rounded-xl border border-zinc-800 bg-zinc-900/40 p-2 outline-none focus:border-zinc-600"
          >
            <div className="space-y-1">
              {projects.map((project, index) => {
                const isCurrentProject = project.id === projectId
                const isHighlighted = safeIndex === index

                return (
                  <button
                    key={project.id}
                    id={`project-switcher-option-${project.id}`}
                    ref={(node) => {
                      optionRefs.current[index] = node
                    }}
                    type="button"
                    role="option"
                    tabIndex={-1}
                    aria-selected={isHighlighted}
                    onMouseEnter={() => {
                      onHighlightChange(index)
                    }}
                    onClick={() => {
                      onProjectChange(project.id)
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.stopPropagation()
                      }
                    }}
                    className={`flex w-full items-center justify-between gap-3 rounded-xl border px-3 py-3 text-left transition-colors ${
                      isHighlighted
                        ? 'border-sky-700/80 bg-sky-950/30 text-white'
                        : isCurrentProject
                          ? 'border-zinc-700 bg-zinc-900 text-zinc-100'
                          : 'border-transparent text-zinc-300 hover:border-zinc-800 hover:bg-zinc-800/70 hover:text-zinc-100'
                    }`}
                  >
                    <div className="min-w-0">
                      <div className="truncate font-medium">{project.label}</div>
                      <div className="mt-1 truncate text-xs text-zinc-500">{project.id}</div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {isCurrentProject ? (
                        <span className="rounded-full border border-emerald-900/70 bg-emerald-950/30 px-2 py-0.5 text-[11px] font-medium text-emerald-200">
                          현재
                        </span>
                      ) : null}
                    </div>
                  </button>
                )
              })}
            </div>
          </div>
        </div>

        <div className="border-t border-zinc-800 px-5 py-3 text-xs text-zinc-500">
          ↑ ↓ 이동 · Enter 선택 · Esc 닫기
        </div>
      </div>
    </div>
  )
}
