import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Hono } from 'hono'
import { createOpenAuthSession } from '../lib/access-policy.js'
import { RUNTIME_DATA_DIR_ENV, resolveRuntimeDataPath } from '../lib/runtime-data-paths.js'
import { configRoutes } from '../routes/config.js'
import { reloadConfig } from '../lib/config.js'
import { updateRequestScreeningRuntimeSettings } from '../lib/runtime-settings.js'
import { requireProjectById } from '../lib/projects.js'
import { resolveUserPreferenceOwnerId } from '../lib/user-preferences.js'

const RUNTIME_SETTINGS_PATH_ENV = 'INTENTLANE_CODEX_RUNTIME_SETTINGS_PATH'

function createGradleProjectFixture(prefix: string) {
  const projectPath = mkdtempSync(join(tmpdir(), prefix))
  writeFileSync(join(projectPath, 'settings.gradle'), "rootProject.name = 'fixture'\n", 'utf-8')
  writeFileSync(join(projectPath, 'build.gradle'), 'plugins {}\n', 'utf-8')
  writeFileSync(join(projectPath, 'gradlew'), '#!/bin/sh\nexit 0\n', 'utf-8')
  return projectPath
}

test('default ticket flow config is fully automatic without an explicit approve step', () => {
  const config = reloadConfig()
  const stepConfigById = new Map(config.flows.ticket.steps.map((step) => [step.id, step]))

  assert.equal(stepConfigById.get('analyze')?.runMode, 'automatic')
  assert.equal(stepConfigById.get('plan')?.runMode, 'automatic')
  assert.equal(stepConfigById.get('implement')?.runMode, 'automatic')
  assert.equal(stepConfigById.get('plan')?.requiresApproval, false)
  assert.equal(stepConfigById.has('approve'), false)
  assert.equal(stepConfigById.get('analyze')?.agent?.displayName, 'Prometheus')
  assert.equal(stepConfigById.get('implement')?.agent?.displayName, 'Hephaestus')
  assert.equal(config.flows.ticket.coordinator?.agent?.displayName, 'Sisyphus')
})

test('request screening config route persists curated and custom model ids', async () => {
  const previousRuntimeSettingsPath = process.env[RUNTIME_SETTINGS_PATH_ENV]
  const tempDir = mkdtempSync(join(tmpdir(), 'intentlane-codex-config-test-'))
  const runtimeSettingsPath = join(tempDir, 'runtime.settings.json')
  process.env[RUNTIME_SETTINGS_PATH_ENV] = runtimeSettingsPath
  reloadConfig()

  try {
    const app = new Hono()
    app.route('/api', configRoutes)

    const curatedResponse = await app.request('http://localhost/api/config/requests/screening', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.4-mini' }),
    })

    assert.equal(curatedResponse.status, 200)
    const curatedPayload = await curatedResponse.json()
    assert.equal(curatedPayload.requests.screening.selectedModel, 'gpt-5.4-mini')

    const customResponse = await app.request('http://localhost/api/config/requests/screening', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'custom-screening-model' }),
    })

    assert.equal(customResponse.status, 200)
    const customPayload = await customResponse.json()
    assert.equal(customPayload.requests.screening.selectedModel, 'custom-screening-model')
    assert.equal(existsSync(runtimeSettingsPath), true)

    const persisted = JSON.parse(readFileSync(runtimeSettingsPath, 'utf-8'))
    assert.equal(persisted.requests.screening.model, 'custom-screening-model')
  } finally {
    if (previousRuntimeSettingsPath === undefined) {
      delete process.env[RUNTIME_SETTINGS_PATH_ENV]
    } else {
      process.env[RUNTIME_SETTINGS_PATH_ENV] = previousRuntimeSettingsPath
    }
    reloadConfig()
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test('runtime settings defaults can be isolated under INTENTLANE_CODEX_DATA_DIR', () => {
  const previousDataDir = process.env[RUNTIME_DATA_DIR_ENV]
  const previousRuntimeSettingsPath = process.env[RUNTIME_SETTINGS_PATH_ENV]
  const tempDir = mkdtempSync(join(tmpdir(), 'intentlane-codex-runtime-data-settings-test-'))
  process.env[RUNTIME_DATA_DIR_ENV] = tempDir
  delete process.env[RUNTIME_SETTINGS_PATH_ENV]

  try {
    updateRequestScreeningRuntimeSettings('gpt-5.4-mini')

    const runtimeSettingsPath = resolveRuntimeDataPath('runtime.settings.json')
    assert.equal(existsSync(runtimeSettingsPath), true)

    const persisted = JSON.parse(readFileSync(runtimeSettingsPath, 'utf-8'))
    assert.equal(persisted.requests.screening.model, 'gpt-5.4-mini')
  } finally {
    if (previousDataDir === undefined) {
      delete process.env[RUNTIME_DATA_DIR_ENV]
    } else {
      process.env[RUNTIME_DATA_DIR_ENV] = previousDataDir
    }

    if (previousRuntimeSettingsPath === undefined) {
      delete process.env[RUNTIME_SETTINGS_PATH_ENV]
    } else {
      process.env[RUNTIME_SETTINGS_PATH_ENV] = previousRuntimeSettingsPath
    }

    rmSync(tempDir, { recursive: true, force: true })
  }
})

test('preference routes persist open-session explain, direct, and chat selections under runtime data', async () => {
  const previousDataDir = process.env[RUNTIME_DATA_DIR_ENV]
  const tempDir = mkdtempSync(join(tmpdir(), 'intentlane-codex-config-preferences-test-'))
  process.env[RUNTIME_DATA_DIR_ENV] = tempDir
  const projectId = reloadConfig().defaultProjectId

  try {
    const app = new Hono()
    app.route('/api', configRoutes)

    const explainResponse = await app.request('http://localhost/api/config/preferences/explain', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId,
        model: 'gpt-5.4-mini',
        reasoningEffort: 'high',
        interceptImplementationRequests: false,
      }),
    })

    assert.equal(explainResponse.status, 200)
    const explainPayload = await explainResponse.json()
    assert.equal(explainPayload.explain.selectedModel, 'gpt-5.4-mini')
    assert.equal(explainPayload.explain.selectedReasoningEffort, 'high')
    assert.equal(explainPayload.explain.interceptImplementationRequests, false)

    const explainCompatibilityResponse = await app.request('http://localhost/api/config/preferences/explain', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId,
        model: 'gpt-5.4-mini',
        reasoningEffort: 'medium',
      }),
    })

    assert.equal(explainCompatibilityResponse.status, 200)
    const explainCompatibilityPayload = await explainCompatibilityResponse.json()
    assert.equal(explainCompatibilityPayload.explain.selectedReasoningEffort, 'medium')
    assert.equal(explainCompatibilityPayload.explain.interceptImplementationRequests, false)

    const directResponse = await app.request('http://localhost/api/config/preferences/direct', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId,
        model: 'gpt-5.3-codex',
        reasoningEffort: 'low',
      }),
    })

    assert.equal(directResponse.status, 200)
    const directPayload = await directResponse.json()
    assert.equal(directPayload.direct.selectedModel, 'gpt-5.3-codex')
    assert.equal(directPayload.direct.selectedReasoningEffort, 'low')

    const chatResponse = await app.request('http://localhost/api/config/preferences/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId,
        initialScrollTarget: 'last_user_message',
      }),
    })

    assert.equal(chatResponse.status, 200)
    const chatPayload = await chatResponse.json()
    assert.equal(chatPayload.chat.initialScrollTarget, 'last_user_message')

    const preferencesPath = resolveRuntimeDataPath(
      'user-preferences',
      `${encodeURIComponent(resolveUserPreferenceOwnerId(createOpenAuthSession()))}.json`
    )
    assert.equal(existsSync(preferencesPath), true)

    const persisted = JSON.parse(readFileSync(preferencesPath, 'utf-8'))
    assert.equal(persisted.chat.initialScrollTarget, 'last_user_message')
    assert.equal(persisted.explain.model, 'gpt-5.4-mini')
    assert.equal(persisted.explain.interceptImplementationRequests, false)
    assert.equal(persisted.direct.model, 'gpt-5.3-codex')
  } finally {
    if (previousDataDir === undefined) {
      delete process.env[RUNTIME_DATA_DIR_ENV]
    } else {
      process.env[RUNTIME_DATA_DIR_ENV] = previousDataDir
    }

    rmSync(tempDir, { recursive: true, force: true })
  }
})

test('loadConfig infers verification commands for legacy runtime Gradle projects', () => {
  const previousRuntimeSettingsPath = process.env[RUNTIME_SETTINGS_PATH_ENV]
  const tempDir = mkdtempSync(join(tmpdir(), 'intentlane-codex-runtime-config-test-'))
  const runtimeSettingsPath = join(tempDir, 'runtime.settings.json')
  const gradleProjectPath = createGradleProjectFixture('intentlane-codex-gradle-project-')
  process.env[RUNTIME_SETTINGS_PATH_ENV] = runtimeSettingsPath

  writeFileSync(
    runtimeSettingsPath,
    JSON.stringify(
      {
        projects: [
          {
            id: 'backend',
            label: 'backend',
            path: gradleProjectPath,
          },
        ],
      },
      null,
      2
    ),
    'utf-8'
  )

  try {
    const config = reloadConfig()
    const project = requireProjectById(config, 'backend')

    assert.deepEqual(
      project.verificationCommands.map((command) => command.command),
      ['sh ./gradlew test', 'sh ./gradlew build']
    )
  } finally {
    if (previousRuntimeSettingsPath === undefined) {
      delete process.env[RUNTIME_SETTINGS_PATH_ENV]
    } else {
      process.env[RUNTIME_SETTINGS_PATH_ENV] = previousRuntimeSettingsPath
    }
    reloadConfig()
    rmSync(tempDir, { recursive: true, force: true })
    rmSync(gradleProjectPath, { recursive: true, force: true })
  }
})

test('project create route persists inferred Gradle verification commands', async () => {
  const previousRuntimeSettingsPath = process.env[RUNTIME_SETTINGS_PATH_ENV]
  const tempDir = mkdtempSync(join(tmpdir(), 'intentlane-codex-project-route-test-'))
  const runtimeSettingsPath = join(tempDir, 'runtime.settings.json')
  const gradleProjectPath = createGradleProjectFixture('intentlane-codex-gradle-project-create-')
  process.env[RUNTIME_SETTINGS_PATH_ENV] = runtimeSettingsPath
  reloadConfig()

  try {
    const app = new Hono()
    app.route('/api', configRoutes)

    const response = await app.request('http://localhost/api/config/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'backend', path: gradleProjectPath }),
    })

    assert.equal(response.status, 200)
    assert.equal(existsSync(runtimeSettingsPath), true)

    const persisted = JSON.parse(readFileSync(runtimeSettingsPath, 'utf-8'))
    assert.deepEqual(
      persisted.projects[0]?.verificationCommands?.map((command: { command: string }) => command.command),
      ['sh ./gradlew test', 'sh ./gradlew build']
    )
  } finally {
    if (previousRuntimeSettingsPath === undefined) {
      delete process.env[RUNTIME_SETTINGS_PATH_ENV]
    } else {
      process.env[RUNTIME_SETTINGS_PATH_ENV] = previousRuntimeSettingsPath
    }
    reloadConfig()
    rmSync(tempDir, { recursive: true, force: true })
    rmSync(gradleProjectPath, { recursive: true, force: true })
  }
})
