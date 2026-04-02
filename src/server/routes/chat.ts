import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { getAuthSession, requireProjectPermission } from '../lib/auth.js'
import { loadConfig, type ReasoningEffort } from '../lib/config.js'
import { getModelCapability, resolveReasoningEffortForModel } from '../lib/model-capabilities.js'
import { requireAccessibleProjectById } from '../lib/projects.js'
import { buildAccessControlMcpConfig } from '../services/access-tool.js'
import {
  queueBackgroundRun,
  type BackgroundRunRecord,
} from '../services/background-runs.js'
import { runCodexTurn, runRecoverableCodexTurn, type CodexRecoveryMode } from '../services/codex-sdk.js'
import {
  loadExplainState,
  saveExplainState,
  type ExplainMessageRecord,
  type ExplainRequestDraft,
  type ExplainState,
  type ExplainThreadState,
} from '../services/explain-state.js'
import {
  buildConversationRequestDraftPrompt,
  buildExplainConversationResumePrompt,
  buildExplainRequestDraftPrompt,
  buildRequestDraftMcpConfig,
  generateRequestDraft,
  normalizeRequestDraftPayload,
  type RequestDraftConversationMessage,
  type RequestDraftPayload,
} from '../services/request-draft-tool.js'
import { buildRepoReadMcpConfig } from '../services/repo-read-tool.js'

export const chatRoutes = new Hono()
let runCodexTurnImpl: typeof runCodexTurn = runCodexTurn
const EXPLAIN_SESSION_RESTART_LABEL = '새 세션에서 이어가는 중'
const EXPLAIN_SESSION_RESTART_DETAIL =
  '이전 Codex 세션을 복구하지 못해 현재 대화 기록을 바탕으로 이어가고 있습니다.'
const EXPLAIN_SESSION_RESTART_NOTICE =
  '_참고: 이전 Codex 세션을 복구하지 못해 현재 대화 기록을 바탕으로 새 세션에서 이어갔습니다._'

export function setRunCodexTurnForChatTesting(fn: typeof runCodexTurn) {
  runCodexTurnImpl = fn
}

export function resetRunCodexTurnForChatTesting() {
  runCodexTurnImpl = runCodexTurn
}

function readString(value: unknown) {
  return typeof value === 'string' ? value : undefined
}

function isConversationMessage(
  value: unknown
): value is {
  role: 'user' | 'assistant'
  content: string
} {
  return (
    typeof value === 'object' &&
    value !== null &&
    ('role' in value ? value.role === 'user' || value.role === 'assistant' : false) &&
    ('content' in value ? typeof value.content === 'string' : false)
  )
}

function normalizeConversationMessages(value: unknown): RequestDraftConversationMessage[] {
  if (!Array.isArray(value)) {
    return []
  }

  return value
    .filter(isConversationMessage)
    .map((message) => ({
      role: message.role,
      content: message.content.trim(),
    }))
    .filter((message) => message.content)
}

function isExistingDraftContext(
  value: unknown
): value is {
  title: string
  categoryId: string
  template: {
    problem: string
    desiredOutcome: string
    userScenarios: string
    constraints?: string
    nonGoals?: string
    openQuestions?: string
  }
  rationale?: string
} {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const record = value as Record<string, unknown>
  const template = record.template
  return (
    typeof record.title === 'string' &&
    typeof record.categoryId === 'string' &&
    typeof template === 'object' &&
    template !== null &&
    typeof (template as Record<string, unknown>).problem === 'string' &&
    typeof (template as Record<string, unknown>).desiredOutcome === 'string' &&
    typeof (template as Record<string, unknown>).userScenarios === 'string' &&
    (record.rationale === undefined || typeof record.rationale === 'string')
  )
}

function normalizeMessagePreview(value: string | undefined, fallback = '(empty)') {
  const normalized = (value ?? '').replace(/\s+/g, ' ').trim()
  return normalized || fallback
}

function updateLastAssistantMessage(messages: ExplainMessageRecord[], updater: (current: string) => string) {
  const next = [...messages]

  for (let index = next.length - 1; index >= 0; index -= 1) {
    if (next[index]?.role !== 'assistant') {
      continue
    }

    next[index] = {
      ...next[index],
      content: updater(next[index]!.content),
    }
    return next
  }

  return next
}

function resolveCompletedAssistantContent(current: string, finalResponse?: string) {
  const normalizedCurrent = current.trim()
  const normalizedFinal = finalResponse?.trim()

  if (normalizedFinal) {
    if (!normalizedCurrent || normalizedFinal.startsWith(normalizedCurrent)) {
      return normalizedFinal
    }

    return current
  }

  if (normalizedCurrent) {
    return current
  }

  return '_응답이 비어 있습니다. 다시 질문하거나 표현을 조금 더 구체적으로 적어 주세요._'
}

function appendExplainSessionRestartNotice(content: string) {
  const trimmed = content.trimEnd()

  if (!trimmed) {
    return EXPLAIN_SESSION_RESTART_NOTICE
  }

  if (trimmed.includes(EXPLAIN_SESSION_RESTART_NOTICE)) {
    return trimmed
  }

  return `${trimmed}\n\n${EXPLAIN_SESSION_RESTART_NOTICE}`
}

function applyExplainContinuityState(
  thread: ExplainThreadState,
  params: {
    sourceThreadId?: string
    recoveryMode: CodexRecoveryMode
    resumeFailureReason?: string
    updatedAt: string
  }
) {
  if (params.recoveryMode === 'rehydrated') {
    return {
      ...thread,
      continuityMode: 'rehydrated' as const,
      lastRecoveryAt: params.updatedAt,
      lastRecoveryReason: params.resumeFailureReason ?? EXPLAIN_SESSION_RESTART_DETAIL,
    }
  }

  if (params.sourceThreadId) {
    return {
      ...thread,
      continuityMode: 'native' as const,
      lastRecoveryAt: undefined,
      lastRecoveryReason: undefined,
    }
  }

  return thread
}

function markLastAssistantStopped(messages: ExplainMessageRecord[], content?: string) {
  return updateLastAssistantMessage(messages, (current) => {
    const base = content?.trim() ? content : current.trim() ? current : '_응답이 중단되었습니다._'
    return base.includes('_응답이 중단되었습니다._') ? base : `${base}\n\n_응답이 중단되었습니다._`
  })
}

function appendAssistantError(messages: ExplainMessageRecord[], message: string) {
  return updateLastAssistantMessage(messages, (current) =>
    current ? `${current}\n\n**Error**: ${message}` : `**Error**: ${message}`
  )
}

function updateExplainThreadState(
  state: ExplainState,
  threadKey: string,
  updater: (thread: ExplainThreadState) => ExplainThreadState
) {
  return {
    ...state,
    threads: state.threads.map((thread) => (thread.id === threadKey ? updater(thread) : thread)),
  }
}

function saveUpdatedExplainThread(
  auth: ReturnType<typeof getAuthSession>,
  projectId: string,
  threadKey: string,
  updater: (thread: ExplainThreadState) => ExplainThreadState
) {
  const loaded = loadExplainState(auth, projectId)
  const target = loaded.state.threads.find((thread) => thread.id === threadKey)
  if (!target) {
    return undefined
  }

  return saveExplainState(auth, projectId, updateExplainThreadState(loaded.state, threadKey, updater))
}

function upsertDraft(drafts: ExplainRequestDraft[], nextDraft: ExplainRequestDraft) {
  const next = [...drafts]
  const index = next.findIndex((draft) => draft.id === nextDraft.id)
  if (index === -1) {
    next.push(nextDraft)
    return next
  }

  next[index] = {
    ...next[index],
    ...nextDraft,
  }
  return next
}

function resolveExplainRuntime(
  auth: ReturnType<typeof getAuthSession>,
  project: { id: string; path: string },
  message: string,
  config: ReturnType<typeof loadConfig>,
  model?: string,
  reasoningEffort?: ReasoningEffort,
  conversationMessages: RequestDraftConversationMessage[] = []
) {
  const selectedModel = getModelCapability(model?.trim() || config.flows.explain.model).id
  const selectedReasoningEffort = resolveReasoningEffortForModel(
    selectedModel,
    reasoningEffort ?? config.flows.explain.reasoningEffort
  )
  const promptOptions = {
    accessControl: auth.isAdmin
      ? {
          availableProjects: config.projects.map(({ id, label }) => ({
            id,
            label,
          })),
        }
      : undefined,
  }
  const prompt = buildExplainRequestDraftPrompt(message.trim(), project.id, config.flows.ticket.categories, promptOptions)
  const fallbackPrompt =
    conversationMessages.length > 1
      ? buildExplainConversationResumePrompt(
          message.trim(),
          conversationMessages,
          project.id,
          config.flows.ticket.categories,
          promptOptions
        )
      : prompt
  const requestDraftMcpConfig = buildRequestDraftMcpConfig()
  const repoReadMcpConfig = buildRepoReadMcpConfig(project.path)
  const accessControlMcpConfig = auth.isAdmin ? buildAccessControlMcpConfig() : { mcp_servers: {} }

  return {
    prompt,
    fallbackPrompt,
    selectedModel,
    selectedReasoningEffort,
    codexConfig: {
      ...repoReadMcpConfig,
      ...requestDraftMcpConfig,
      ...accessControlMcpConfig,
      mcp_servers: {
        ...(repoReadMcpConfig.mcp_servers ?? {}),
        ...(requestDraftMcpConfig.mcp_servers ?? {}),
        ...(accessControlMcpConfig.mcp_servers ?? {}),
      },
    },
  }
}

chatRoutes.post('/chat', async (c) => {
  const { message, threadId, projectId, model, reasoningEffort, messages } = await c.req.json<{
    message: string
    threadId?: string
    projectId?: string
    model?: string
    reasoningEffort?: ReasoningEffort
    messages?: unknown
  }>()

  if (!message?.trim()) {
    return c.json({ error: 'Message is required', code: 'INVALID_MESSAGE' }, 400)
  }

  const config = loadConfig()
  const auth = getAuthSession(c)
  let project

  try {
    project = requireAccessibleProjectById(config, auth, projectId)
  } catch (error: any) {
    return c.json(
      { error: error.message, code: error.message === 'Project access denied' ? 'PROJECT_FORBIDDEN' : 'UNKNOWN_PROJECT' },
      error.message === 'Project access denied' ? 403 : 400
    )
  }

  const permissionError = requireProjectPermission(c, project.id, 'explain')
  if (permissionError) {
    return permissionError
  }

  const normalizedMessages = normalizeConversationMessages(messages)
  const { prompt, fallbackPrompt, selectedModel, selectedReasoningEffort, codexConfig } = resolveExplainRuntime(
    auth,
    project,
    message,
    config,
    model,
    reasoningEffort,
    normalizedMessages
  )

  return streamSSE(c, async (stream) => {
    let currentThreadId: string | null = threadId ?? null
    let streamAborted = false
    let settled = false
    let streamedAssistantText = ''
    const abortController = new AbortController()

    stream.onAbort(() => {
      streamAborted = true
      abortController.abort()
    })

    try {
      const completedRun = await runRecoverableCodexTurn({
        prompt,
        recoveryStrategy: 'transcript',
        recoveryPrompt: fallbackPrompt,
        recoveryLabel: EXPLAIN_SESSION_RESTART_LABEL,
        recoveryDetail: EXPLAIN_SESSION_RESTART_DETAIL,
        onRecoveryState: async (label, detail) => {
          currentThreadId = null
          if (streamAborted) {
            return
          }

          await stream.writeSSE({
            event: 'state',
            data: JSON.stringify({
              label,
              detail,
            }),
          })
        },
        promptFile: config.flows.explain.promptFile,
        cwd: project.path,
        threadId,
        model: selectedModel,
        reasoningEffort: selectedReasoningEffort,
        serviceTier: config.flows.explain.serviceTier,
        sandboxMode: config.flows.explain.sandboxMode ?? 'read-only',
        approvalPolicy: 'never',
        networkAccessEnabled: false,
        codexConfig,
        signal: abortController.signal,
        runTurn: runCodexTurnImpl,
        onEvent: async (event) => {
          if (event.type === 'delta' && typeof event.data.text === 'string' && event.data.text.length > 0) {
            streamedAssistantText += event.data.text
          }

          if (event.type === 'init' && typeof event.data.threadId === 'string') {
            currentThreadId = event.data.threadId
          }

          if (!streamAborted) {
            await stream.writeSSE({
              event: event.type,
              data: JSON.stringify(event.data),
            })
          }
        },
      })

      if (completedRun.threadId) {
        currentThreadId = completedRun.threadId
      }

      if (!streamAborted) {
        const finalResponse = resolveCompletedAssistantContent(streamedAssistantText, completedRun.finalResponse)
        const finalResponseWithRestartNotice = completedRun.recoveryMode === 'rehydrated'
          ? appendExplainSessionRestartNotice(finalResponse)
          : finalResponse
        await stream.writeSSE({
          event: 'done',
          data: JSON.stringify({
            threadId: currentThreadId,
            finalResponse: finalResponseWithRestartNotice,
            hadAssistantDelta: completedRun.hadAssistantDelta,
            recoveryMode: completedRun.recoveryMode,
            resumeFailureReason: completedRun.resumeFailureReason,
            resumedInFreshThread: completedRun.recoveryMode === 'rehydrated',
          }),
        })
      }

      settled = true
    } catch (err: any) {
      if (!streamAborted && !settled) {
        await stream.writeSSE({
          event: 'error',
          data: JSON.stringify({
            message: err.message,
            code: 'CODEX_BRIDGE_ERROR',
          }),
        })
      }
    }
  })
})

chatRoutes.post('/chat/runs', async (c) => {
  const { message, threadId, threadKey, projectId, model, reasoningEffort, messages, drafts, scopeLabel } = await c.req.json<{
    message: string
    threadId?: string
    threadKey?: string
    projectId?: string
    model?: string
    reasoningEffort?: ReasoningEffort
    messages?: unknown
    drafts?: unknown
    scopeLabel?: string
  }>()

  if (!message?.trim()) {
    return c.json({ error: 'Message is required', code: 'INVALID_MESSAGE' }, 400)
  }

  if (!threadKey?.trim()) {
    return c.json({ error: 'Thread key is required', code: 'INVALID_THREAD' }, 400)
  }

  const config = loadConfig()
  const auth = getAuthSession(c)
  let project

  try {
    project = requireAccessibleProjectById(config, auth, projectId)
  } catch (error: any) {
    return c.json(
      { error: error.message, code: error.message === 'Project access denied' ? 'PROJECT_FORBIDDEN' : 'UNKNOWN_PROJECT' },
      error.message === 'Project access denied' ? 403 : 400
    )
  }

  const permissionError = requireProjectPermission(c, project.id, 'explain')
  if (permissionError) {
    return permissionError
  }

  const normalizedMessages = normalizeConversationMessages(messages)
  const { prompt, fallbackPrompt, selectedModel, selectedReasoningEffort, codexConfig } = resolveExplainRuntime(
    auth,
    project,
    message,
    config,
    model,
    reasoningEffort,
    normalizedMessages
  )

  const started = queueBackgroundRun(
    auth,
    {
      projectId: project.id,
      kind: 'explain_reply',
      permission: 'explain',
      scopeType: 'explain_thread',
      scopeId: threadKey,
      scopeLabel: scopeLabel?.trim() || threadKey,
      messagePreview: message.trim(),
    },
    async (run) => {
      let currentThreadId: string | null = threadId ?? null
      let streamedAssistantText = ''
      let phase: string | null = null
      let recoveryMode: CodexRecoveryMode = 'native'
      let resumeFailureReason: string | undefined

      const setPhase = (nextPhase: string, label: string, detail?: string) => {
        if (phase === nextPhase) {
          return
        }

        phase = nextPhase
        run.emitState(label, detail)
      }

      try {
        setPhase('submitting', '질문 전송 중', 'Codex 세션에 질문을 전달하고 있습니다.')

        const completedRun = await runRecoverableCodexTurn({
          prompt,
          recoveryStrategy: 'transcript',
          recoveryPrompt: fallbackPrompt,
          recoveryLabel: EXPLAIN_SESSION_RESTART_LABEL,
          recoveryDetail: EXPLAIN_SESSION_RESTART_DETAIL,
          onRecoveryState: (label, detail, reason) => {
            recoveryMode = 'rehydrated'
            resumeFailureReason = reason
            currentThreadId = null
            setPhase('fallback', label, detail)
          },
          promptFile: config.flows.explain.promptFile,
          cwd: project.path,
          threadId,
          model: selectedModel,
          reasoningEffort: selectedReasoningEffort,
          serviceTier: config.flows.explain.serviceTier,
          sandboxMode: config.flows.explain.sandboxMode ?? 'read-only',
          approvalPolicy: 'never',
          networkAccessEnabled: false,
          codexConfig,
          signal: run.signal,
          runTurn: runCodexTurnImpl,
          onEvent: async (event) => {
            if (event.type === 'init' && typeof event.data.threadId === 'string') {
              currentThreadId = event.data.threadId
              return
            }

            if (event.type === 'delta' && typeof event.data.text === 'string' && event.data.text.length > 0) {
              streamedAssistantText += event.data.text
              setPhase('answering', '답변 생성 중', '수집한 근거를 바탕으로 답변을 작성하고 있습니다.')
            }

            if (event.type === 'tool_use' && typeof event.data.tool === 'string') {
              setPhase('tool', `${event.data.tool} 실행 중`, '추가 정보를 확인하고 있습니다.')
            }

            if (event.type === 'tool_result' && typeof event.data.tool === 'string') {
              setPhase('waiting', '답변 정리 중', `${event.data.tool} 실행 결과를 정리하고 있습니다.`)
            }

            if (event.type !== 'init') {
              run.emitEvent({
                type: event.type,
                data: event.data,
                createdAt: new Date().toISOString(),
              })
            }
          },
        })

        recoveryMode = completedRun.recoveryMode
        resumeFailureReason = completedRun.resumeFailureReason
        if (completedRun.threadId) {
          currentThreadId = completedRun.threadId
        }

        const finalResponse = resolveCompletedAssistantContent(streamedAssistantText, completedRun.finalResponse)
        const finalResponseWithRestartNotice = completedRun.recoveryMode === 'rehydrated'
          ? appendExplainSessionRestartNotice(finalResponse)
          : finalResponse
        const updatedAt = new Date().toISOString()
        saveUpdatedExplainThread(auth, project.id, threadKey, (thread) => ({
          ...applyExplainContinuityState(thread, {
            sourceThreadId: threadId,
            recoveryMode: completedRun.recoveryMode,
            resumeFailureReason: completedRun.resumeFailureReason,
            updatedAt,
          }),
          threadId: currentThreadId ?? undefined,
          activeRunId: undefined,
          messages: updateLastAssistantMessage(thread.messages, () => finalResponseWithRestartNotice),
          updatedAt,
        }))

        run.complete(
          {
            threadId: currentThreadId,
            finalResponse: finalResponseWithRestartNotice,
            hadAssistantDelta: completedRun.hadAssistantDelta,
            recoveryMode: completedRun.recoveryMode,
            resumeFailureReason: completedRun.resumeFailureReason,
            resumedInFreshThread: completedRun.recoveryMode === 'rehydrated',
          },
          {
            latestLabel: '답변 완료',
            latestDetail: undefined,
          }
        )
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          const stoppedContent = streamedAssistantText.trim() ? streamedAssistantText : undefined
          const stoppedContentWithRestartNotice =
            recoveryMode === 'rehydrated' && stoppedContent ? appendExplainSessionRestartNotice(stoppedContent) : stoppedContent
          const updatedAt = new Date().toISOString()
          saveUpdatedExplainThread(auth, project.id, threadKey, (thread) => ({
            ...applyExplainContinuityState(thread, {
              sourceThreadId: threadId,
              recoveryMode,
              resumeFailureReason,
              updatedAt,
            }),
            threadId: currentThreadId ?? undefined,
            activeRunId: undefined,
            messages: markLastAssistantStopped(thread.messages, stoppedContentWithRestartNotice),
            updatedAt,
          }))

          run.stop(
            {
              threadId: currentThreadId,
              finalResponse: stoppedContentWithRestartNotice,
              hadAssistantDelta: Boolean(streamedAssistantText.trim()),
              recoveryMode,
              resumeFailureReason,
              resumedInFreshThread: recoveryMode === 'rehydrated',
            },
            {
              latestLabel: '응답 중단됨',
              latestDetail: '사용자 요청으로 작업을 중단했습니다.',
            }
          )
          return
        }

        const messageText = error instanceof Error ? error.message : 'Explain background run failed'
        const updatedAt = new Date().toISOString()
        saveUpdatedExplainThread(auth, project.id, threadKey, (thread) => ({
          ...applyExplainContinuityState(thread, {
            sourceThreadId: threadId,
            recoveryMode,
            resumeFailureReason,
            updatedAt,
          }),
          threadId: currentThreadId ?? undefined,
          activeRunId: undefined,
          messages: appendAssistantError(thread.messages, messageText),
          updatedAt,
        }))

        run.fail(messageText, { code: 'CODEX_BRIDGE_ERROR' }, {
          latestLabel: '응답 생성 실패',
          latestDetail: messageText,
        })
      }
    }
  )

  if (!started.existing) {
    const conversationUpdatedAt = new Date().toISOString()
    saveUpdatedExplainThread(auth, project.id, threadKey, (thread) => ({
      ...thread,
      threadId: readString(threadId) ?? thread.threadId,
      activeRunId: started.run.id,
      messages: Array.isArray(messages) ? (messages as ExplainMessageRecord[]) : thread.messages,
      drafts: Array.isArray(drafts) ? (drafts as ExplainRequestDraft[]) : thread.drafts,
      sortUpdatedAt: conversationUpdatedAt,
      updatedAt: conversationUpdatedAt,
    }))
  }

  return c.json(started, 202)
})

chatRoutes.post('/chat/request-draft', async (c) => {
  const { messages, projectId, model, reasoningEffort, intent, existingDraft } = await c.req.json<{
    messages?: Array<{ role: 'user' | 'assistant'; content: string }>
    projectId?: string
    model?: string
    reasoningEffort?: ReasoningEffort
    intent?: 'manual' | 'implementation_request'
    existingDraft?: {
      title: string
      categoryId: string
      template: {
        problem: string
        desiredOutcome: string
        userScenarios: string
        constraints?: string
        nonGoals?: string
        openQuestions?: string
      }
      rationale?: string
    }
  }>()

  const normalizedMessages = Array.isArray(messages)
    ? normalizeConversationMessages(messages)
    : []

  if (normalizedMessages.length === 0) {
    return c.json({ error: 'Conversation messages are required', code: 'INVALID_MESSAGES' }, 400)
  }

  const config = loadConfig()
  const auth = getAuthSession(c)
  let project

  try {
    project = requireAccessibleProjectById(config, auth, projectId)
  } catch (error: any) {
    return c.json(
      { error: error.message, code: error.message === 'Project access denied' ? 'PROJECT_FORBIDDEN' : 'UNKNOWN_PROJECT' },
      error.message === 'Project access denied' ? 403 : 400
    )
  }

  const permissionError = requireProjectPermission(c, project.id, 'requests')
  if (permissionError) {
    return permissionError
  }

  const prompt = buildConversationRequestDraftPrompt(
    normalizedMessages,
    project.id,
    config.flows.ticket.categories,
    intent === 'implementation_request' ? 'implementation_request' : 'manual',
    isExistingDraftContext(existingDraft) ? normalizeRequestDraftPayload(existingDraft) : undefined
  )

  try {
    const draftResult = await generateRequestDraft({
      prompt,
      projectPath: project.path,
      categories: config.flows.ticket.categories,
      explainFlow: config.flows.explain,
      model,
      reasoningEffort,
    })

    return c.json(draftResult)
  } catch (error: any) {
    return c.json(
      {
        error: error?.message || 'Request draft generation failed',
        code: 'REQUEST_DRAFT_FAILED',
      },
      502
    )
  }
})

chatRoutes.post('/chat/request-draft-runs', async (c) => {
  const { messages, projectId, model, reasoningEffort, intent, existingDraft, threadKey, scopeLabel, draft } = await c.req.json<{
    messages?: Array<{ role: 'user' | 'assistant'; content: string }>
    projectId?: string
    model?: string
    reasoningEffort?: ReasoningEffort
    intent?: 'manual' | 'implementation_request'
    existingDraft?: {
      title: string
      categoryId: string
      template: {
        problem: string
        desiredOutcome: string
        userScenarios: string
        constraints?: string
        nonGoals?: string
        openQuestions?: string
      }
      rationale?: string
    }
    threadKey?: string
    scopeLabel?: string
    draft?: ExplainRequestDraft
  }>()

  const normalizedMessages = Array.isArray(messages)
    ? messages
        .filter(isConversationMessage)
        .map((message) => ({
          role: message.role,
          content: message.content.trim(),
        }))
        .filter((message) => message.content)
    : []

  if (normalizedMessages.length === 0) {
    return c.json({ error: 'Conversation messages are required', code: 'INVALID_MESSAGES' }, 400)
  }

  if (!threadKey?.trim()) {
    return c.json({ error: 'Thread key is required', code: 'INVALID_THREAD' }, 400)
  }

  if (!draft || typeof draft.id !== 'string' || !draft.id.trim()) {
    return c.json({ error: 'Draft payload is required', code: 'INVALID_DRAFT' }, 400)
  }

  const config = loadConfig()
  const auth = getAuthSession(c)
  let project

  try {
    project = requireAccessibleProjectById(config, auth, projectId)
  } catch (error: any) {
    return c.json(
      { error: error.message, code: error.message === 'Project access denied' ? 'PROJECT_FORBIDDEN' : 'UNKNOWN_PROJECT' },
      error.message === 'Project access denied' ? 403 : 400
    )
  }

  const permissionError = requireProjectPermission(c, project.id, 'requests')
  if (permissionError) {
    return permissionError
  }

  const prompt = buildConversationRequestDraftPrompt(
    normalizedMessages,
    project.id,
    config.flows.ticket.categories,
    intent === 'implementation_request' ? 'implementation_request' : 'manual',
    isExistingDraftContext(existingDraft) ? normalizeRequestDraftPayload(existingDraft) : undefined
  )

  const started = queueBackgroundRun(
    auth,
    {
      projectId: project.id,
      kind: 'explain_request_draft',
      permission: 'requests',
      scopeType: 'explain_thread',
      scopeId: threadKey,
      scopeLabel: scopeLabel?.trim() || threadKey,
      messagePreview: normalizedMessages.at(-1)?.content ?? draft.title,
    },
    async (run) => {
      try {
        run.emitState('요청 초안 정리 중', '현재 대화를 request draft로 구조화하고 있습니다.')
        const draftResult = await generateRequestDraft({
          prompt,
          projectPath: project.path,
          categories: config.flows.ticket.categories,
          explainFlow: config.flows.explain,
          model,
          reasoningEffort,
          signal: run.signal,
        })

        saveUpdatedExplainThread(auth, project.id, threadKey, (thread) => ({
          ...thread,
          activeRunId: undefined,
          drafts: upsertDraft(thread.drafts, {
            ...draft,
            ...draftResult,
            status: 'draft',
            error: undefined,
            updatedAt: new Date().toISOString(),
          }),
          updatedAt: new Date().toISOString(),
        }))

        run.complete(
          {
            draftId: draft.id,
            draft: draftResult,
          },
          {
            latestLabel: '요청 초안 완료',
            latestDetail: undefined,
            result: draftResult,
          }
        )
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          const stopMessage = '요청 초안 생성이 중단되었습니다.'
          saveUpdatedExplainThread(auth, project.id, threadKey, (thread) => ({
            ...thread,
            activeRunId: undefined,
            drafts: upsertDraft(thread.drafts, {
              ...draft,
              status: 'error',
              error: stopMessage,
              updatedAt: new Date().toISOString(),
            }),
            updatedAt: new Date().toISOString(),
          }))

          run.stop(
            {
              draftId: draft.id,
              error: stopMessage,
            },
            {
              latestLabel: '요청 초안 중단됨',
              latestDetail: stopMessage,
            }
          )
          return
        }

        const messageText = error instanceof Error ? error.message : 'Request draft generation failed'
        saveUpdatedExplainThread(auth, project.id, threadKey, (thread) => ({
          ...thread,
          activeRunId: undefined,
          drafts: upsertDraft(thread.drafts, {
            ...draft,
            status: 'error',
            error: messageText,
            updatedAt: new Date().toISOString(),
          }),
          updatedAt: new Date().toISOString(),
        }))

        run.fail(messageText, { code: 'REQUEST_DRAFT_FAILED', draftId: draft.id }, {
          latestLabel: '요청 초안 생성 실패',
          latestDetail: messageText,
        })
      }
    }
  )

  if (!started.existing) {
    saveUpdatedExplainThread(auth, project.id, threadKey, (thread) => ({
      ...thread,
      activeRunId: started.run.id,
      drafts: upsertDraft(thread.drafts, {
        ...draft,
        status: 'drafting',
        error: undefined,
        updatedAt: new Date().toISOString(),
      }),
      updatedAt: new Date().toISOString(),
    }))
  }

  return c.json(started, 202)
})
