import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type {
  ExplainFlowConfig,
  FlowsConfig,
  ProjectConfig,
  ReasoningEffort,
  RequestScreeningConfig,
  VerificationCommandConfig,
} from './config.js'
import { getModelCapability, resolveReasoningEffortForModel } from './model-capabilities.js'
import { inferVerificationCommandsForProject, normalizeVerificationCommandsForProject } from './project-verification.js'
import { loadAppEnvFile } from './env.js'
import { resolveRuntimeDataPath } from './runtime-data-paths.js'

const RUNTIME_SETTINGS_PATH_ENV = 'INTENTLANE_CODEX_RUNTIME_SETTINGS_PATH'

export interface RuntimeSettingsProject {
  id: string
  label: string
  path: string
  verificationCommands: VerificationCommandConfig[]
}

export interface RuntimeExplainSettings {
  model: string
  reasoningEffort: ReasoningEffort
}

export interface RuntimeRequestScreeningSettings {
  model: string
}

interface RuntimeSettingsFile {
  projects: RuntimeSettingsProject[]
  explain: RuntimeExplainSettings | null
  requests: {
    screening: RuntimeRequestScreeningSettings | null
  }
}

function defaultRuntimeSettings(): RuntimeSettingsFile {
  return {
    projects: [],
    explain: null,
    requests: {
      screening: null,
    },
  }
}

function getRuntimeSettingsPath() {
  loadAppEnvFile()
  return process.env[RUNTIME_SETTINGS_PATH_ENV]?.trim() || resolveRuntimeDataPath('runtime.settings.json')
}

function normalizeId(label: string) {
  return label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function normalizeVerificationCommands(value: unknown): VerificationCommandConfig[] | null {
  if (!Array.isArray(value)) {
    return null
  }

  const commands = value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') {
      return []
    }

    const candidate = entry as Partial<VerificationCommandConfig>
    if (!candidate.id?.trim() || !candidate.label?.trim() || !candidate.command?.trim()) {
      return []
    }

    return [
      {
        id: candidate.id.trim(),
        label: candidate.label.trim(),
        command: candidate.command.trim(),
        timeoutMs: candidate.timeoutMs,
        required: candidate.required,
      } satisfies VerificationCommandConfig,
    ]
  })

  return commands.length > 0 ? commands : null
}

function normalizeRuntimeProject(project: Partial<RuntimeSettingsProject>): RuntimeSettingsProject {
  const id = project.id?.trim()
  const label = project.label?.trim()
  const path = project.path?.trim()

  if (!id || !label || !path) {
    throw new Error('Runtime project must define id, label, and path')
  }

  return {
    id,
    label,
    path,
    verificationCommands: normalizeVerificationCommandsForProject(
      path,
      normalizeVerificationCommands(project.verificationCommands) ?? inferVerificationCommandsForProject(path)
    ),
  }
}

export function loadRuntimeSettings(): RuntimeSettingsFile {
  const path = getRuntimeSettingsPath()

  if (!existsSync(path)) {
    return defaultRuntimeSettings()
  }

  const raw = readFileSync(path, 'utf-8')
  const parsed = JSON.parse(raw) as Partial<RuntimeSettingsFile>
  return {
    projects: (parsed.projects ?? []).map((project) => normalizeRuntimeProject(project)),
    explain: parsed.explain ?? null,
    requests: {
      screening: parsed.requests?.screening ?? null,
    },
  }
}

function saveRuntimeSettings(settings: RuntimeSettingsFile) {
  const path = getRuntimeSettingsPath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(settings, null, 2), 'utf-8')
}

export function applyRuntimeSettings(config: FlowsConfig): FlowsConfig {
  const runtime = loadRuntimeSettings()
  const seenProjectIds = new Set(config.projects.map((project) => project.id))

  const runtimeProjects: ProjectConfig[] = runtime.projects
    .filter((project) => !seenProjectIds.has(project.id))
    .map((project) => ({
      id: project.id,
      label: project.label,
      path: project.path,
      verificationCommands: project.verificationCommands,
    }))

  const explain: ExplainFlowConfig = runtime.explain
    ? {
        ...config.flows.explain,
        model: getModelCapability(runtime.explain.model).id,
        reasoningEffort: resolveReasoningEffortForModel(runtime.explain.model, runtime.explain.reasoningEffort),
      }
    : config.flows.explain

  const screening: RequestScreeningConfig = runtime.requests.screening
    ? {
        ...config.flows.requests.screening,
        model: runtime.requests.screening.model.trim() || config.flows.requests.screening.model,
      }
    : config.flows.requests.screening

  return {
    ...config,
    projects: [...config.projects, ...runtimeProjects],
    flows: {
      ...config.flows,
      explain,
      requests: {
        ...config.flows.requests,
        screening,
      },
    },
  }
}

export function registerRuntimeProject(baseConfig: FlowsConfig, label: string, path: string) {
  const runtime = loadRuntimeSettings()
  const projectId = normalizeId(label)

  if (!projectId) {
    throw new Error('Project name must produce a valid id')
  }

  const allProjectIds = new Set([...baseConfig.projects.map((project) => project.id), ...runtime.projects.map((project) => project.id)])
  if (allProjectIds.has(projectId)) {
    throw new Error('Project name already exists')
  }

  const nextProject = {
    id: projectId,
    label: label.trim(),
    path: path.trim(),
    verificationCommands: inferVerificationCommandsForProject(path.trim()),
  }

  runtime.projects.push(nextProject)
  saveRuntimeSettings(runtime)
  return nextProject
}

export function deleteRuntimeProject(projectId: string) {
  const runtime = loadRuntimeSettings()
  if (!runtime.projects.some((project) => project.id === projectId)) {
    throw new Error('Runtime project not found')
  }

  const nextProjects = runtime.projects.filter((project) => project.id !== projectId)

  runtime.projects = nextProjects
  saveRuntimeSettings(runtime)
}

export function updateExplainRuntimeSettings(model: string, reasoningEffort: ReasoningEffort) {
  const runtime = loadRuntimeSettings()
  const normalizedModel = getModelCapability(model).id
  runtime.explain = {
    model: normalizedModel,
    reasoningEffort: resolveReasoningEffortForModel(normalizedModel, reasoningEffort),
  }
  saveRuntimeSettings(runtime)
  return runtime.explain
}

export function updateRequestScreeningRuntimeSettings(model: string) {
  const runtime = loadRuntimeSettings()
  const normalizedModel = model.trim()

  if (!normalizedModel) {
    throw new Error('Request screening model is required')
  }

  runtime.requests.screening = {
    model: normalizedModel,
  }
  saveRuntimeSettings(runtime)
  return runtime.requests.screening
}
