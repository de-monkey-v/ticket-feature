import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { browseProjectDirectories, inferProjectAliasFromPath } from '../lib/project-browser.js'

test('inferProjectAliasFromPath uses the selected folder basename', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'intentlane-codex-project-browser-'))

  try {
    assert.equal(inferProjectAliasFromPath('~/dev/Onecad-Backend-refactor/msa-service'), 'msa-service')
    assert.equal(inferProjectAliasFromPath(join(tempRoot, 'nested', 'sample-project')), 'sample-project')
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('browseProjectDirectories returns a navigable directory result', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'intentlane-codex-project-browser-'))
  const srcDir = join(tempRoot, 'src')

  mkdirSync(join(srcDir, 'server'), { recursive: true })
  mkdirSync(join(srcDir, 'web'), { recursive: true })

  try {
    const result = await browseProjectDirectories(srcDir)

    assert.equal(result.currentPath, srcDir)
    assert.equal(result.parentPath, tempRoot)
    assert.ok(result.entries.some((entry) => entry.name === 'server'))
    assert.ok(result.entries.some((entry) => entry.name === 'web'))
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
})
