import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { applyRuntimeSettings } from './runtime-settings.js'
import type { AccessPermission } from './access-policy.js'

export type StepKind = 'agent' | 'verification' | 'terminal'
export type StepRunMode = 'manual' | 'automatic' | 'display'
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'
export type ApprovalPolicy = 'never' | 'on-request' | 'on-failure' | 'untrusted'
export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'

export interface AgentConfig {
  role: string
  displayName: string
}

export interface StepConfig {
  id: string
  name: string
  kind: StepKind
  runMode: StepRunMode
  promptFile?: string
  requiresApproval: boolean
  maxAttempts?: number
  sandboxMode?: SandboxMode
  approvalPolicy?: ApprovalPolicy
  networkAccessEnabled?: boolean
  model?: string
  reasoningEffort?: ReasoningEffort
  agent?: AgentConfig
}

export interface VerificationCommandConfig {
  id: string
  label: string
  command: string
  timeoutMs?: number
  required?: boolean
}

export interface ProjectConfig {
  id: string
  label: string
  path: string
  verificationCommands: VerificationCommandConfig[]
}

export interface ExplainFlowConfig {
  promptFile: string
  model: string
  sandboxMode?: SandboxMode
  reasoningEffort?: ReasoningEffort
  serviceTier?: 'fast' | 'flex'
}

export interface RequestScreeningConfig {
  promptFile: string
  model: string
  serviceTier?: 'fast' | 'flex'
}

export interface TicketCategoryConfig {
  id: string
  label: string
  description: string
  steps: string[]
}

export interface TicketCoordinatorConfig {
  enabled?: boolean
  promptFile: string
  model: string
  sandboxMode?: SandboxMode
  approvalPolicy?: ApprovalPolicy
  networkAccessEnabled?: boolean
  reasoningEffort?: ReasoningEffort
  serviceTier?: 'fast' | 'flex'
  agent?: AgentConfig
}

export interface FlowsConfig {
  defaultProjectId: string
  projects: ProjectConfig[]
  flows: {
    explain: ExplainFlowConfig
    requests: {
      screening: RequestScreeningConfig
    }
    ticket: {
      categories: TicketCategoryConfig[]
      steps: StepConfig[]
      coordinator?: TicketCoordinatorConfig
    }
  }
}

export interface PublicProjectConfig {
  id: string
  label: string
  deletable: boolean
}

export interface PublicExplainConfig {
  availableModels: Array<{
    id: string
    label: string
    supportedReasoningEfforts: ReasoningEffort[]
    defaultReasoningEffort: ReasoningEffort
  }>
  selectedModel: string
  selectedReasoningEffort: ReasoningEffort
}

export interface PublicChatConfig {
  initialScrollTarget: 'bottom' | 'last_user_message'
}

export interface PublicRequestScreeningConfig {
  availableModels: Array<{
    id: string
    label: string
  }>
  selectedModel: string
}

export interface PublicAppConfig {
  defaultProjectId: string
  allowedProjects: PublicProjectConfig[]
  auth: {
    session: {
      kind: 'open' | 'shared_admin' | 'access_token' | 'account_session'
      label: string
      isAdmin: boolean
      permissions: AccessPermission[]
      mustChangePassword: boolean
      accountId?: string
      accountName?: string
      tokenId?: string
      tokenLabel?: string
      expiresAt?: string | null
    }
  }
  chat: PublicChatConfig
  explain: PublicExplainConfig
  direct: PublicExplainConfig
  requests: {
    screening: PublicRequestScreeningConfig
  }
  flows: {
    ticket: {
      categories: Array<{
        id: string
        label: string
        description: string
        steps: Array<Pick<StepConfig, 'id' | 'name' | 'requiresApproval' | 'runMode'> & { agent?: AgentConfig }>
      }>
      coordinator?: {
        enabled: boolean
        agent?: AgentConfig
      }
    }
  }
}

function validateAgentConfig(agent: AgentConfig | undefined, context: string) {
  if (!agent) {
    return
  }

  if (!agent.role?.trim()) {
    throw new Error(`${context}.agent.role is required when agent metadata is present`)
  }

  if (!agent.displayName?.trim()) {
    throw new Error(`${context}.agent.displayName is required when agent metadata is present`)
  }
}

let cachedConfig: FlowsConfig | null = null

function validateConfig(config: FlowsConfig): FlowsConfig {
  if (config.projects.length === 0) {
    throw new Error('flows.config.json must define at least one project')
  }

  const defaultProject = config.projects.find((project) => project.id === config.defaultProjectId)
  if (!defaultProject) {
    throw new Error(`defaultProjectId "${config.defaultProjectId}" is not present in projects`)
  }

  for (const project of config.projects) {
    if (!project.verificationCommands?.length) {
      throw new Error(`Project "${project.id}" must define at least one verification command`)
    }
  }

  if (!config.flows.explain.promptFile?.trim()) {
    throw new Error('flows.explain.promptFile is required')
  }

  if (!config.flows.explain.model?.trim()) {
    throw new Error('flows.explain.model is required')
  }

  if (!config.flows.requests?.screening.promptFile?.trim()) {
    throw new Error('flows.requests.screening.promptFile is required')
  }

  if (!config.flows.requests.screening.model?.trim()) {
    throw new Error('flows.requests.screening.model is required')
  }

  const stepIds = new Set(config.flows.ticket.steps.map((step) => step.id))
  const requiredSteps = ['analyze', 'plan', 'implement', 'review', 'ready']

  for (const step of config.flows.ticket.steps) {
    if (step.maxAttempts != null && (!Number.isInteger(step.maxAttempts) || step.maxAttempts < 1)) {
      throw new Error(`Step "${step.id}" must define maxAttempts as a positive integer`)
    }

    validateAgentConfig(step.agent, `flows.ticket.steps[${step.id}]`)
  }

  for (const stepId of requiredSteps) {
    if (!config.flows.ticket.steps.some((step) => step.id === stepId)) {
      throw new Error(`flows.ticket.steps must include "${stepId}"`)
    }
  }

  if (config.flows.ticket.categories.length === 0) {
    throw new Error('flows.ticket.categories must define at least one category')
  }

  if (config.flows.ticket.coordinator?.enabled) {
    if (!config.flows.ticket.coordinator.promptFile?.trim()) {
      throw new Error('flows.ticket.coordinator.promptFile is required when coordinator is enabled')
    }

    if (!config.flows.ticket.coordinator.model?.trim()) {
      throw new Error('flows.ticket.coordinator.model is required when coordinator is enabled')
    }
  }

  validateAgentConfig(config.flows.ticket.coordinator?.agent, 'flows.ticket.coordinator')

  for (const category of config.flows.ticket.categories) {
    if (category.steps.length === 0) {
      throw new Error(`Ticket category "${category.id}" must define at least one step`)
    }

    for (const stepId of category.steps) {
      if (!stepIds.has(stepId)) {
        throw new Error(`Ticket category "${category.id}" references unknown step "${stepId}"`)
      }
    }

    for (const stepId of requiredSteps) {
      if (!category.steps.includes(stepId)) {
        throw new Error(`Ticket category "${category.id}" must include "${stepId}"`)
      }
    }
  }

  return config
}

export function loadConfig(): FlowsConfig {
  if (cachedConfig) return cachedConfig

  const configPath = resolve(process.cwd(), 'flows.config.json')
  const raw = readFileSync(configPath, 'utf-8')
  const baseConfig = validateConfig(JSON.parse(raw) as FlowsConfig)
  cachedConfig = validateConfig(applyRuntimeSettings(baseConfig))
  return cachedConfig
}

export function reloadConfig(): FlowsConfig {
  cachedConfig = null
  return loadConfig()
}
