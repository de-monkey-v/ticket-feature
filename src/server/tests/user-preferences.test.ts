import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { AuthSession } from '../lib/access-policy.js'
import type { FlowsConfig } from '../lib/config.js'
import { RUNTIME_DATA_DIR_ENV, resolveRuntimeDataPath } from '../lib/runtime-data-paths.js'
import { toPublicConfig } from '../lib/projects.js'
import {
  loadUserPreferences,
  resolveUserPreferenceOwnerId,
  updateUserChatPreferences,
  updateUserDirectPreferences,
  updateUserExplainPreferences,
} from '../lib/user-preferences.js'

function createConfig(): FlowsConfig {
  return {
    defaultProjectId: 'backend',
    projects: [
      {
        id: 'frontend',
        label: 'Frontend',
        path: '/srv/frontend',
        verificationCommands: [
          {
            id: 'typecheck',
            label: 'Typecheck',
            command: 'pnpm typecheck',
          },
        ],
      },
      {
        id: 'backend',
        label: 'Backend',
        path: '/srv/backend',
        verificationCommands: [
          {
            id: 'test',
            label: 'Test',
            command: 'pnpm test',
          },
        ],
      },
    ],
    flows: {
      explain: {
        promptFile: 'prompts/explain.txt',
        model: 'gpt-5.4',
        reasoningEffort: 'medium',
      },
      requests: {
        screening: {
          promptFile: 'prompts/request-screening.txt',
          model: 'gpt-5.3-codex-spark',
        },
      },
      ticket: {
        categories: [
          {
            id: 'feature',
            label: 'Feature',
            description: 'feature flow',
            steps: ['analyze', 'plan', 'implement', 'review', 'ready'],
          },
        ],
        steps: [
          {
            id: 'analyze',
            name: 'Analyze',
            kind: 'agent',
            runMode: 'manual',
            requiresApproval: false,
          },
          {
            id: 'plan',
            name: 'Plan',
            kind: 'agent',
            runMode: 'manual',
            requiresApproval: false,
          },
          {
            id: 'implement',
            name: 'Implement',
            kind: 'agent',
            runMode: 'manual',
            requiresApproval: false,
          },
          {
            id: 'review',
            name: 'Review',
            kind: 'agent',
            runMode: 'automatic',
            requiresApproval: false,
          },
          { id: 'ready', name: 'Ready', kind: 'terminal', runMode: 'display', requiresApproval: false },
        ],
      },
    },
  }
}

function createSession(accountId: string): AuthSession {
  return {
    kind: 'account_session',
    label: accountId,
    isAdmin: false,
    permissions: ['explain', 'direct'],
    projectIds: ['backend', 'frontend'],
    mustChangePassword: false,
    accountId,
    accountName: accountId,
    tokenId: `session-${accountId}`,
  }
}

test('user preferences persist separately by account owner', () => {
  const previousDataDir = process.env[RUNTIME_DATA_DIR_ENV]
  const tempDir = mkdtempSync(join(tmpdir(), 'intentlane-codex-user-preferences-test-'))
  process.env[RUNTIME_DATA_DIR_ENV] = tempDir

  try {
    const alice = createSession('acct-alice')
    const bob = createSession('acct-bob')

    updateUserChatPreferences(alice, 'last_user_message')
    updateUserExplainPreferences(alice, 'gpt-5.4-mini', 'high', false)
    updateUserDirectPreferences(alice, 'gpt-5.3-codex', 'low')

    const alicePreferences = loadUserPreferences(alice)
    const bobPreferences = loadUserPreferences(bob)

    assert.equal(alicePreferences.chat?.initialScrollTarget, 'last_user_message')
    assert.equal(alicePreferences.explain?.model, 'gpt-5.4-mini')
    assert.equal(alicePreferences.explain?.reasoningEffort, 'high')
    assert.equal(alicePreferences.explain?.interceptImplementationRequests, false)
    assert.equal(alicePreferences.direct?.model, 'gpt-5.3-codex')
    assert.equal(alicePreferences.direct?.reasoningEffort, 'low')
    assert.equal(bobPreferences.chat, null)
    assert.equal(bobPreferences.explain, null)
    assert.equal(bobPreferences.direct, null)

    const alicePreferencesPath = resolveRuntimeDataPath(
      'user-preferences',
      `${encodeURIComponent(resolveUserPreferenceOwnerId(alice))}.json`
    )
    assert.equal(existsSync(alicePreferencesPath), true)
  } finally {
    if (previousDataDir === undefined) {
      delete process.env[RUNTIME_DATA_DIR_ENV]
    } else {
      process.env[RUNTIME_DATA_DIR_ENV] = previousDataDir
    }

    rmSync(tempDir, { recursive: true, force: true })
  }
})

test('toPublicConfig merges personal explain, direct, and chat preferences without touching screening config', () => {
  const previousDataDir = process.env[RUNTIME_DATA_DIR_ENV]
  const tempDir = mkdtempSync(join(tmpdir(), 'intentlane-codex-user-public-config-test-'))
  process.env[RUNTIME_DATA_DIR_ENV] = tempDir

  try {
    const alice = createSession('acct-alice')
    const bob = createSession('acct-bob')
    const config = createConfig()

    updateUserChatPreferences(alice, 'last_user_message')
    updateUserExplainPreferences(alice, 'gpt-5.4-mini', 'high', false)
    updateUserDirectPreferences(alice, 'gpt-5.3-codex', 'low')

    const aliceConfig = toPublicConfig(config, alice)
    const bobConfig = toPublicConfig(config, bob)

    assert.equal(aliceConfig.chat.initialScrollTarget, 'last_user_message')
    assert.equal(aliceConfig.explain.selectedModel, 'gpt-5.4-mini')
    assert.equal(aliceConfig.explain.selectedReasoningEffort, 'high')
    assert.equal(aliceConfig.explain.interceptImplementationRequests, false)
    assert.equal(aliceConfig.direct.selectedModel, 'gpt-5.3-codex')
    assert.equal(aliceConfig.direct.selectedReasoningEffort, 'low')
    assert.equal(aliceConfig.requests.screening.selectedModel, 'gpt-5.3-codex-spark')

    assert.equal(bobConfig.chat.initialScrollTarget, 'bottom')
    assert.equal(bobConfig.explain.selectedModel, 'gpt-5.4')
    assert.equal(bobConfig.explain.selectedReasoningEffort, 'medium')
    assert.equal(bobConfig.explain.interceptImplementationRequests, true)
    assert.equal(bobConfig.direct.selectedModel, 'gpt-5.4')
    assert.equal(bobConfig.direct.selectedReasoningEffort, 'medium')
  } finally {
    if (previousDataDir === undefined) {
      delete process.env[RUNTIME_DATA_DIR_ENV]
    } else {
      process.env[RUNTIME_DATA_DIR_ENV] = previousDataDir
    }

    rmSync(tempDir, { recursive: true, force: true })
  }
})
