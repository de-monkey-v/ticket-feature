import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  Codex,
  type ApprovalMode,
  type McpToolCallItem,
  type ModelReasoningEffort,
  type SandboxMode,
} from '@openai/codex-sdk'
import { detectCompatibleSandboxMode } from '../lib/sandbox-compat.js'

type AppReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
type ServiceTier = 'fast' | 'flex'
type CodexConfigValue = string | number | boolean | CodexConfigValue[] | CodexConfigObject
type CodexConfigObject = {
  [key: string]: CodexConfigValue
}

export interface CodexToolEventData extends Record<string, unknown> {
  id: string
  server: string
  tool: string
  input: unknown
  result?: unknown
  error?: string
}

export type CodexTurnEvent =
  | {
      type: 'init'
      data: { threadId?: string }
    }
  | {
      type: 'delta'
      data: { text?: string }
    }
  | {
      type: 'tool_use'
      data: CodexToolEventData
    }
  | {
      type: 'tool_result'
      data: CodexToolEventData
    }

export interface RunCodexTurnOptions {
  prompt: string
  promptFile: string
  cwd: string
  threadId?: string
  model: string
  reasoningEffort?: AppReasoningEffort
  serviceTier?: ServiceTier
  sandboxMode: SandboxMode
  approvalPolicy: ApprovalMode
  networkAccessEnabled?: boolean
  signal?: AbortSignal
  outputSchema?: Record<string, unknown>
  codexConfig?: CodexConfigObject
  onEvent?: (event: CodexTurnEvent) => Promise<void> | void
}

export interface CodexTurnResult<T = unknown> {
  threadId: string | null
  finalResponse: string
  parsedOutput?: T
}

export type CodexRecoveryStrategy = 'transcript' | 'restart'
export type CodexRecoveryMode = 'native' | 'rehydrated'

export interface RunRecoverableCodexTurnOptions extends RunCodexTurnOptions {
  recoveryStrategy: CodexRecoveryStrategy
  recoveryPrompt?: string
  recoveryLabel?: string
  recoveryDetail?: string
  onRecoveryState?: (label: string, detail?: string, reason?: string) => Promise<void> | void
  runTurn?: typeof runCodexTurn
}

export interface RecoverableCodexTurnResult<T = unknown> extends CodexTurnResult<T> {
  recoveryMode: CodexRecoveryMode
  resumeFailureReason?: string
  hadAssistantDelta: boolean
}

class RecoverableTurnError extends Error {
  originalError: unknown
  sawEvent: boolean
  hadAssistantDelta: boolean

  constructor(cause: unknown, sawEvent: boolean, hadAssistantDelta: boolean) {
    super(cause instanceof Error ? cause.message : 'Codex turn failed')
    this.name = cause instanceof Error ? cause.name : 'Error'
    this.originalError = cause
    this.sawEvent = sawEvent
    this.hadAssistantDelta = hadAssistantDelta
  }
}

function readPromptFile(promptFile: string): string {
  const fullPath = resolve(process.cwd(), promptFile)
  return readFileSync(fullPath, 'utf-8').trim()
}

function normalizeReasoningEffort(
  effort: AppReasoningEffort | undefined
): ModelReasoningEffort | undefined {
  if (!effort || effort === 'none') {
    return undefined
  }

  return effort
}

function getTextDelta(previous: string, next: string): string {
  if (!next) {
    return ''
  }

  if (!previous) {
    return next
  }

  return next.startsWith(previous) ? next.slice(previous.length) : next
}

function hasMeaningfulTurnResult<T>(result: CodexTurnResult<T>) {
  return Boolean(result.finalResponse.trim()) || result.parsedOutput !== undefined
}

export function buildCodexToolEventData(item: McpToolCallItem): CodexToolEventData {
  return {
    id: item.id,
    server: item.server,
    tool: item.tool,
    input: item.arguments,
    result: item.result?.structured_content ?? item.result,
    error: item.error?.message,
  }
}

export async function runCodexTurn<T = unknown>(
  opts: RunCodexTurnOptions
): Promise<CodexTurnResult<T>> {
  const developerInstructions = readPromptFile(opts.promptFile)
  const sandboxMode = detectCompatibleSandboxMode(opts.sandboxMode)
  const codex = new Codex({
    config: {
      ...(opts.codexConfig ?? {}),
      developer_instructions: developerInstructions,
      service_tier: opts.serviceTier ?? 'fast',
      web_search: 'disabled',
    },
  })

  const threadOptions = {
    workingDirectory: opts.cwd,
    model: opts.model,
    sandboxMode,
    approvalPolicy: opts.approvalPolicy,
    modelReasoningEffort: normalizeReasoningEffort(opts.reasoningEffort),
    networkAccessEnabled: opts.networkAccessEnabled,
  }

  const thread = opts.threadId
    ? codex.resumeThread(opts.threadId, threadOptions)
    : codex.startThread(threadOptions)

  const { events } = await thread.runStreamed(opts.prompt, {
    signal: opts.signal,
    outputSchema: opts.outputSchema,
  })

  const agentMessageTextById = new Map<string, string>()
  const startedToolIds = new Set<string>()
  const completedToolIds = new Set<string>()
  let finalResponse = ''

  for await (const event of events) {
    if (event.type === 'thread.started') {
      await opts.onEvent?.({
        type: 'init',
        data: { threadId: event.thread_id },
      })
      continue
    }

    if (
      (event.type === 'item.started' ||
        event.type === 'item.updated' ||
        event.type === 'item.completed') &&
      event.item.type === 'agent_message'
    ) {
      const previousText = agentMessageTextById.get(event.item.id) || ''
      const nextText = event.item.text || ''
      agentMessageTextById.set(event.item.id, nextText)
      finalResponse = nextText

      const delta = getTextDelta(previousText, nextText)
      if (delta) {
        await opts.onEvent?.({
          type: 'delta',
          data: { text: delta },
        })
      }
      continue
    }

    if (
      (event.type === 'item.started' ||
        event.type === 'item.updated' ||
        event.type === 'item.completed') &&
      event.item.type === 'mcp_tool_call'
    ) {
      const toolEventData = buildCodexToolEventData(event.item)

      if (!startedToolIds.has(event.item.id)) {
        startedToolIds.add(event.item.id)
        await opts.onEvent?.({
          type: 'tool_use',
          data: toolEventData,
        })
      }

      if (event.item.status !== 'in_progress' && !completedToolIds.has(event.item.id)) {
        completedToolIds.add(event.item.id)
        await opts.onEvent?.({
          type: 'tool_result',
          data: toolEventData,
        })
      }

      continue
    }

    if (event.type === 'turn.failed') {
      throw new Error(event.error.message)
    }

    if (event.type === 'error') {
      throw new Error(event.message)
    }

    if (event.type === 'turn.completed') {
      const parsedOutput =
        opts.outputSchema && finalResponse
          ? (JSON.parse(finalResponse) as T)
          : undefined

      return {
        threadId: thread.id,
        finalResponse,
        parsedOutput,
      }
    }
  }

  if (opts.signal?.aborted) {
    const error = new Error('Codex turn aborted')
    error.name = 'AbortError'
    throw error
  }

  throw new Error('Codex turn ended without completion')
}

export async function runRecoverableCodexTurn<T = unknown>(
  opts: RunRecoverableCodexTurnOptions
): Promise<RecoverableCodexTurnResult<T>> {
  const runTurn = opts.runTurn ?? runCodexTurn

  const executeTurn = async (activeThreadId: string | undefined, prompt: string) => {
    let sawEvent = false
    let hadAssistantDelta = false

    try {
      const result = await runTurn<T>({
        ...opts,
        prompt,
        threadId: activeThreadId,
        onEvent: async (event) => {
          sawEvent = true

          if (event.type === 'delta' && typeof event.data.text === 'string' && event.data.text.length > 0) {
            hadAssistantDelta = true
          }

          await opts.onEvent?.(event)
        },
      })

      return {
        ...result,
        sawEvent,
        hadAssistantDelta,
      }
    } catch (error) {
      throw new RecoverableTurnError(error, sawEvent, hadAssistantDelta)
    }
  }

  if (!opts.threadId) {
    const result = await executeTurn(undefined, opts.prompt)
    return {
      threadId: result.threadId,
      finalResponse: result.finalResponse,
      parsedOutput: result.parsedOutput,
      recoveryMode: 'native',
      hadAssistantDelta: result.hadAssistantDelta,
    }
  }

  try {
    const result = await executeTurn(opts.threadId, opts.prompt)
    if (!result.sawEvent && !hasMeaningfulTurnResult(result)) {
      throw new RecoverableTurnError(new Error('Codex thread resume produced no events'), false, result.hadAssistantDelta)
    }

    return {
      threadId: result.threadId,
      finalResponse: result.finalResponse,
      parsedOutput: result.parsedOutput,
      recoveryMode: 'native',
      hadAssistantDelta: result.hadAssistantDelta,
    }
  } catch (error) {
    if (opts.signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
      throw error
    }

    const sawEvent = error instanceof RecoverableTurnError ? error.sawEvent : false
    if (sawEvent) {
      throw error
    }

    const resumeFailureReason = error instanceof Error ? error.message : 'Codex thread resume failed'
    await opts.onRecoveryState?.(opts.recoveryLabel ?? '새 세션에서 이어가는 중', opts.recoveryDetail, resumeFailureReason)

    const recoveryPrompt = opts.recoveryStrategy === 'transcript' ? opts.recoveryPrompt ?? opts.prompt : opts.prompt
    const recovered = await executeTurn(undefined, recoveryPrompt)
    return {
      threadId: recovered.threadId,
      finalResponse: recovered.finalResponse,
      parsedOutput: recovered.parsedOutput,
      recoveryMode: 'rehydrated',
      resumeFailureReason,
      hadAssistantDelta: recovered.hadAssistantDelta,
    }
  }
}
