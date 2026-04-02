import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { getAuthSession, requireProjectPermission } from '../lib/auth.js'
import { loadConfig, type ReasoningEffort } from '../lib/config.js'
import { getModelCapability, resolveReasoningEffortForModel } from '../lib/model-capabilities.js'
import { requireAccessibleProjectById } from '../lib/projects.js'
import {
  queueBackgroundRun,
} from '../services/background-runs.js'
import { runCodexTurn, runRecoverableCodexTurn, type CodexRecoveryMode } from '../services/codex-sdk.js'
import {
  DEFAULT_DIRECT_AGENT_ROLE,
  loadDirectState,
  saveDirectState,
  type DirectAgentRole,
  type DirectMessageRecord,
  type DirectSessionState,
  type DirectState,
} from '../services/direct-state.js'

const DIRECT_AGENT_CONFIG = {
  plain: {
    promptFile: 'prompts/direct-plain.txt',
    sandboxMode: 'workspace-write',
  },
  prometheus: {
    promptFile: 'prompts/direct-prometheus.txt',
    sandboxMode: 'read-only',
  },
  hephaestus: {
    promptFile: 'prompts/direct-hephaestus.txt',
    sandboxMode: 'workspace-write',
  },
  sisyphus: {
    promptFile: 'prompts/direct-sisyphus.txt',
    sandboxMode: 'read-only',
  },
} as const

const DIRECT_ORCHESTRATOR_SUBAGENT_ROLES: DirectAgentRole[] = ['prometheus', 'hephaestus']
const MAX_DIRECT_SESSION_CONTEXT_MESSAGES = 12
const DIRECT_SESSION_RESTART_LABEL = '새 세션에서 이어가는 중'
const DIRECT_SESSION_RESTART_DETAIL =
  '이전 Codex 세션을 복구하지 못해 현재 Direct 대화 기록을 바탕으로 이어가고 있습니다.'
const DIRECT_SESSION_RESTART_NOTICE =
  '_참고: 이전 Codex 세션을 복구하지 못해 현재 Direct 대화 기록을 바탕으로 새 세션에서 이어갔습니다._'

interface DirectSessionContextMessage {
  role: 'user' | 'assistant'
  content: string
}

interface DirectAgentRunResult {
  agentRole: DirectAgentRole
  threadId: string | null
  sawEvent: boolean
  sawAssistantDelta: boolean
  finalResponse: string
  recoveryMode?: CodexRecoveryMode
  resumeFailureReason?: string
}

interface DirectSubagentSummary {
  agentRole: DirectAgentRole
  status: 'completed' | 'failed'
  finalResponse?: string
  error?: string
}

export const directRoutes = new Hono()
let runCodexTurnImpl: typeof runCodexTurn = runCodexTurn

export function setRunCodexTurnForDirectTesting(fn: typeof runCodexTurn) {
  runCodexTurnImpl = fn
}

export function resetRunCodexTurnForDirectTesting() {
  runCodexTurnImpl = runCodexTurn
}

function readString(value: unknown) {
  return typeof value === 'string' ? value : undefined
}

function directAgentLabel(role: DirectAgentRole) {
  if (role === 'plain') return 'Plain'
  if (role === 'sisyphus') return 'Sisyphus'
  if (role === 'hephaestus') return 'Hephaestus'
  return 'Prometheus'
}

function buildSubagentStatusDetail(results: DirectSubagentSummary[]) {
  return results.map((result) => `${directAgentLabel(result.agentRole)}:${result.status}`).join(' · ')
}

function normalizeSingleLine(value: string | undefined, fallback = '') {
  return (value ?? '').replace(/\s+/g, ' ').trim() || fallback
}

function normalizeDirectSessionMessages(value: unknown): DirectSessionContextMessage[] {
  if (!Array.isArray(value)) {
    return []
  }

  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') {
      return []
    }

    const role = 'role' in entry ? entry.role : undefined
    const content = 'content' in entry ? entry.content : undefined
    if ((role !== 'user' && role !== 'assistant') || typeof content !== 'string' || !content.trim()) {
      return []
    }

    return [
      {
        role,
        content: content.trim(),
      },
    ]
  })
}

function buildDirectSessionContext(messages: DirectSessionContextMessage[]) {
  const recentMessages = messages.slice(-MAX_DIRECT_SESSION_CONTEXT_MESSAGES)
  if (recentMessages.length === 0) {
    return 'No prior direct session context.'
  }

  return recentMessages
    .map((message) => `${message.role === 'user' ? 'User' : 'Assistant'}: ${message.content}`)
    .join('\n')
}

function buildDirectSessionResumePrompt(message: string, sessionMessages: DirectSessionContextMessage[]) {
  return [
    'Current direct session context:',
    buildDirectSessionContext(sessionMessages),
    '',
    'Latest user request:',
    message.trim(),
    '',
    'The previous Codex session could not be resumed.',
    'Continue from the existing direct session context instead of restarting from scratch.',
    'Respond in concise Korean and preserve continuity with prior implementation, decisions, and verification context.',
  ].join('\n')
}

function buildPrometheusSubagentPrompt(message: string, sessionMessages: DirectSessionContextMessage[]) {
  return [
    'Current direct session context:',
    buildDirectSessionContext(sessionMessages),
    '',
    'Latest user request:',
    message.trim(),
    '',
    'Continue from any existing plan in the session context instead of restarting.',
    'Return a concise Korean execution plan with scope, risks, and verification.',
  ].join('\n')
}

function buildHephaestusSubagentPrompt(message: string, sessionMessages: DirectSessionContextMessage[]) {
  return [
    'Current direct session context:',
    buildDirectSessionContext(sessionMessages),
    '',
    'Latest user request:',
    message.trim(),
    '',
    'Use any existing Prometheus plan in the session context as the execution baseline.',
    'Focus on the deepest blocker, implementation path, or concrete investigation result that moves the work forward.',
  ].join('\n')
}

function buildSisyphusOrchestrationPrompt(
  message: string,
  sessionMessages: DirectSessionContextMessage[],
  results: DirectSubagentSummary[]
) {
  const formattedResults = results
    .map((result) => {
      if (result.status === 'failed') {
        return `## ${directAgentLabel(result.agentRole)}\nStatus: failed\nError: ${result.error ?? 'Unknown error'}`
      }

      return `## ${directAgentLabel(result.agentRole)}\nStatus: completed\n${result.finalResponse?.trim() || '(no response text)'}`
    })
    .join('\n\n')

  return [
    'Current direct session context:',
    buildDirectSessionContext(sessionMessages),
    '',
    'User request:',
    message.trim(),
    '',
    'Parallel subagent results:',
    formattedResults,
    '',
    'Synthesize these findings into one concise Korean response.',
    'Preserve continuity with any existing plan from the session context, explain conflicts or risks, and recommend the single best next action.',
  ].join('\n')
}

function normalizeDirectAgentRole(value: unknown): DirectAgentRole {
  if (value === 'plain' || value === 'prometheus' || value === 'hephaestus' || value === 'sisyphus') {
    return value
  }

  if (value === 'atlas') {
    return 'plain'
  }

  return DEFAULT_DIRECT_AGENT_ROLE
}

function updateLastAssistantMessage(messages: DirectMessageRecord[], updater: (current: string) => string) {
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

  return '_응답이 비어 있습니다. 요청을 조금 더 구체적으로 적어 주세요._'
}

function appendDirectSessionRestartNotice(content: string) {
  const trimmed = content.trimEnd()

  if (!trimmed) {
    return DIRECT_SESSION_RESTART_NOTICE
  }

  if (trimmed.includes(DIRECT_SESSION_RESTART_NOTICE)) {
    return trimmed
  }

  return `${trimmed}\n\n${DIRECT_SESSION_RESTART_NOTICE}`
}

function markLastAssistantStopped(messages: DirectMessageRecord[], content?: string) {
  return updateLastAssistantMessage(messages, (current) => {
    const base = content?.trim() ? content : current.trim() ? current : '_응답이 중단되었습니다._'
    return base.includes('_응답이 중단되었습니다._') ? base : `${base}\n\n_응답이 중단되었습니다._`
  })
}

function appendAssistantError(messages: DirectMessageRecord[], message: string) {
  return updateLastAssistantMessage(messages, (current) =>
    current ? `${current}\n\n**Error**: ${message}` : `**Error**: ${message}`
  )
}

function applyDirectContinuityState(
  session: DirectSessionState,
  params: {
    sourceThreadId?: string
    recoveryMode: CodexRecoveryMode
    resumeFailureReason?: string
    updatedAt: string
  }
) {
  if (params.recoveryMode === 'rehydrated') {
    return {
      ...session,
      continuityMode: 'rehydrated' as const,
      lastRecoveryAt: params.updatedAt,
      lastRecoveryReason: params.resumeFailureReason ?? DIRECT_SESSION_RESTART_DETAIL,
    }
  }

  if (params.sourceThreadId) {
    return {
      ...session,
      continuityMode: 'native' as const,
      lastRecoveryAt: undefined,
      lastRecoveryReason: undefined,
    }
  }

  return session
}

function updateDirectSessionState(
  state: DirectState,
  sessionKey: string,
  updater: (session: DirectSessionState) => DirectSessionState
) {
  return {
    ...state,
    sessions: state.sessions.map((session) => (session.id === sessionKey ? updater(session) : session)),
  }
}

function saveUpdatedDirectSession(
  auth: ReturnType<typeof getAuthSession>,
  projectId: string,
  sessionKey: string,
  updater: (session: DirectSessionState) => DirectSessionState
) {
  const loaded = loadDirectState(auth, projectId)
  const target = loaded.state.sessions.find((session) => session.id === sessionKey)
  if (!target) {
    return undefined
  }

  return saveDirectState(auth, projectId, updateDirectSessionState(loaded.state, sessionKey, updater))
}

function resolveDirectRuntime(config: ReturnType<typeof loadConfig>, model?: string, reasoningEffort?: ReasoningEffort) {
  const selectedModel = getModelCapability(model?.trim() || config.flows.explain.model).id
  const selectedReasoningEffort = resolveReasoningEffortForModel(
    selectedModel,
    reasoningEffort ?? config.flows.explain.reasoningEffort
  )

  return {
    selectedModel,
    selectedReasoningEffort,
  }
}

directRoutes.get('/direct/state', (c) => {
  const auth = getAuthSession(c)
  const config = loadConfig()
  let project

  try {
    project = requireAccessibleProjectById(config, auth, c.req.query('projectId'))
  } catch (error: any) {
    return c.json(
      { error: error.message, code: error.message === 'Project access denied' ? 'PROJECT_FORBIDDEN' : 'UNKNOWN_PROJECT' },
      error.message === 'Project access denied' ? 403 : 400
    )
  }

  const permissionError = requireProjectPermission(c, project.id, 'direct')
  if (permissionError) {
    return permissionError
  }

  return c.json(loadDirectState(auth, project.id))
})

directRoutes.put('/direct/state', async (c) => {
  const auth = getAuthSession(c)
  const config = loadConfig()
  const { projectId, state } = await c.req.json<{
    projectId?: string
    state?: unknown
  }>()
  let project

  try {
    project = requireAccessibleProjectById(config, auth, projectId)
  } catch (error: any) {
    return c.json(
      { error: error.message, code: error.message === 'Project access denied' ? 'PROJECT_FORBIDDEN' : 'UNKNOWN_PROJECT' },
      error.message === 'Project access denied' ? 403 : 400
    )
  }

  const permissionError = requireProjectPermission(c, project.id, 'direct')
  if (permissionError) {
    return permissionError
  }

  try {
    return c.json(saveDirectState(auth, project.id, state))
  } catch (error: any) {
    return c.json({ error: error.message || 'Failed to save direct state' }, 400)
  }
})

directRoutes.post('/direct/chat', async (c) => {
  const { message, threadId, projectId, model, reasoningEffort, agentRole, sessionMessages } = await c.req.json<{
    message: string
    threadId?: string
    projectId?: string
    model?: string
    reasoningEffort?: ReasoningEffort
    agentRole?: DirectAgentRole
    sessionMessages?: unknown
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

  const permissionError = requireProjectPermission(c, project.id, 'direct')
  if (permissionError) {
    return permissionError
  }

  const { selectedModel, selectedReasoningEffort } = resolveDirectRuntime(config, model, reasoningEffort)
  const resolvedAgentRole = normalizeDirectAgentRole(agentRole)
  const normalizedSessionMessages = normalizeDirectSessionMessages(sessionMessages)

  return streamSSE(c, async (stream) => {
    let currentThreadId: string | null = threadId ?? null
    let streamAborted = false
    let settled = false
    let recoveryMode: CodexRecoveryMode = 'native'
    let resumeFailureReason: string | undefined
    const abortController = new AbortController()

    stream.onAbort(() => {
      streamAborted = true
      abortController.abort()
    })

    const writeState = async (label: string, detail?: string) => {
      if (streamAborted) {
        return
      }

      await stream.writeSSE({
        event: 'state',
        data: JSON.stringify({ label, detail }),
      })
    }

    const runRoleTurn = async ({
      role,
      prompt,
      activeThreadId,
      forwardEvents,
    }: {
      role: DirectAgentRole
      prompt: string
      activeThreadId?: string
      forwardEvents: boolean
    }): Promise<DirectAgentRunResult> => {
      const roleConfig = DIRECT_AGENT_CONFIG[role]
      let roleThreadId: string | null = activeThreadId ?? null
      let sawEvent = false
      let sawAssistantDelta = false

      const result = await runCodexTurnImpl({
        prompt,
        promptFile: roleConfig.promptFile,
        cwd: project.path,
        threadId: activeThreadId,
        model: selectedModel,
        reasoningEffort: selectedReasoningEffort,
        serviceTier: config.flows.explain.serviceTier,
        sandboxMode: roleConfig.sandboxMode,
        approvalPolicy: 'never',
        networkAccessEnabled: false,
        signal: abortController.signal,
        onEvent: async (event) => {
          sawEvent = true

          if (event.type === 'delta' && typeof event.data.text === 'string' && event.data.text.length > 0) {
            sawAssistantDelta = true
          }

          if (event.type === 'init' && typeof event.data.threadId === 'string') {
            roleThreadId = event.data.threadId
          }

          if (!forwardEvents || streamAborted) {
            return
          }

          await stream.writeSSE({
            event: event.type,
            data: JSON.stringify({
              ...event.data,
              agentRole: role,
            }),
          })
        },
      })

      if (result.threadId) {
        roleThreadId = result.threadId
      }

      return {
        agentRole: role,
        threadId: roleThreadId,
        sawEvent,
        sawAssistantDelta,
        finalResponse: result.finalResponse,
      }
    }

    const runRecoverableRoleTurn = async ({
      role,
      prompt,
      recoveryPrompt,
      activeThreadId,
      forwardEvents,
    }: {
      role: DirectAgentRole
      prompt: string
      recoveryPrompt?: string
      activeThreadId?: string
      forwardEvents: boolean
    }): Promise<DirectAgentRunResult> => {
      const roleConfig = DIRECT_AGENT_CONFIG[role]
      let roleThreadId: string | null = activeThreadId ?? null

      const result = await runRecoverableCodexTurn({
        prompt,
        recoveryStrategy: 'transcript',
        recoveryPrompt,
        recoveryLabel: DIRECT_SESSION_RESTART_LABEL,
        recoveryDetail: DIRECT_SESSION_RESTART_DETAIL,
        onRecoveryState: async (label, detail, reason) => {
          recoveryMode = 'rehydrated'
          resumeFailureReason = reason
          roleThreadId = null
          currentThreadId = null
          await writeState(label, detail)
        },
        promptFile: roleConfig.promptFile,
        cwd: project.path,
        threadId: activeThreadId,
        model: selectedModel,
        reasoningEffort: selectedReasoningEffort,
        serviceTier: config.flows.explain.serviceTier,
        sandboxMode: roleConfig.sandboxMode,
        approvalPolicy: 'never',
        networkAccessEnabled: false,
        signal: abortController.signal,
        runTurn: runCodexTurnImpl,
        onEvent: async (event) => {
          if (event.type === 'init' && typeof event.data.threadId === 'string') {
            roleThreadId = event.data.threadId
          }

          if (!forwardEvents || streamAborted) {
            return
          }

          await stream.writeSSE({
            event: event.type,
            data: JSON.stringify({
              ...event.data,
              agentRole: role,
            }),
          })
        },
      })

      recoveryMode = result.recoveryMode
      resumeFailureReason = result.resumeFailureReason

      if (result.threadId) {
        roleThreadId = result.threadId
      }

      if (roleThreadId) {
        currentThreadId = roleThreadId
      }

      return {
        agentRole: role,
        threadId: roleThreadId,
        sawEvent: true,
        sawAssistantDelta: result.hadAssistantDelta,
        finalResponse: result.finalResponse,
        recoveryMode: result.recoveryMode,
        resumeFailureReason: result.resumeFailureReason,
      }
    }

    const runSisyphusOrchestration = async () => {
      await writeState(
        'Sisyphus orchestration 시작',
        `${DIRECT_ORCHESTRATOR_SUBAGENT_ROLES.map((role) => directAgentLabel(role)).join(', ')}를 병렬 실행합니다.`
      )

      const orchestrationResults = await Promise.all(
        DIRECT_ORCHESTRATOR_SUBAGENT_ROLES.map(async (role): Promise<DirectSubagentSummary> => {
          try {
            const result = await runRoleTurn({
              role,
              prompt:
                role === 'prometheus'
                  ? buildPrometheusSubagentPrompt(message.trim(), normalizedSessionMessages)
                  : buildHephaestusSubagentPrompt(message.trim(), normalizedSessionMessages),
              forwardEvents: false,
            })

            return {
              agentRole: role,
              status: 'completed',
              finalResponse: result.finalResponse,
            }
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error'
            return {
              agentRole: role,
              status: 'failed',
              error: errorMessage,
            }
          }
        })
      )

      await writeState('병렬 subagent 실행 완료', buildSubagentStatusDetail(orchestrationResults))

      const successfulResults = orchestrationResults.filter((result) => result.status === 'completed')
      if (successfulResults.length === 0) {
        throw new Error('All Direct subagent runs failed')
      }

      await writeState('Sisyphus 결과 통합 중', '병렬 실행 결과를 메인 응답으로 정리하고 있습니다.')

      const orchestrationPrompt = buildSisyphusOrchestrationPrompt(message.trim(), normalizedSessionMessages, orchestrationResults)
      const completedRun = await runRecoverableRoleTurn({
        role: 'sisyphus',
        prompt: orchestrationPrompt,
        recoveryPrompt: orchestrationPrompt,
        activeThreadId: threadId,
        forwardEvents: true,
      })

      return {
        completedRun,
        orchestrationResults,
      }
    }

    try {
      if (resolvedAgentRole === 'sisyphus') {
        const { completedRun, orchestrationResults } = await runSisyphusOrchestration()
        const finalResponseWithRestartNotice = completedRun.recoveryMode === 'rehydrated'
          ? appendDirectSessionRestartNotice(completedRun.finalResponse)
          : completedRun.finalResponse

        if (!streamAborted && completedRun) {
          await stream.writeSSE({
            event: 'done',
            data: JSON.stringify({
              threadId: currentThreadId,
              finalResponse: finalResponseWithRestartNotice,
              hadAssistantDelta: completedRun.sawAssistantDelta,
              recoveryMode: completedRun.recoveryMode,
              resumeFailureReason: completedRun.resumeFailureReason,
              subagentResults: orchestrationResults,
            }),
          })
        }

        settled = true
        return
      }

      const completedRun = await runRecoverableRoleTurn({
        role: resolvedAgentRole,
        prompt: message.trim(),
        recoveryPrompt: buildDirectSessionResumePrompt(message.trim(), normalizedSessionMessages),
        activeThreadId: threadId,
        forwardEvents: true,
      })
      const finalResponseWithRestartNotice = completedRun.recoveryMode === 'rehydrated'
        ? appendDirectSessionRestartNotice(completedRun.finalResponse)
        : completedRun.finalResponse

      if (!streamAborted) {
        await stream.writeSSE({
          event: 'done',
          data: JSON.stringify({
            threadId: currentThreadId,
            finalResponse: finalResponseWithRestartNotice,
            hadAssistantDelta: completedRun.sawAssistantDelta,
            recoveryMode: completedRun.recoveryMode,
            resumeFailureReason: completedRun.resumeFailureReason,
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

directRoutes.post('/direct/runs', async (c) => {
  const {
    message,
    threadId,
    projectId,
    model,
    reasoningEffort,
    agentRole,
    sessionMessages,
    sessionId,
    scopeLabel,
    messages,
  } = await c.req.json<{
    message: string
    threadId?: string
    projectId?: string
    model?: string
    reasoningEffort?: ReasoningEffort
    agentRole?: DirectAgentRole
    sessionMessages?: unknown
    sessionId?: string
    scopeLabel?: string
    messages?: unknown
  }>()

  if (!message?.trim()) {
    return c.json({ error: 'Message is required', code: 'INVALID_MESSAGE' }, 400)
  }

  if (!sessionId?.trim()) {
    return c.json({ error: 'Session id is required', code: 'INVALID_SESSION' }, 400)
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

  const permissionError = requireProjectPermission(c, project.id, 'direct')
  if (permissionError) {
    return permissionError
  }

  const { selectedModel, selectedReasoningEffort } = resolveDirectRuntime(config, model, reasoningEffort)
  const resolvedAgentRole = normalizeDirectAgentRole(agentRole)
  const normalizedSessionMessages = normalizeDirectSessionMessages(sessionMessages)

  const started = queueBackgroundRun(
    auth,
    {
      projectId: project.id,
      kind: 'direct_reply',
      permission: 'direct',
      scopeType: 'direct_session',
      scopeId: sessionId,
      scopeLabel: scopeLabel?.trim() || sessionId,
      messagePreview: message.trim(),
    },
    async (run) => {
      let currentThreadId: string | null = threadId ?? null
      let streamedAssistantText = ''
      let sawAssistantDelta = false
      let phase: string | null = null
      let recoveryMode: CodexRecoveryMode = 'native'
      let resumeFailureReason: string | undefined
      let recoveredSession = false

      const setPhase = (nextPhase: string, label: string, detail?: string) => {
        if (phase === nextPhase) {
          return
        }

        phase = nextPhase
        run.emitState(label, detail)
      }

      const runRoleTurn = async ({
        role,
        prompt,
        activeThreadId,
        forwardEvents,
      }: {
        role: DirectAgentRole
        prompt: string
        activeThreadId?: string
        forwardEvents: boolean
      }): Promise<DirectAgentRunResult> => {
        const roleConfig = DIRECT_AGENT_CONFIG[role]
        let roleThreadId: string | null = activeThreadId ?? null
        let sawEvent = false
        let roleSawAssistantDelta = false

        const result = await runCodexTurnImpl({
          prompt,
          promptFile: roleConfig.promptFile,
          cwd: project.path,
          threadId: activeThreadId,
          model: selectedModel,
          reasoningEffort: selectedReasoningEffort,
          serviceTier: config.flows.explain.serviceTier,
          sandboxMode: roleConfig.sandboxMode,
          approvalPolicy: 'never',
          networkAccessEnabled: false,
          signal: run.signal,
          onEvent: async (event) => {
            sawEvent = true

            if (event.type === 'init' && typeof event.data.threadId === 'string') {
              roleThreadId = event.data.threadId
              return
            }

            if (event.type === 'delta' && typeof event.data.text === 'string' && event.data.text.length > 0) {
              roleSawAssistantDelta = true
              if (forwardEvents) {
                streamedAssistantText += event.data.text
                sawAssistantDelta = true
                setPhase('answering', '작업 진행 중', '변경 내용을 정리하고 있습니다.')
              }
            }

            if (event.type === 'tool_use' && typeof event.data.tool === 'string') {
              setPhase('tool', `${event.data.tool} 실행 중`, '작업에 필요한 도구를 실행하고 있습니다.')
            }

            if (event.type === 'tool_result' && typeof event.data.tool === 'string') {
              setPhase('waiting', '응답 정리 중', `${event.data.tool} 실행 결과를 정리하고 있습니다.`)
            }

            if (!forwardEvents || event.type === 'init') {
              return
            }

            run.emitEvent({
              type: event.type,
              data: {
                ...event.data,
                agentRole: role,
              },
              createdAt: new Date().toISOString(),
            })
          },
        })

        if (result.threadId) {
          roleThreadId = result.threadId
        }

        return {
          agentRole: role,
          threadId: roleThreadId,
          sawEvent,
          sawAssistantDelta: roleSawAssistantDelta,
          finalResponse: result.finalResponse,
        }
      }

      const runRecoverableRoleTurn = async ({
        role,
        prompt,
        recoveryPrompt,
        activeThreadId,
        forwardEvents,
      }: {
        role: DirectAgentRole
        prompt: string
        recoveryPrompt?: string
        activeThreadId?: string
        forwardEvents: boolean
      }): Promise<DirectAgentRunResult> => {
        const roleConfig = DIRECT_AGENT_CONFIG[role]
        let roleThreadId: string | null = activeThreadId ?? null

        const result = await runRecoverableCodexTurn({
          prompt,
          recoveryStrategy: 'transcript',
          recoveryPrompt,
          recoveryLabel: DIRECT_SESSION_RESTART_LABEL,
          recoveryDetail: DIRECT_SESSION_RESTART_DETAIL,
          onRecoveryState: (label, detail, reason) => {
            recoveryMode = 'rehydrated'
            resumeFailureReason = reason
            recoveredSession = true
            roleThreadId = null
            currentThreadId = null
            setPhase('fallback', label, detail)
          },
          promptFile: roleConfig.promptFile,
          cwd: project.path,
          threadId: activeThreadId,
          model: selectedModel,
          reasoningEffort: selectedReasoningEffort,
          serviceTier: config.flows.explain.serviceTier,
          sandboxMode: roleConfig.sandboxMode,
          approvalPolicy: 'never',
          networkAccessEnabled: false,
          signal: run.signal,
          runTurn: runCodexTurnImpl,
          onEvent: async (event) => {
            if (event.type === 'init' && typeof event.data.threadId === 'string') {
              roleThreadId = event.data.threadId
              return
            }

            if (event.type === 'delta' && typeof event.data.text === 'string' && event.data.text.length > 0) {
              if (forwardEvents) {
                streamedAssistantText += event.data.text
                sawAssistantDelta = true
                setPhase('answering', '작업 진행 중', '변경 내용을 정리하고 있습니다.')
              }
            }

            if (event.type === 'tool_use' && typeof event.data.tool === 'string') {
              setPhase('tool', `${event.data.tool} 실행 중`, '작업에 필요한 도구를 실행하고 있습니다.')
            }

            if (event.type === 'tool_result' && typeof event.data.tool === 'string') {
              setPhase('waiting', '응답 정리 중', `${event.data.tool} 실행 결과를 정리하고 있습니다.`)
            }

            if (!forwardEvents || event.type === 'init') {
              return
            }

            run.emitEvent({
              type: event.type,
              data: {
                ...event.data,
                agentRole: role,
              },
              createdAt: new Date().toISOString(),
            })
          },
        })

        recoveryMode = result.recoveryMode
        resumeFailureReason = result.resumeFailureReason
        recoveredSession = result.recoveryMode === 'rehydrated'

        if (result.threadId) {
          roleThreadId = result.threadId
        }

        if (roleThreadId) {
          currentThreadId = roleThreadId
        }

        return {
          agentRole: role,
          threadId: roleThreadId,
          sawEvent: true,
          sawAssistantDelta: result.hadAssistantDelta,
          finalResponse: result.finalResponse,
          recoveryMode: result.recoveryMode,
          resumeFailureReason: result.resumeFailureReason,
        }
      }

      try {
        setPhase('submitting', '개발 요청 전송 중', 'Codex에 직접 개발 요청을 전달하고 있습니다.')

        if (resolvedAgentRole === 'sisyphus') {
          setPhase(
            'tool',
            'Sisyphus orchestration 시작',
            `${DIRECT_ORCHESTRATOR_SUBAGENT_ROLES.map((role) => directAgentLabel(role)).join(', ')}를 병렬 실행합니다.`
          )

          const orchestrationResults = await Promise.all(
            DIRECT_ORCHESTRATOR_SUBAGENT_ROLES.map(async (role): Promise<DirectSubagentSummary> => {
              try {
                const result = await runRoleTurn({
                  role,
                  prompt:
                    role === 'prometheus'
                      ? buildPrometheusSubagentPrompt(message.trim(), normalizedSessionMessages)
                      : buildHephaestusSubagentPrompt(message.trim(), normalizedSessionMessages),
                  forwardEvents: false,
                })

                return {
                  agentRole: role,
                  status: 'completed',
                  finalResponse: result.finalResponse,
                }
              } catch (error) {
                return {
                  agentRole: role,
                  status: 'failed',
                  error: error instanceof Error ? error.message : 'Unknown error',
                }
              }
            })
          )

          setPhase('waiting', '병렬 subagent 실행 완료', buildSubagentStatusDetail(orchestrationResults))

          const successfulResults = orchestrationResults.filter((result) => result.status === 'completed')
          if (successfulResults.length === 0) {
            throw new Error('All Direct subagent runs failed')
          }

          const orchestrationPrompt = buildSisyphusOrchestrationPrompt(message.trim(), normalizedSessionMessages, orchestrationResults)
          const completedRun = await runRecoverableRoleTurn({
            role: 'sisyphus',
            prompt: orchestrationPrompt,
            recoveryPrompt: orchestrationPrompt,
            activeThreadId: threadId,
            forwardEvents: true,
          })

          const finalResponse = resolveCompletedAssistantContent(streamedAssistantText, completedRun.finalResponse)
          const finalResponseWithRestartNotice = completedRun.recoveryMode === 'rehydrated'
            ? appendDirectSessionRestartNotice(finalResponse)
            : finalResponse
          const updatedAt = new Date().toISOString()
          saveUpdatedDirectSession(auth, project.id, sessionId, (session) => ({
            ...applyDirectContinuityState(session, {
              sourceThreadId: threadId,
              recoveryMode: completedRun.recoveryMode ?? recoveryMode,
              resumeFailureReason: completedRun.resumeFailureReason ?? resumeFailureReason,
              updatedAt,
            }),
            threadId: currentThreadId ?? undefined,
            activeRunId: undefined,
            messages: updateLastAssistantMessage(session.messages, () => finalResponseWithRestartNotice),
            updatedAt,
          }))

          run.complete(
            {
              threadId: currentThreadId,
              finalResponse: finalResponseWithRestartNotice,
              hadAssistantDelta: sawAssistantDelta,
              recoveryMode: completedRun.recoveryMode,
              resumeFailureReason: completedRun.resumeFailureReason,
              subagentResults: orchestrationResults,
            },
            {
              latestLabel: 'Direct 작업 완료',
              latestDetail: undefined,
            }
          )
          return
        }

        const completedRun = await runRecoverableRoleTurn({
          role: resolvedAgentRole,
          prompt: message.trim(),
          recoveryPrompt: buildDirectSessionResumePrompt(message.trim(), normalizedSessionMessages),
          activeThreadId: threadId,
          forwardEvents: true,
        })

        const finalResponse = resolveCompletedAssistantContent(streamedAssistantText, completedRun.finalResponse)
        const finalResponseWithRestartNotice = completedRun.recoveryMode === 'rehydrated'
          ? appendDirectSessionRestartNotice(finalResponse)
          : finalResponse
        const updatedAt = new Date().toISOString()
        saveUpdatedDirectSession(auth, project.id, sessionId, (session) => ({
          ...applyDirectContinuityState(session, {
            sourceThreadId: threadId,
            recoveryMode: completedRun.recoveryMode ?? recoveryMode,
            resumeFailureReason: completedRun.resumeFailureReason ?? resumeFailureReason,
            updatedAt,
          }),
          threadId: currentThreadId ?? undefined,
          activeRunId: undefined,
          messages: updateLastAssistantMessage(session.messages, () => finalResponseWithRestartNotice),
          updatedAt,
        }))

        run.complete(
          {
            threadId: currentThreadId,
            finalResponse: finalResponseWithRestartNotice,
            hadAssistantDelta: sawAssistantDelta,
            recoveryMode: completedRun.recoveryMode,
            resumeFailureReason: completedRun.resumeFailureReason,
          },
          {
            latestLabel: 'Direct 작업 완료',
            latestDetail: undefined,
          }
        )
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          const stoppedContent = streamedAssistantText.trim() ? streamedAssistantText : undefined
          const stoppedContentWithRestartNotice =
            recoveredSession && stoppedContent ? appendDirectSessionRestartNotice(stoppedContent) : stoppedContent
          const updatedAt = new Date().toISOString()
          saveUpdatedDirectSession(auth, project.id, sessionId, (session) => ({
            ...applyDirectContinuityState(session, {
              sourceThreadId: threadId,
              recoveryMode,
              resumeFailureReason,
              updatedAt,
            }),
            threadId: currentThreadId ?? undefined,
            activeRunId: undefined,
            messages: markLastAssistantStopped(session.messages, stoppedContentWithRestartNotice),
            updatedAt,
          }))

          run.stop(
            {
              threadId: currentThreadId,
              finalResponse: stoppedContentWithRestartNotice,
              hadAssistantDelta: sawAssistantDelta,
              recoveryMode,
              resumeFailureReason,
            },
            {
              latestLabel: 'Direct 작업 중단됨',
              latestDetail: '사용자 요청으로 작업을 중단했습니다.',
            }
          )
          return
        }

        const messageText = error instanceof Error ? error.message : 'Direct background run failed'
        const updatedAt = new Date().toISOString()
        saveUpdatedDirectSession(auth, project.id, sessionId, (session) => ({
          ...applyDirectContinuityState(session, {
            sourceThreadId: threadId,
            recoveryMode,
            resumeFailureReason,
            updatedAt,
          }),
          threadId: currentThreadId ?? undefined,
          activeRunId: undefined,
          messages: appendAssistantError(session.messages, messageText),
          updatedAt,
        }))

        run.fail(messageText, { code: 'CODEX_BRIDGE_ERROR' }, {
          latestLabel: 'Direct 작업 실패',
          latestDetail: messageText,
        })
      }
    }
  )

  if (!started.existing) {
    saveUpdatedDirectSession(auth, project.id, sessionId, (session) => ({
      ...session,
      threadId: readString(threadId) ?? session.threadId,
      activeRunId: started.run.id,
      messages: Array.isArray(messages) ? (messages as DirectMessageRecord[]) : session.messages,
      updatedAt: new Date().toISOString(),
    }))
  }

  return c.json(started, 202)
})
