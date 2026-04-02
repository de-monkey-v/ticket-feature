import { existsSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'

function hasGitMetadata(path: string) {
  return existsSync(resolve(path, '.git'))
}

export function resolveProjectRepositoryRoot(projectPath: string) {
  const normalizedProjectPath = resolve(projectPath)
  let currentPath = normalizedProjectPath

  while (true) {
    if (hasGitMetadata(currentPath)) {
      return currentPath
    }

    const parentPath = dirname(currentPath)
    if (parentPath === currentPath) {
      return normalizedProjectPath
    }

    currentPath = parentPath
  }
}

export function resolveProjectRelativePath(projectPath: string) {
  const normalizedProjectPath = resolve(projectPath)
  const repositoryRoot = resolveProjectRepositoryRoot(normalizedProjectPath)
  const relativePath = relative(repositoryRoot, normalizedProjectPath)

  return relativePath || '.'
}

export function resolveProjectExecutionCwd(projectPath: string, worktreePath?: string) {
  const normalizedProjectPath = resolve(projectPath)
  if (!worktreePath) {
    return normalizedProjectPath
  }

  const relativePath = resolveProjectRelativePath(normalizedProjectPath)
  return relativePath === '.' ? resolve(worktreePath) : resolve(worktreePath, relativePath)
}

export function resolveProjectWorktreeRoot(projectPath: string) {
  return resolve(resolveProjectRepositoryRoot(projectPath), '..', '.intentlane-codex-worktrees')
}

export function listProjectAncestorsWithinRepository(projectPath: string) {
  const normalizedProjectPath = resolve(projectPath)
  const repositoryRoot = resolveProjectRepositoryRoot(normalizedProjectPath)
  const ancestors: string[] = []
  let currentPath = normalizedProjectPath

  while (true) {
    ancestors.unshift(currentPath)
    if (currentPath === repositoryRoot) {
      return ancestors
    }

    const parentPath = dirname(currentPath)
    if (parentPath === currentPath) {
      return ancestors
    }

    currentPath = parentPath
  }
}
