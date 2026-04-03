import type { AppConfig } from './api'

const ALT_NUMBER_SHORTCUT_INDEX: Record<string, number> = {
  Digit1: 0,
  Digit2: 1,
  Digit3: 2,
  Digit4: 3,
  Digit5: 4,
  Numpad1: 0,
  Numpad2: 1,
  Numpad3: 2,
  Numpad4: 3,
  Numpad5: 4,
}

export function getAltNumberSelectionIndex(code: string) {
  return ALT_NUMBER_SHORTCUT_INDEX[code] ?? null
}

export function isShortcutsHelpKey(params: {
  key: string
  code: string
  shiftKey: boolean
}) {
  return params.key === '?' || (params.code === 'Slash' && params.shiftKey)
}

export function clampSelectionIndex(index: number, itemCount: number) {
  if (itemCount <= 0) {
    return -1
  }

  if (!Number.isFinite(index)) {
    return 0
  }

  return Math.min(Math.max(Math.trunc(index), 0), itemCount - 1)
}

export function moveSelectionIndex(index: number, direction: 'previous' | 'next', itemCount: number) {
  const currentIndex = clampSelectionIndex(index, itemCount)
  if (currentIndex === -1) {
    return -1
  }

  if (direction === 'previous') {
    return Math.max(0, currentIndex - 1)
  }

  return Math.min(itemCount - 1, currentIndex + 1)
}

export function orderProjectsForSelection<T extends AppConfig['allowedProjects'][number]>(
  projects: readonly T[],
  projectId: string
) {
  const selectedProject = projects.find((project) => project.id === projectId)
  if (!selectedProject) {
    return [...projects]
  }

  return [selectedProject, ...projects.filter((project) => project.id !== selectedProject.id)]
}
