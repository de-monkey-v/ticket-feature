import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ExplainFlowConfig, ReasoningEffort, TicketCategoryConfig } from '../lib/config.js'
import { getModelCapability, resolveReasoningEffortForModel } from '../lib/model-capabilities.js'
import { buildAccessControlToolContext, type ToolSafeProjectSummary } from './access-tool.js'
import {
  buildRepoReadMcpConfig,
  LIST_REPOSITORY_FILES_TOOL_NAME,
  READ_REPOSITORY_FILE_TOOL_NAME,
  SEARCH_REPOSITORY_TOOL_NAME,
} from './repo-read-tool.js'
import { runCodexTurn } from './codex-sdk.js'

export const REQUEST_DRAFT_MCP_SERVER_NAME = 'request_intake'
export const REQUEST_DRAFT_TOOL_NAME = 'create_client_request_draft'

export interface RequestDraftPayload {
  title: string
  categoryId: string
  template: RequestTemplateFields
  rationale?: string
}

export interface RequestTemplateFields {
  problem: string
  desiredOutcome: string
  userScenarios: string
  constraints?: string
  nonGoals?: string
  openQuestions?: string
}

export interface RequestDraftConversationMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface ExistingRequestDraftContext {
  title: string
  categoryId: string
  template: RequestTemplateFields
  rationale?: string
}

export interface ManualRequestDraftInput {
  requester?: string
  title?: string
  categoryId?: string
  template?: Partial<RequestTemplateFields>
}

export interface GenerateRequestDraftOptions {
  prompt: string
  projectPath: string
  categories: TicketCategoryConfig[]
  explainFlow: ExplainFlowConfig
  model?: string
  reasoningEffort?: ReasoningEffort
  signal?: AbortSignal
}

export interface ExplainPromptOptions {
  accessControl?: {
    availableProjects: ToolSafeProjectSummary[]
  }
}

let runCodexTurnForRequestDraftImpl: typeof runCodexTurn = runCodexTurn

function normalizeSingleLine(text: string | undefined) {
  return (text ?? '').replace(/\s+/g, ' ').trim()
}

function normalizeMultilineText(text: string | undefined) {
  return (text ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readString(value: unknown) {
  return typeof value === 'string' ? value : undefined
}

function normalizeRequestTemplateFields(template: RequestTemplateFields): RequestTemplateFields {
  const constraints = normalizeMultilineText(template.constraints)
  const nonGoals = normalizeMultilineText(template.nonGoals)
  const openQuestions = normalizeMultilineText(template.openQuestions)

  return {
    problem: normalizeMultilineText(template.problem) || '문제 배경이 비어 있습니다.',
    desiredOutcome: normalizeMultilineText(template.desiredOutcome) || '원하는 결과가 비어 있습니다.',
    userScenarios: normalizeMultilineText(template.userScenarios) || '대표 사용자 시나리오가 비어 있습니다.',
    constraints: constraints || undefined,
    nonGoals: nonGoals || undefined,
    openQuestions: openQuestions || undefined,
  }
}

function normalizeCategoryId(categoryId: string | undefined, categories: TicketCategoryConfig[]) {
  const normalized = normalizeSingleLine(categoryId).toLowerCase()

  if (normalized && categories.some((category) => category.id === normalized)) {
    return normalized
  }

  return categories[0]?.id ?? ''
}

export function normalizeRequestDraftPayload(payload: RequestDraftPayload): RequestDraftPayload {
  const rationale = normalizeMultilineText(payload.rationale)

  return {
    title: normalizeSingleLine(payload.title) || 'Codex request draft',
    categoryId: normalizeSingleLine(payload.categoryId).toLowerCase(),
    template: normalizeRequestTemplateFields(payload.template),
    rationale: rationale || undefined,
  }
}

export function parseRequestDraftToolResult(
  result: unknown,
  categories: TicketCategoryConfig[]
): RequestDraftPayload | undefined {
  if (!isRecord(result)) {
    return undefined
  }

  const title = readString(result.title)
  const rawTemplate = isRecord(result.template)
    ? {
        problem: readString(result.template.problem),
        desiredOutcome: readString(result.template.desiredOutcome),
        userScenarios: readString(result.template.userScenarios),
        constraints: readString(result.template.constraints),
        nonGoals: readString(result.template.nonGoals),
        openQuestions: readString(result.template.openQuestions),
      }
    : undefined

  if (
    !title?.trim() ||
    !rawTemplate?.problem?.trim() ||
    !rawTemplate.desiredOutcome?.trim() ||
    !rawTemplate.userScenarios?.trim()
  ) {
    return undefined
  }

  const template: RequestTemplateFields = {
    problem: rawTemplate.problem,
    desiredOutcome: rawTemplate.desiredOutcome,
    userScenarios: rawTemplate.userScenarios,
    constraints: rawTemplate.constraints,
    nonGoals: rawTemplate.nonGoals,
    openQuestions: rawTemplate.openQuestions,
  }

  return normalizeRequestDraftPayload({
    title,
    categoryId: normalizeCategoryId(readString(result.categoryId), categories),
    template,
    rationale: readString(result.rationale),
  })
}

export function setRunCodexTurnForRequestDraftTesting(fn: typeof runCodexTurn) {
  runCodexTurnForRequestDraftImpl = fn
}

export function resetRunCodexTurnForRequestDraftTesting() {
  runCodexTurnForRequestDraftImpl = runCodexTurn
}

function isTsRuntime() {
  return Boolean(process.argv[1]?.endsWith('.ts') || process.execArgv.some((arg) => arg.includes('tsx')))
}

export function buildRequestDraftMcpConfig() {
  const distScriptPath = resolve(process.cwd(), 'dist/server/mcp/request-intake-mcp.js')
  const sourceScriptPath = resolve(process.cwd(), 'src/server/mcp/request-intake-mcp.ts')

  if (isTsRuntime() || !existsSync(distScriptPath)) {
    return {
      mcp_servers: {
        [REQUEST_DRAFT_MCP_SERVER_NAME]: {
          command: process.execPath,
          args: ['--import', 'tsx', sourceScriptPath],
        },
      },
    }
  }

  return {
    mcp_servers: {
      [REQUEST_DRAFT_MCP_SERVER_NAME]: {
        command: process.execPath,
        args: [distScriptPath],
      },
    },
  }
}

export function buildExplainRequestDraftPrompt(
  message: string,
  projectId: string,
  categories: TicketCategoryConfig[],
  options: ExplainPromptOptions = {}
) {
  const categoryLines = categories.length
    ? categories.map((category) => `- ${category.id}: ${category.label} (${category.description})`).join('\n')
    : '- 카테고리가 없습니다.'
  const promptLines = [
    message.trim(),
    '',
    'Repository read tool context:',
    `Prefer ${SEARCH_REPOSITORY_TOOL_NAME}, ${READ_REPOSITORY_FILE_TOOL_NAME}, and ${LIST_REPOSITORY_FILES_TOOL_NAME} for repository lookup before shell commands when you need code evidence.`,
    'Use those tools to gather concrete file evidence and cite it in a 근거 파일 table when the answer is non-trivial.',
    '',
    'Request draft tool context:',
    `Current project id: ${projectId}`,
    'Available request categories. If you call the request draft tool, use one of these exact category ids:',
    categoryLines,
    'The request draft must stay user-facing and feature-oriented. Use the template fields as follows:',
    '- template.problem: why the user needs this change, written in product language',
    '- template.desiredOutcome: what the user should be able to do after the change',
    '- template.userScenarios: concrete user examples or flows',
    '- template.constraints: optional business or product constraints',
    '- template.nonGoals: optional out-of-scope notes',
    '- template.openQuestions: optional unresolved user-facing questions',
    'Do not turn the request draft into an implementation plan or technical spec.',
    `Only call ${REQUEST_DRAFT_TOOL_NAME} when the user explicitly asks you to save, register, or create a client request from the current conversation.`,
    'Do not call the tool for ordinary code explanations, brainstorming, or tentative discussion.',
    'The tool only creates a draft. The user will review and save it manually.',
  ]

  if (options.accessControl) {
    promptLines.push('', buildAccessControlToolContext(options.accessControl.availableProjects))
  }

  return promptLines.join('\n')
}

export function buildExplainConversationResumePrompt(
  latestMessage: string,
  messages: RequestDraftConversationMessage[],
  projectId: string,
  categories: TicketCategoryConfig[],
  options: ExplainPromptOptions = {}
) {
  const normalizedLatestMessage = normalizeMultilineText(latestMessage) || '(empty)'
  const transcript = formatConversationTranscript(messages)
  const leadMessage = [
    'This Explain conversation is resuming in a fresh Codex thread.',
    'Use the conversation transcript below as the authoritative prior context.',
    'Resolve references like this, that, it, or here from the transcript and continue naturally instead of restarting the conversation.',
    '',
    'Latest user message:',
    normalizedLatestMessage,
    '',
    'Conversation transcript:',
    transcript,
  ].join('\n')

  return buildExplainRequestDraftPrompt(leadMessage, projectId, categories, options)
}

function formatConversationTranscript(messages: RequestDraftConversationMessage[]) {
  const normalizedMessages = messages
    .map((message) => ({
      role: message.role,
      content: normalizeMultilineText(message.content),
    }))
    .filter((message) => message.content)

  if (normalizedMessages.length === 0) {
    return '- 대화 내용이 비어 있습니다.'
  }

  return normalizedMessages
    .map((message, index) => {
      const speaker = message.role === 'user' ? '사용자' : 'Codex'
      return `[${index + 1}] ${speaker}\n${message.content}`
    })
    .join('\n\n')
}

function formatExistingDraftContext(existingDraft?: ExistingRequestDraftContext) {
  if (!existingDraft) {
    return 'Current request draft: (none)'
  }

  const normalized = normalizeRequestDraftPayload(existingDraft)

  return [
    'Current request draft to refine:',
    `Title: ${normalized.title}`,
    `Category: ${normalized.categoryId}`,
    '',
    'Problem:',
    normalized.template.problem,
    '',
    'Desired outcome:',
    normalized.template.desiredOutcome,
    '',
    'User scenarios:',
    normalized.template.userScenarios,
    '',
    'Constraints:',
    normalized.template.constraints ?? '(empty)',
    '',
    'Non-goals:',
    normalized.template.nonGoals ?? '(empty)',
    '',
    'Open questions:',
    normalized.template.openQuestions ?? '(empty)',
    ...(normalized.rationale ? ['', 'Current rationale:', normalized.rationale] : []),
  ].join('\n')
}

export function buildConversationRequestDraftPrompt(
  messages: RequestDraftConversationMessage[],
  projectId: string,
  categories: TicketCategoryConfig[],
  intent: 'manual' | 'implementation_request' = 'manual',
  existingDraft?: ExistingRequestDraftContext
) {
  const transcript = formatConversationTranscript(messages)
  const leadMessage = [
    intent === 'implementation_request'
      ? 'The user asked for implementation or file changes in Explain mode. Explain mode is read-only, so convert that ask into a client request draft instead of refusing.'
      : 'The user clicked Request + to turn the current conversation into a client request draft.',
    `Call ${REQUEST_DRAFT_TOOL_NAME} exactly once for the best request draft you can produce from the conversation below.`,
    existingDraft
      ? 'Refine the current request draft using the latest conversation. Preserve good existing fields unless the conversation clearly corrects them.'
      : 'Create a new request draft from the conversation below.',
    'Do not ask follow-up questions unless the conversation is completely unusable.',
    'Keep any assistant text after the tool call to one short sentence at most.',
    '',
    formatExistingDraftContext(existingDraft),
    '',
    'Conversation transcript:',
    transcript,
  ].join('\n')

  return buildExplainRequestDraftPrompt(leadMessage, projectId, categories)
}

function normalizeManualRequestDraftInput(
  input: ManualRequestDraftInput
): {
  requester: string
  title: string
  categoryId: string
  template: RequestTemplateFields
} {
  return {
    requester: normalizeSingleLine(input.requester),
    title: normalizeSingleLine(input.title),
    categoryId: normalizeSingleLine(input.categoryId).toLowerCase(),
    template: {
      problem: normalizeMultilineText(input.template?.problem),
      desiredOutcome: normalizeMultilineText(input.template?.desiredOutcome),
      userScenarios: normalizeMultilineText(input.template?.userScenarios),
      constraints: normalizeMultilineText(input.template?.constraints),
      nonGoals: normalizeMultilineText(input.template?.nonGoals),
      openQuestions: normalizeMultilineText(input.template?.openQuestions),
    },
  }
}

function formatPromptField(label: string, value: string | undefined) {
  return `${label}\n${value?.trim() ? value : '(empty)'}`
}

export function buildManualRequestDraftPrompt(
  input: ManualRequestDraftInput,
  projectId: string,
  categories: TicketCategoryConfig[]
) {
  const normalized = normalizeManualRequestDraftInput(input)
  const selectedCategory = categories.find((category) => category.id === normalized.categoryId)
  const selectedCategoryLabel = selectedCategory
    ? `${selectedCategory.id}: ${selectedCategory.label}`
    : normalized.categoryId || '(empty)'

  const leadMessage = [
    'The user is filling out a client request intake form and wants AI to complete a structured request draft from the partially filled form.',
    `Call ${REQUEST_DRAFT_TOOL_NAME} exactly once for the best request draft you can produce from the intake form below.`,
    'Treat each non-empty field as authoritative user intent. Preserve its meaning and wording when possible, and only normalize lightly for clarity.',
    'Fill in missing fields and strengthen incomplete ones so the result is a complete, user-facing request.',
    'Do not turn the draft into an implementation plan or technical spec.',
    'You may keep the selected category or choose a better allowed category if the form clearly points elsewhere.',
    '',
    'Current intake form:',
    formatPromptField('Requester:', normalized.requester),
    '',
    formatPromptField('Title:', normalized.title),
    '',
    formatPromptField('Selected category:', selectedCategoryLabel),
    '',
    formatPromptField('Problem:', normalized.template.problem),
    '',
    formatPromptField('Desired outcome:', normalized.template.desiredOutcome),
    '',
    formatPromptField('User scenarios:', normalized.template.userScenarios),
    '',
    formatPromptField('Constraints:', normalized.template.constraints),
    '',
    formatPromptField('Non-goals:', normalized.template.nonGoals),
    '',
    formatPromptField('Open questions:', normalized.template.openQuestions),
  ].join('\n')

  return buildExplainRequestDraftPrompt(leadMessage, projectId, categories)
}

export async function generateRequestDraft(options: GenerateRequestDraftOptions): Promise<RequestDraftPayload> {
  const selectedModel = getModelCapability(options.model?.trim() || options.explainFlow.model).id
  const selectedReasoningEffort = resolveReasoningEffortForModel(
    selectedModel,
    options.reasoningEffort ?? options.explainFlow.reasoningEffort
  )
  const requestDraftMcpConfig = buildRequestDraftMcpConfig()
  const repoReadMcpConfig = buildRepoReadMcpConfig(options.projectPath)
  const codexConfig = {
    ...repoReadMcpConfig,
    ...requestDraftMcpConfig,
    mcp_servers: {
      ...(repoReadMcpConfig.mcp_servers ?? {}),
      ...(requestDraftMcpConfig.mcp_servers ?? {}),
    },
  }

  let draftResult: RequestDraftPayload | undefined
  let draftError: string | undefined

  await runCodexTurnForRequestDraftImpl({
    prompt: options.prompt,
    promptFile: options.explainFlow.promptFile,
    cwd: options.projectPath,
    model: selectedModel,
    reasoningEffort: selectedReasoningEffort,
    serviceTier: options.explainFlow.serviceTier,
    sandboxMode: options.explainFlow.sandboxMode ?? 'read-only',
    approvalPolicy: 'never',
    networkAccessEnabled: false,
    signal: options.signal,
    codexConfig,
    onEvent: async (event) => {
      if (event.type !== 'tool_result' || event.data.tool !== REQUEST_DRAFT_TOOL_NAME) {
        return
      }

      draftError = event.data.error
      draftResult = parseRequestDraftToolResult(event.data.result, options.categories)
    },
  })

  if (!draftResult || draftError) {
    throw new Error(draftError || 'Codex did not return a valid request draft')
  }

  return draftResult
}
