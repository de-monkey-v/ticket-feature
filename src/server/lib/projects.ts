import type { FlowsConfig, ProjectConfig, PublicAppConfig } from './config.js'
import {
  getModelCapability,
  listModelCapabilities,
  listScreeningModelOptions,
  resolveReasoningEffortForModel,
} from './model-capabilities.js'
import { loadRuntimeSettings } from './runtime-settings.js'
import { hasProjectAccess, type AuthSession } from './access-policy.js'

export function getDefaultProject(config: FlowsConfig): ProjectConfig {
  const project = config.projects.find((entry) => entry.id === config.defaultProjectId)
  if (!project) {
    throw new Error(`Unknown default project "${config.defaultProjectId}"`)
  }
  return project
}

export function getProjectById(
  config: FlowsConfig,
  projectId: string | undefined | null
): ProjectConfig | null {
  if (!projectId) return null
  return config.projects.find((entry) => entry.id === projectId) ?? null
}

export function requireProjectById(config: FlowsConfig, projectId: string | undefined | null): ProjectConfig {
  const project = getProjectById(config, projectId)
  if (!project) {
    throw new Error('Unknown project')
  }
  return project
}

export function requireAccessibleProjectById(
  config: FlowsConfig,
  session: AuthSession,
  projectId: string | undefined | null
): ProjectConfig {
  const project = requireProjectById(config, projectId)
  if (!hasProjectAccess(session, project.id)) {
    throw new Error('Project access denied')
  }
  return project
}

export function toPublicConfig(config: FlowsConfig, session: AuthSession): PublicAppConfig {
  const runtimeProjectIds = new Set(loadRuntimeSettings().projects.map((project) => project.id))
  const selectedModel = config.flows.explain.model
  const selectedReasoningEffort = resolveReasoningEffortForModel(
    selectedModel,
    config.flows.explain.reasoningEffort ?? 'medium'
  )
  const allowedProjects = config.projects
    .filter((project) => hasProjectAccess(session, project.id))
    .map(({ id, label }) => ({
      id,
      label,
      deletable: session.isAdmin && runtimeProjectIds.has(id),
    }))
  const defaultProjectId =
    allowedProjects.find((project) => project.id === config.defaultProjectId)?.id ??
    allowedProjects[0]?.id ??
    ''

  return {
    defaultProjectId,
    allowedProjects,
    auth: {
      session: {
        kind: session.kind,
        label: session.label,
        isAdmin: session.isAdmin,
        permissions: session.permissions,
        mustChangePassword: session.mustChangePassword,
        accountId: session.accountId,
        accountName: session.accountName,
        tokenId: session.tokenId,
        tokenLabel: session.tokenLabel,
        expiresAt: session.expiresAt ?? null,
      },
    },
    explain: {
      availableModels: listModelCapabilities(selectedModel).map((capability) => ({
        id: capability.id,
        label: capability.label,
        supportedReasoningEfforts: capability.supportedReasoningEfforts,
        defaultReasoningEffort: capability.defaultReasoningEffort,
      })),
      selectedModel: getModelCapability(selectedModel).id,
      selectedReasoningEffort,
    },
    requests: {
      screening: {
        availableModels: listScreeningModelOptions().map((entry) => ({
          id: entry.id,
          label: entry.label,
        })),
        selectedModel: config.flows.requests.screening.model.trim(),
      },
    },
    flows: {
      ticket: {
        categories: config.flows.ticket.categories.map((category) => ({
          id: category.id,
          label: category.label,
          description: category.description,
          steps: category.steps
            .map((stepId) => config.flows.ticket.steps.find((step) => step.id === stepId))
            .filter((step): step is NonNullable<typeof step> => Boolean(step))
            .map(({ id, name, requiresApproval, runMode, agent }) => ({
              id,
              name,
              requiresApproval,
              runMode,
              agent,
            })),
        })),
        coordinator: config.flows.ticket.coordinator
          ? {
              enabled: Boolean(config.flows.ticket.coordinator.enabled),
              agent: config.flows.ticket.coordinator.agent,
            }
          : undefined,
      },
    },
  }
}
