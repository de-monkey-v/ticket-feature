import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  listProjectAncestorsWithinRepository,
  resolveProjectExecutionCwd,
  resolveProjectRelativePath,
  resolveProjectRepositoryRoot,
  resolveProjectWorktreeRoot,
} from '../lib/project-paths.js'

test('project path helpers preserve nested project execution paths inside worktrees', () => {
  const root = mkdtempSync(join(tmpdir(), 'project-paths-'))
  const repoPath = join(root, 'repo')
  const nestedProjectPath = join(repoPath, 'services', 'backend')
  const worktreePath = join(root, '.intentlane-codex-worktrees', 'ticket-1')

  try {
    mkdirSync(join(repoPath, '.git'), { recursive: true })
    mkdirSync(nestedProjectPath, { recursive: true })

    assert.equal(resolveProjectRepositoryRoot(nestedProjectPath), repoPath)
    assert.equal(resolveProjectRelativePath(nestedProjectPath), join('services', 'backend'))
    assert.equal(resolveProjectExecutionCwd(nestedProjectPath, worktreePath), join(worktreePath, 'services', 'backend'))
    assert.equal(resolveProjectWorktreeRoot(nestedProjectPath), join(root, '.intentlane-codex-worktrees'))
    assert.deepEqual(listProjectAncestorsWithinRepository(nestedProjectPath), [
      repoPath,
      join(repoPath, 'services'),
      nestedProjectPath,
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
