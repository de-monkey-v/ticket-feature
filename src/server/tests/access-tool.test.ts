import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createAccessAccount,
  createAccessToken,
  createAccountSession,
  setAccessAccountPassword,
} from '../lib/access-control.js'
import {
  buildAccessControlToolContext,
  buildCreateAccessTokenToolResult,
  listToolAccessSummary,
} from '../services/access-tool.js'

const ACCESS_CONTROL_PATH_ENV = 'INTENTLANE_CODEX_ACCESS_CONTROL_PATH'

function withAccessControlEnv(fn: () => Promise<void> | void) {
  return async () => {
    const previousAccessPath = process.env[ACCESS_CONTROL_PATH_ENV]
    const tempDir = mkdtempSync(join(tmpdir(), 'intentlane-codex-access-tool-test-'))
    process.env[ACCESS_CONTROL_PATH_ENV] = join(tempDir, 'access-control.json')

    try {
      await fn()
    } finally {
      if (previousAccessPath === undefined) {
        delete process.env[ACCESS_CONTROL_PATH_ENV]
      } else {
        process.env[ACCESS_CONTROL_PATH_ENV] = previousAccessPath
      }

      rmSync(tempDir, { recursive: true, force: true })
    }
  }
}

test(
  'listToolAccessSummary excludes password metadata but keeps scoped access state',
  withAccessControlEnv(() => {
    const account = createAccessAccount({
      name: 'Alice',
      permissions: ['explain'],
      projectIds: ['intentlane-codex'],
    })
    setAccessAccountPassword(account.id, 'super-secret')
    const createdToken = createAccessToken({
      accountId: account.id,
      label: 'alice-explain',
      permissions: ['explain'],
      projectIds: ['intentlane-codex'],
    })
    createAccountSession({
      name: 'Alice',
      password: 'super-secret',
    })

    const summary = listToolAccessSummary()
    const safeAccount = summary.accounts.find((entry) => entry.id === account.id)

    assert.ok(safeAccount)
    assert.equal('hasPassword' in safeAccount, false)
    assert.equal('passwordUpdatedAt' in safeAccount, false)
    assert.equal('lastLoginAt' in safeAccount, false)
    assert.equal(safeAccount.tokens.some((token) => token.id === createdToken.record.id), true)
    assert.equal(safeAccount.sessions.length, 1)
    assert.equal(summary.tokens.some((token) => token.id === createdToken.record.id), true)
    assert.equal(summary.sessions.length, 1)
    assert.equal(summary.availableProjects.some((project) => project.id === 'intentlane-codex'), true)
  })
)

test('buildCreateAccessTokenToolResult keeps the raw token out of structured output', () => {
  const result = buildCreateAccessTokenToolResult({
    token: 'tf_123.secret',
    record: {
      id: 'tok_123',
      accountId: 'acct_123',
      accountName: 'Alice',
      label: 'alice-explain',
      isAdmin: false,
      permissions: ['explain'],
      projectIds: ['intentlane-codex'],
      expiresAt: null,
      createdAt: '2026-03-27T00:00:00.000Z',
      updatedAt: '2026-03-27T00:00:00.000Z',
      revokedAt: null,
      lastUsedAt: null,
      tokenPreview: 'tf_123...secret',
      status: 'active',
    },
  })

  assert.match(result.content[0]?.text || '', /One-time token secret: tf_123\.secret/)
  assert.deepEqual(result.structuredContent, {
    ok: true,
    tokenIssued: true,
    record: {
      id: 'tok_123',
      accountId: 'acct_123',
      accountName: 'Alice',
      label: 'alice-explain',
      isAdmin: false,
      permissions: ['explain'],
      projectIds: ['intentlane-codex'],
      expiresAt: null,
      createdAt: '2026-03-27T00:00:00.000Z',
      updatedAt: '2026-03-27T00:00:00.000Z',
      revokedAt: null,
      lastUsedAt: null,
      tokenPreview: 'tf_123...secret',
      status: 'active',
    },
  })
  assert.equal('token' in result.structuredContent, false)
})

test('buildAccessControlToolContext explicitly excludes password operations', () => {
  const prompt = buildAccessControlToolContext([
    {
      id: 'intentlane-codex',
      label: 'Intentlane',
    },
    {
      id: 'frontend',
      label: 'Frontend',
    },
  ])

  assert.match(prompt, /admin-only tools/)
  assert.match(prompt, /do NOT manage passwords/i)
  assert.match(prompt, /list_access_control/)
  assert.match(prompt, /create_access_token/)
  assert.match(prompt, /- intentlane-codex: Intentlane/)
  assert.match(prompt, /- frontend: Frontend/)
})
