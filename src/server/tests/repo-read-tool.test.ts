import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildRepoReadMcpConfig,
  listRepositoryFiles,
  readRepositoryFile,
  resolveRepositoryRoot,
  searchRepository,
} from '../services/repo-read-tool.js'

async function withTempRepo(fn: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'intentlane-codex-repo-read-'))

  try {
    await mkdir(join(root, 'src', 'server'), { recursive: true })
    await mkdir(join(root, 'docs'), { recursive: true })
    await writeFile(
      join(root, 'src', 'server', 'terms.ts'),
      ['export const TERMS = true', 'export function hasPendingTerms() {', '  return TERMS', '}'].join('\n'),
      'utf8'
    )
    await writeFile(join(root, 'docs', 'terms.md'), '# Terms\n\npending terms explained\n', 'utf8')
    await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('resolveRepositoryRoot validates the repository root path', () => {
  assert.throws(() => resolveRepositoryRoot(''), /Repository root is required/)
  assert.throws(() => resolveRepositoryRoot('/definitely/missing/path'), /Repository root does not exist/)
})

test('readRepositoryFile returns numbered excerpts and blocks root escape', async () => {
  await withTempRepo(async (root) => {
    const result = await readRepositoryFile(root, 'src/server/terms.ts', 1, 2)
    assert.equal(result.path, 'src/server/terms.ts')
    assert.equal(result.startLine, 1)
    assert.equal(result.endLine, 2)
    assert.match(result.excerpt, /1 \| export const TERMS = true/)
    assert.match(result.excerpt, /2 \| export function hasPendingTerms/)

    await assert.rejects(() => readRepositoryFile(root, '../outside.txt'), /inside the repository root/)
  })
})

test('searchRepository finds text matches safely', async () => {
  await withTempRepo(async (root) => {
    const matches = await searchRepository(root, 'pending terms', { maxResults: 5 })
    assert.equal(matches.length, 1)
    assert.equal(matches[0]?.path, 'docs/terms.md')
    assert.equal(matches[0]?.line, 3)
  })
})

test('listRepositoryFiles filters with glob and limits results', async () => {
  await withTempRepo(async (root) => {
    const files = await listRepositoryFiles(root, { glob: 'src/**/*.ts', maxResults: 10 })
    assert.deepEqual(files, ['src/server/terms.ts'])
  })
})

test('buildRepoReadMcpConfig wires the project root into MCP args', async () => {
  await withTempRepo(async (root) => {
    const config = buildRepoReadMcpConfig(root)
    const repoReadServer = config.mcp_servers.repo_read
    assert.equal(repoReadServer.command, process.execPath)
    assert.ok(Array.isArray(repoReadServer.args))
    assert.ok(repoReadServer.args.includes('--root'))
    assert.ok(repoReadServer.args.includes(root))
  })
})
