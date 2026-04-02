import { homedir } from 'node:os'
import { readdir } from 'node:fs/promises'
import { basename, dirname, isAbsolute, normalize, resolve } from 'node:path'

export interface ProjectBrowserEntry {
  name: string
  path: string
}

export interface ProjectBrowserResult {
  currentPath: string
  parentPath: string | null
  entries: ProjectBrowserEntry[]
}

function normalizeBrowsePath(inputPath?: string) {
  if (!inputPath?.trim()) {
    return homedir()
  }

  const trimmed = inputPath.trim()
  if (trimmed === '~') {
    return homedir()
  }

  if (trimmed.startsWith('~/')) {
    return resolve(homedir(), trimmed.slice(2))
  }

  if (isAbsolute(trimmed)) {
    return normalize(trimmed)
  }

  return resolve(homedir(), trimmed)
}

export async function browseProjectDirectories(inputPath?: string): Promise<ProjectBrowserResult> {
  const currentPath = normalizeBrowsePath(inputPath)
  const dirents = await readdir(currentPath, { withFileTypes: true })

  const entries = dirents
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      path: resolve(currentPath, entry.name),
    }))
    .sort((a, b) => a.name.localeCompare(b.name))

  const parent = dirname(currentPath)

  return {
    currentPath,
    parentPath: parent !== currentPath ? parent : null,
    entries,
  }
}

export function inferProjectAliasFromPath(projectPath: string) {
  return basename(normalizeBrowsePath(projectPath))
}
