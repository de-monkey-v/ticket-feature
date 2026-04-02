import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { AppConfig, BackgroundRunStatus } from '../lib/api'
import { startDirectBackgroundRun, stopBackgroundRun, updateExplainSettings } from '../lib/api'
import { buildNextExplainMessages, type ChatMessageRecord } from '../lib/chat-session'
import {
  DEFAULT_DIRECT_AGENT_ROLE,
  DIRECT_AGENT_ROLE_TABS,
  getDirectAgentDescriptor,
  getAdjacentDirectAgentRoles,
  getCycledDirectAgentRole,
  selectDirectSessionState,
  updateDirectSessionState,
  type DirectAgentRole,
  type DirectState,
} from '../lib/direct-state'
import { useSSE } from '../hooks/useSSE'
import { ChatMessage } from './ChatMessage'
import { WorkspaceHeader } from './WorkspaceHeader'
import { resolveCompletedAssistantContent } from './ChatView'

type Message = ChatMessageRecord
type StreamPhase = 'idle' | 'submitting' | 'waiting' | 'tool' | 'answering' | 'stopping' | 'stopped' | 'error'

interface DirectViewProps {
  projectId: string
  directState: DirectState | null
  selectedDirectSessionId: string
  isStateLoading: boolean
  composerFocusToken: number
  config: AppConfig
  onDirectStateChange: (state: DirectState, options?: { immediate?: boolean }) => void
  onConfigUpdated: () => Promise<void>
  onProjectChange: (projectId: string) => void
}

interface StreamStatus {
  phase: StreamPhase
  label: string
  detail?: string
  startedAt?: number
  updatedAt: number
}

interface EditSession {
  messageId: string
  previousInput: string
}

function directRoleBadgeClassName(role: DirectAgentRole) {
  if (role === 'plain') {
    return 'border-zinc-700 bg-zinc-900/70 text-zinc-100'
  }

  if (role === 'sisyphus') {
    return 'border-sky-900/70 bg-sky-950/30 text-sky-100'
  }

  if (role === 'hephaestus') {
    return 'border-amber-900/70 bg-amber-950/30 text-amber-100'
  }

  if (role === 'prometheus') {
    return 'border-violet-900/70 bg-violet-950/30 text-violet-100'
  }

  return 'border-emerald-900/70 bg-emerald-950/30 text-emerald-100'
}

function directRoleTabClassName(role: DirectAgentRole, isActive: boolean) {
  if (!isActive) {
    return 'border border-transparent text-zinc-400 hover:border-zinc-800 hover:bg-zinc-900 hover:text-zinc-100'
  }

  return `border ${directRoleBadgeClassName(role)}`
}

function directRoleActionClassName(role: DirectAgentRole) {
  return `border ${directRoleBadgeClassName(role)} hover:bg-zinc-950/70`
}

export function resolveDirectModelSelection(params: {
  availableModels: AppConfig['explain']['availableModels']
  currentReasoningEffort: AppConfig['explain']['selectedReasoningEffort']
  nextModel: string
}) {
  const nextCapability =
    params.availableModels.find((entry) => entry.id === params.nextModel) ?? params.availableModels[0]

  return {
    nextModel: nextCapability?.id ?? params.nextModel,
    nextReasoningEffort: nextCapability?.supportedReasoningEfforts.includes(params.currentReasoningEffort)
      ? params.currentReasoningEffort
      : nextCapability?.defaultReasoningEffort ?? params.currentReasoningEffort,
  }
}

function createIdleStreamStatus(): StreamStatus {
  return {
    phase: 'idle',
    label: '대기 중',
    updatedAt: Date.now(),
  }
}

function isActiveBackgroundRunStatus(status: BackgroundRunStatus | undefined) {
  return status === 'queued' || status === 'running' || status === 'stopping'
}

function formatElapsed(ms: number) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return minutes === 0 ? `${seconds}s` : `${minutes}m ${seconds}s`
}

function describeToolActivity(tool: string, error?: string) {
  return {
    label: error ? `${tool} 실패` : tool ? `${tool} 실행 중` : '도구 실행 중',
    detail: error ?? '작업에 필요한 도구를 실행하고 있습니다.',
  }
}

function updateLastAssistantMessage(messages: Message[], updater: (current: string) => string) {
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

function markLastAssistantStopped(messages: Message[]) {
  return updateLastAssistantMessage(messages, (current) =>
    current ? `${current}\n\n_응답이 중단되었습니다._` : '_응답이 중단되었습니다._'
  )
}

export function resolveDirectStateSyncAction(params: {
  projectId: string
  syncedProjectId?: string
  hasDirectState: boolean
  isStateLoading: boolean
}) {
  const { projectId, syncedProjectId, hasDirectState, isStateLoading } = params

  if (!projectId) {
    return 'reset'
  }

  if (syncedProjectId !== projectId) {
    return !isStateLoading && hasDirectState ? 'hydrate' : 'reset'
  }

  return 'preserve'
}

export function resolveDirectComposerRoleShortcut(params: {
  key: string
  shiftKey: boolean
  isStreaming: boolean
  isComposerDisabled: boolean
  selectedAgentRole: DirectAgentRole
}) {
  if (params.key !== 'Tab' || params.isStreaming || params.isComposerDisabled) {
    return null
  }

  return getCycledDirectAgentRole(params.selectedAgentRole, params.shiftKey ? 'backward' : 'forward')
}

export function DirectView({
  projectId,
  directState,
  selectedDirectSessionId,
  isStateLoading,
  composerFocusToken,
  config,
  onDirectStateChange,
  onConfigUpdated,
  onProjectChange,
}: DirectViewProps) {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  const [activeRunId, setActiveRunId] = useState<string | undefined>()
  const [threadId, setThreadId] = useState<string | undefined>()
  const [model, setModel] = useState(config.explain.selectedModel)
  const [reasoningEffort, setReasoningEffort] = useState(config.explain.selectedReasoningEffort)
  const [streamStatus, setStreamStatus] = useState<StreamStatus>(() => createIdleStreamStatus())
  const [editingSession, setEditingSession] = useState<EditSession | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const skipNextPersistRef = useRef(true)
  const activeSessionKeyRef = useRef('')
  const threadIdRef = useRef<string | undefined>(undefined)
  const currentRunIdRef = useRef<string | undefined>(undefined)
  const connectedRunIdRef = useRef<string | undefined>(undefined)
  const syncedProjectIdRef = useRef<string | undefined>(undefined)
  const activeStreamSessionRef = useRef(0)
  const bottomRef = useRef<HTMLDivElement>(null)
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const { startEventStream, abort } = useSSE()
  const selectedModelCapability =
    config.explain.availableModels.find((entry) => entry.id === model) ?? config.explain.availableModels[0]
  const canManageExplainSettings = config.auth.session.isAdmin
  const selectedSession =
    directState?.sessions.find((session) => session.id === (selectedDirectSessionId || directState.selectedSessionId)) ?? null
  const selectedAgentRole = selectedSession?.agentRole ?? DEFAULT_DIRECT_AGENT_ROLE
  const selectedAgentDescriptor = getDirectAgentDescriptor(selectedAgentRole)
  const { previous: previousAgentRole, next: nextAgentRole } = getAdjacentDirectAgentRoles(selectedAgentRole)
  const previousAgentDescriptor = previousAgentRole ? getDirectAgentDescriptor(previousAgentRole) : null
  const nextAgentDescriptor = nextAgentRole ? getDirectAgentDescriptor(nextAgentRole) : null
  const hasActiveSession = Boolean(
    directState &&
      directState.sessions.some((session) => session.id === (selectedDirectSessionId || directState.selectedSessionId))
  )
  const isComposerDisabled = !projectId || isStateLoading || !hasActiveSession
  const continuityNotice =
    selectedSession?.continuityMode === 'rehydrated'
      ? selectedSession.lastRecoveryReason ?? '이전 Codex 세션을 복구하지 못해 현재 Direct 대화 기록을 바탕으로 새 세션에서 이어가고 있습니다.'
      : undefined

  const focusComposer = () => {
    if (!composerRef.current || composerRef.current.disabled) {
      return
    }

    composerRef.current.focus()
    const cursor = composerRef.current.value.length
    composerRef.current.setSelectionRange(cursor, cursor)
  }

  useEffect(() => {
    const action = resolveDirectStateSyncAction({
      projectId,
      syncedProjectId: syncedProjectIdRef.current,
      hasDirectState: Boolean(directState),
      isStateLoading,
    })

    if (action === 'reset') {
      skipNextPersistRef.current = true
      activeStreamSessionRef.current += 1
      abort({ silent: true })
      activeSessionKeyRef.current = ''
      currentRunIdRef.current = undefined
      connectedRunIdRef.current = undefined
      setMessages([])
      setInput('')
      setIsStreaming(false)
      setActiveRunId(undefined)
      setThreadId(undefined)
      threadIdRef.current = undefined
      setEditingSession(null)
      setNow(Date.now())
      setStreamStatus(createIdleStreamStatus())
      if (!projectId) {
        syncedProjectIdRef.current = undefined
      }
      return
    }

    if (!directState) {
      return
    }

    const nextState = selectDirectSessionState(directState, selectedDirectSessionId)
    const selectedSession =
      nextState.sessions.find((session) => session.id === nextState.selectedSessionId) ??
      nextState.sessions[0]

    if (nextState !== directState) {
      onDirectStateChange(nextState, { immediate: true })
    }

    const nextSessionKey = selectedSession?.id ?? ''
    const nextMessages = selectedSession?.messages ?? []
    const nextThreadId = selectedSession?.threadId
    const nextActiveRunId = selectedSession?.activeRunId
    const contextChanged = syncedProjectIdRef.current !== projectId || activeSessionKeyRef.current !== nextSessionKey || action === 'hydrate'

    if (!selectedSession) {
      if (contextChanged) {
        activeStreamSessionRef.current += 1
        abort({ silent: true })
      }

      skipNextPersistRef.current = true
      activeSessionKeyRef.current = ''
      currentRunIdRef.current = undefined
      connectedRunIdRef.current = undefined
      setMessages([])
      setActiveRunId(undefined)
      setThreadId(undefined)
      threadIdRef.current = undefined
      setInput('')
      setIsStreaming(false)
      setEditingSession(null)
      setNow(Date.now())
      setStreamStatus(createIdleStreamStatus())
      syncedProjectIdRef.current = projectId
      return
    }

    if (!contextChanged && nextMessages === messages && nextThreadId === threadId) {
      return
    }

    skipNextPersistRef.current = true

    if (contextChanged) {
      activeStreamSessionRef.current += 1
      abort({ silent: true })
    }

    activeSessionKeyRef.current = nextSessionKey
    currentRunIdRef.current = nextActiveRunId
    connectedRunIdRef.current = undefined
    setMessages(nextMessages)
    setActiveRunId(nextActiveRunId)
    setThreadId(nextThreadId)
    threadIdRef.current = nextThreadId

    if (contextChanged) {
      setInput('')
      setIsStreaming(false)
      setEditingSession(null)
      setNow(Date.now())
      setStreamStatus(createIdleStreamStatus())
    }

    syncedProjectIdRef.current = projectId
  }, [abort, directState, isStateLoading, onDirectStateChange, projectId, selectedDirectSessionId])

  useEffect(() => {
    return () => {
      abort({ silent: true })
    }
  }, [abort])

  useEffect(() => {
    setModel(config.explain.selectedModel)
    setReasoningEffort(config.explain.selectedReasoningEffort)
  }, [config.explain.selectedModel, config.explain.selectedReasoningEffort])

  useEffect(() => {
    if (!selectedModelCapability) {
      return
    }

    if (!selectedModelCapability.supportedReasoningEfforts.includes(reasoningEffort)) {
      setReasoningEffort(selectedModelCapability.defaultReasoningEffort)
    }
  }, [reasoningEffort, selectedModelCapability])

  useEffect(() => {
    threadIdRef.current = threadId
  }, [threadId])

  useEffect(() => {
    currentRunIdRef.current = activeRunId
  }, [activeRunId])

  useEffect(() => {
    if (skipNextPersistRef.current) {
      skipNextPersistRef.current = false
      return
    }

    const currentSessionKey = activeSessionKeyRef.current
    if (!currentSessionKey || !directState) {
      return
    }

    const currentSession = directState.sessions.find((session) => session.id === currentSessionKey)
    if (!currentSession) {
      return
    }

    if (currentSession.threadId === threadId && currentSession.messages === messages) {
      return
    }

    const updatedAt = new Date().toISOString()
    const nextState = updateDirectSessionState(directState, currentSessionKey, (session) => ({
      ...session,
      activeRunId,
      threadId,
      messages,
      updatedAt,
    }))

    onDirectStateChange(nextState, activeRunId ? undefined : { immediate: true })
  }, [activeRunId, directState, messages, onDirectStateChange, threadId])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, streamStatus.phase])

  useEffect(() => {
    if (!isStreaming) {
      return
    }

    setNow(Date.now())
    const timer = window.setInterval(() => {
      setNow(Date.now())
    }, 1000)

    return () => {
      window.clearInterval(timer)
    }
  }, [isStreaming])

  useEffect(() => {
    if (!editingSession) {
      return
    }

    focusComposer()
  }, [editingSession, input])

  useEffect(() => {
    if (composerFocusToken === 0) {
      return
    }

    focusComposer()
  }, [composerFocusToken])

  const connectToBackgroundRun = async (runId: string, sessionKey: string) => {
    const streamSessionId = activeStreamSessionRef.current + 1
    activeStreamSessionRef.current = streamSessionId
    connectedRunIdRef.current = runId
    syncRunActivity(runId, 'running')

    const isCurrentStream = () =>
      activeStreamSessionRef.current === streamSessionId &&
      activeSessionKeyRef.current === sessionKey &&
      currentRunIdRef.current === runId

    await startEventStream(`/api/background-runs/${encodeURIComponent(runId)}/events`, {
      onInit: (data) => {
        if (!isCurrentStream()) {
          return
        }

        const run =
          data && typeof data.run === 'object' && data.run !== null
            ? (data.run as {
                status?: BackgroundRunStatus
                latestLabel?: string
                latestDetail?: string
              })
            : undefined

        syncRunActivity(runId, run?.status)
        if (run?.status === 'stopping') {
          updateStreamStatus('stopping', run.latestLabel ?? '중단 요청 중', run.latestDetail)
          return
        }

        updateStreamStatus('waiting', run?.latestLabel ?? '작업 준비 중', run?.latestDetail)
      },
      onState: (data) => {
        if (!isCurrentStream()) {
          return
        }

        const label = typeof data.label === 'string' ? data.label : '작업 진행 중'
        const detail = typeof data.detail === 'string' ? data.detail : undefined

        if (label.includes('중단')) {
          updateStreamStatus('stopping', label, detail)
          return
        }

        updateStreamStatus('waiting', label, detail)
      },
      onDelta: (data) => {
        if (!isCurrentStream() || !data.text) {
          return
        }

        setMessages((prev) => updateLastAssistantMessage(prev, (current) => current + data.text))
        updateStreamStatus('answering', '작업 진행 중', '변경 내용을 정리하고 있습니다.')
      },
      onToolUse: (data) => {
        if (!isCurrentStream()) {
          return
        }

        const toolActivity = describeToolActivity(data.tool)
        updateStreamStatus('tool', toolActivity.label, toolActivity.detail)
      },
      onToolResult: (data) => {
        if (!isCurrentStream()) {
          return
        }

        const toolActivity = describeToolActivity(data.tool, data.error)
        updateStreamStatus(
          'waiting',
          data.error ? toolActivity.label : '응답 정리 중',
          data.error ? toolActivity.detail : `${data.tool} 실행이 끝나 결과를 정리하고 있습니다.`
        )
      },
      onDone: (data) => {
        if (!isCurrentStream()) {
          return
        }

        syncRunActivity(undefined, data.status === 'stopped' ? 'stopped' : 'completed')

        if (typeof data.threadId === 'string') {
          threadIdRef.current = data.threadId
          setThreadId(data.threadId)
        }

        if (data.status === 'stopped') {
          setMessages((prev) =>
            markLastAssistantStopped(
              updateLastAssistantMessage(prev, (current) =>
                resolveCompletedAssistantContent(
                  current,
                  typeof data.finalResponse === 'string' ? data.finalResponse : undefined
                )
              )
            )
          )
          updateStreamStatus('stopped', '작업 중단됨', '요청을 수정해서 다시 보낼 수 있습니다.')
          return
        }

        setMessages((prev) =>
          updateLastAssistantMessage(prev, (current) =>
            resolveCompletedAssistantContent(current, typeof data.finalResponse === 'string' ? data.finalResponse : undefined)
          )
        )

        const resolvedFinalResponse = typeof data.finalResponse === 'string' ? data.finalResponse.trim() : ''
        if (!resolvedFinalResponse && !data.hadAssistantDelta) {
          updateStreamStatus('error', '응답 내용이 비어 있습니다', 'Codex가 표시할 텍스트 없이 종료되었습니다. 요청을 조금 더 구체적으로 적어 주세요.')
          return
        }

        clearStreamStatus()
      },
      onError: (data) => {
        if (!isCurrentStream()) {
          return
        }

        syncRunActivity(undefined, 'failed')
        setMessages((prev) =>
          updateLastAssistantMessage(prev, (current) =>
            current ? `${current}\n\n**Error**: ${data.message}` : `**Error**: ${data.message}`
          )
        )
        updateStreamStatus('error', '작업 실패', data.message)
      },
    })
  }

  useEffect(() => {
    const sessionKey = activeSessionKeyRef.current

    if (!projectId || !sessionKey || !activeRunId) {
      return
    }

    if (connectedRunIdRef.current === activeRunId) {
      return
    }

    void connectToBackgroundRun(activeRunId, sessionKey)
  }, [activeRunId, projectId])

  const setFreshStreamStatus = (phase: StreamPhase, label: string, detail?: string) => {
    const startedAt = Date.now()
    setNow(startedAt)
    setStreamStatus({ phase, label, detail, startedAt, updatedAt: startedAt })
  }

  const updateStreamStatus = (phase: StreamPhase, label: string, detail?: string) => {
    const updatedAt = Date.now()
    setNow(updatedAt)
    setStreamStatus((current) => ({
      phase,
      label,
      detail,
      startedAt: current.startedAt ?? updatedAt,
      updatedAt,
    }))
  }

  const clearStreamStatus = () => {
    setNow(Date.now())
    setStreamStatus(createIdleStreamStatus())
  }

  const syncRunActivity = (nextRunId: string | undefined, status: BackgroundRunStatus | undefined) => {
    const resolvedRunId = isActiveBackgroundRunStatus(status) ? nextRunId : undefined
    currentRunIdRef.current = resolvedRunId
    if (!resolvedRunId) {
      connectedRunIdRef.current = undefined
    }
    setActiveRunId(resolvedRunId)
    setIsStreaming(Boolean(resolvedRunId))
  }

  const persistExplainSettings = async (nextModel: string, nextReasoningEffort: typeof reasoningEffort) => {
    await updateExplainSettings({ model: nextModel, reasoningEffort: nextReasoningEffort })
    await onConfigUpdated()
  }

  const handleModelChange = async (nextModel: string) => {
    const resolved = resolveDirectModelSelection({
      availableModels: config.explain.availableModels,
      currentReasoningEffort: reasoningEffort,
      nextModel,
    })
    setModel(resolved.nextModel)
    setReasoningEffort(resolved.nextReasoningEffort)
    await persistExplainSettings(resolved.nextModel, resolved.nextReasoningEffort)
  }

  const beginEdit = (messageId: string) => {
    if (isStreaming) {
      return
    }

    const targetMessage = messages.find((message) => message.id === messageId && message.role === 'user')
    if (!targetMessage) {
      return
    }

    setEditingSession({ messageId, previousInput: input })
    setInput(targetMessage.content)
  }

  const cancelEdit = () => {
    setInput(editingSession?.previousInput ?? '')
    setEditingSession(null)
  }

  const stopStreaming = () => {
    if (!activeRunId) {
      return
    }

    updateStreamStatus('stopping', '중단 요청 중', '현재 작업을 멈추고 있습니다.')
    void stopBackgroundRun(activeRunId).catch((error) => {
      updateStreamStatus(
        'error',
        '중단 요청 실패',
        error instanceof Error ? error.message : '작업 중단 요청에 실패했습니다.'
      )
    })
  }

  const send = async () => {
    const message = input.trim()
    if (!message || isStreaming || isStateLoading || !activeSessionKeyRef.current) {
      return
    }

    const activeEditSession = editingSession
    const { messages: nextMessages, truncated } = buildNextExplainMessages(messages, message, {
      editMessageId: activeEditSession?.messageId,
    })
    const activeThreadId = activeEditSession ? undefined : threadIdRef.current

    setInput('')
    setEditingSession(null)
    setMessages(nextMessages)
    if (truncated) {
      setThreadId(undefined)
      threadIdRef.current = undefined
    }

    setIsStreaming(true)
    setFreshStreamStatus(
      'submitting',
      activeEditSession ? '수정한 요청 다시 보내는 중' : '개발 요청 전송 중',
      activeEditSession
        ? '선택한 지점부터 새 Direct Dev 세션으로 다시 시작합니다.'
        : 'Codex에 직접 개발 요청을 전달하고 있습니다.'
    )

    try {
      const started = await startDirectBackgroundRun({
        message,
        threadId: activeThreadId,
        projectId,
        model,
        reasoningEffort,
        agentRole: selectedAgentRole,
        sessionMessages: nextMessages,
        sessionId: activeSessionKeyRef.current,
        scopeLabel: selectedSession?.title || activeSessionKeyRef.current,
        messages: nextMessages,
      })

      syncRunActivity(started.run.id, started.run.status)

      if (directState) {
        onDirectStateChange(
          updateDirectSessionState(directState, activeSessionKeyRef.current, (session) => ({
            ...session,
            activeRunId: started.run.id,
            updatedAt: new Date().toISOString(),
          })),
          { immediate: true }
        )
      }
    } catch (error) {
      syncRunActivity(undefined, undefined)
      setMessages((prev) =>
        updateLastAssistantMessage(prev, (current) =>
          current
            ? `${current}\n\n**Error**: ${error instanceof Error ? error.message : '작업 시작에 실패했습니다.'}`
            : `**Error**: ${error instanceof Error ? error.message : '작업 시작에 실패했습니다.'}`
        )
      )
      updateStreamStatus('error', '작업 실패', error instanceof Error ? error.message : '작업 시작에 실패했습니다.')
    }
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Escape' && editingSession) {
      event.preventDefault()
      cancelEdit()
      return
    }

    const nextRole = resolveDirectComposerRoleShortcut({
      key: event.key,
      shiftKey: event.shiftKey,
      isStreaming,
      isComposerDisabled,
      selectedAgentRole,
    })

    if (nextRole) {
      event.preventDefault()
      handleAgentRoleChange(nextRole)
      return
    }

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void send()
    }
  }

  const subtitle = !hasActiveSession
    ? '왼쪽에서 세션을 선택하거나 새로 만드세요'
    : threadId
      ? '기존 Direct Dev 세션을 이어가는 중'
      : '새 Direct Dev 세션을 시작합니다'
  const elapsedLabel = streamStatus.startedAt && isStreaming ? formatElapsed(now - streamStatus.startedAt) : undefined
  const statusMeta = [streamStatus.detail, elapsedLabel].filter(Boolean).join(' · ')

  const handleAgentRoleChange = (role: DirectAgentRole) => {
    const sessionKey = activeSessionKeyRef.current
    if (!directState || !sessionKey) {
      return
    }

    const currentSession = directState.sessions.find((session) => session.id === sessionKey)
    if (!currentSession || currentSession.agentRole === role) {
      return
    }

    const nextState = updateDirectSessionState(directState, sessionKey, (session) => ({
      ...session,
      agentRole: role,
      updatedAt: new Date().toISOString(),
    }))

    onDirectStateChange(nextState, { immediate: true })
  }

  return (
    <div className="flex h-full flex-col">
      <WorkspaceHeader
        authSession={config.auth.session}
        projects={config.allowedProjects}
        projectId={projectId}
        onProjectChange={onProjectChange}
        onConfigUpdated={onConfigUpdated}
        title="Direct Dev"
        subtitle={subtitle}
        controls={
          <>
            <div
              role="tablist"
              aria-label="Direct Dev model selector"
              className="inline-flex max-w-full flex-wrap rounded-xl border border-zinc-800 bg-zinc-950/70 p-1"
            >
              {config.explain.availableModels.map((entry) => {
                const isActive = entry.id === model
                return (
                  <button
                    key={entry.id}
                    type="button"
                    role="tab"
                    aria-selected={isActive}
                    onClick={() => {
                      void handleModelChange(entry.id)
                    }}
                    disabled={isStreaming || !canManageExplainSettings}
                    className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                      isActive
                        ? 'bg-blue-950/60 text-blue-100'
                        : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100'
                    } disabled:cursor-not-allowed disabled:opacity-70`}
                  >
                    {entry.label}
                  </button>
                )
              })}
            </div>
            <select
              value={reasoningEffort}
              disabled={isStreaming || !canManageExplainSettings}
              onChange={async (event) => {
                const nextReasoningEffort = event.target.value as typeof reasoningEffort
                setReasoningEffort(nextReasoningEffort)
                await persistExplainSettings(model, nextReasoningEffort)
              }}
              className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs text-zinc-200 disabled:text-zinc-500"
            >
              {selectedModelCapability.supportedReasoningEfforts.map((entry) => (
                <option key={entry} value={entry}>
                  {entry}
                </option>
              ))}
            </select>
          </>
        }
      />

      <div className="border-b border-zinc-800 px-6 py-3">
        <div className="mx-auto flex max-w-5xl flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="inline-flex w-full max-w-full rounded-xl border border-zinc-800 bg-zinc-950/70 p-1 sm:w-auto">
            {DIRECT_AGENT_ROLE_TABS.map((tab) => {
              const isActive = tab.role === selectedAgentRole
              return (
                <button
                  key={tab.role}
                  type="button"
                  onClick={() => handleAgentRoleChange(tab.role)}
                  disabled={isStreaming}
                  className={`flex-1 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors sm:flex-none ${directRoleTabClassName(
                    tab.role,
                    isActive
                  )} disabled:cursor-not-allowed disabled:opacity-70`}
                >
                  {tab.label}
                </button>
              )
            })}
          </div>
          <div className="text-xs text-zinc-500">
            <div className="flex flex-wrap items-center gap-2">
              <span>현재 역할:</span>
              <span className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${directRoleBadgeClassName(selectedAgentRole)}`}>
                {selectedAgentDescriptor.label}
              </span>
              <span className={`rounded-full border px-2 py-0.5 text-[11px] ${directRoleBadgeClassName(selectedAgentRole)}`}>
                {selectedAgentDescriptor.badge}
              </span>
              {isStreaming ? <span>· 스트리밍 중에는 역할을 바꿀 수 없습니다.</span> : null}
            </div>
            <p className="mt-1 text-zinc-500">{selectedAgentDescriptor.description}</p>
            {hasActiveSession ? (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <span className="text-[11px] uppercase tracking-[0.18em] text-zinc-600">Handoff</span>
                {previousAgentDescriptor ? (
                  <button
                    type="button"
                    onClick={() => handleAgentRoleChange(previousAgentDescriptor.role)}
                    disabled={isStreaming}
                    className={`rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors ${directRoleActionClassName(previousAgentDescriptor.role)} disabled:cursor-not-allowed disabled:opacity-50`}
                  >
                    ← {previousAgentDescriptor.label}
                  </button>
                ) : null}
                {nextAgentDescriptor ? (
                  <button
                    type="button"
                    onClick={() => handleAgentRoleChange(nextAgentDescriptor.role)}
                    disabled={isStreaming}
                    className={`rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors ${directRoleActionClassName(nextAgentDescriptor.role)} disabled:cursor-not-allowed disabled:opacity-50`}
                  >
                    {nextAgentDescriptor.label} →
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto max-w-5xl">
          {continuityNotice ? (
            <div className="mb-4 rounded-2xl border border-amber-900/70 bg-amber-950/20 px-5 py-4 text-amber-100">
              <p className="text-sm font-medium">세션 복구됨</p>
              <p className="mt-1 text-xs text-amber-100/80">{continuityNotice}</p>
            </div>
          ) : null}
          {isStateLoading ? (
            <div className="rounded-2xl border border-zinc-800 bg-zinc-900/50 px-5 py-4 text-sm text-zinc-400">
              Direct Dev 세션을 불러오는 중입니다.
            </div>
          ) : null}
          {messages.length === 0 ? (
            <div className="rounded-2xl border border-zinc-800 bg-zinc-900/50 px-5 py-4 text-sm text-zinc-400">
              {hasActiveSession
                ? '구현 요청을 바로 보내면 Codex가 현재 프로젝트에서 직접 작업합니다. 이 모드는 기존 Explain과 달리 `tickets` 권한이 있어야 열리며, 프로젝트별 세션이 자동으로 이어집니다.'
                : '활성 Direct Dev 세션이 없습니다. 왼쪽에서 `New Session`을 눌러 새 세션을 만든 뒤 요청을 보내세요.'}
            </div>
          ) : null}

          <div className="mt-4">
            {messages.map((message, index) => {
              const isPendingAssistant = isStreaming && message.role === 'assistant' && index === messages.length - 1
              return (
                <ChatMessage
                  key={message.id}
                  role={message.role}
                  content={message.content}
                  canEdit={message.role === 'user' && !isStreaming}
                  onEdit={message.role === 'user' ? () => beginEdit(message.id) : undefined}
                  isPending={isPendingAssistant}
                  pendingLabel={isPendingAssistant ? streamStatus.label : undefined}
                  pendingDetail={isPendingAssistant ? statusMeta : undefined}
                />
              )
            })}
            <div ref={bottomRef} />
          </div>
        </div>
      </div>

      <div className="border-t border-zinc-800 px-6 py-4">
        <div className="mx-auto max-w-5xl">
          {streamStatus.phase === 'error' || streamStatus.phase === 'stopped' ? (
            <div className="mb-3 rounded-xl border border-zinc-800 bg-zinc-900/70 px-4 py-3 text-xs text-zinc-400">
              <p className="font-medium text-zinc-200">{streamStatus.label}</p>
              {statusMeta ? <p className="mt-1">{statusMeta}</p> : null}
            </div>
          ) : null}

          {editingSession ? (
            <div className="mb-2 flex items-center justify-between gap-3 rounded-lg border border-amber-900/60 bg-amber-950/20 px-3 py-2 text-xs text-amber-100/90">
              <span>선택한 요청부터 새 세션으로 다시 시작합니다.</span>
              <button
                type="button"
                onClick={cancelEdit}
                className="rounded border border-amber-800/80 px-2 py-1 text-[11px] text-amber-100 transition hover:bg-amber-900/30"
              >
                취소
              </button>
            </div>
          ) : null}

          <div className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-3">
            <textarea
              ref={composerRef}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={handleKeyDown}
              rows={5}
              placeholder="예: 로그인 화면 오류를 수정하고 관련 테스트까지 맞춰줘"
              disabled={isComposerDisabled}
              className="min-h-[120px] w-full resize-none bg-transparent px-2 py-2 text-sm text-zinc-100 outline-none placeholder:text-zinc-500"
            />
            <div className="mt-3 flex items-center justify-between gap-3 border-t border-zinc-800 pt-3">
              <p className="text-xs text-zinc-500">Enter로 전송 · Shift+Enter로 줄바꿈 · Tab으로 역할 전환/해제</p>
              <div className="flex items-center gap-2">
                {isStreaming ? (
                  <button
                    type="button"
                    onClick={stopStreaming}
                    className="rounded-lg border border-red-900/70 bg-red-950/30 px-3 py-1.5 text-sm font-medium text-red-100 transition hover:bg-red-950/50"
                  >
                    중단
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => {
                    void send()
                  }}
                  disabled={!input.trim() || isStreaming || isComposerDisabled}
                  className="rounded-lg bg-blue-600 px-4 py-1.5 text-sm font-medium text-white transition hover:bg-blue-500 disabled:bg-zinc-700 disabled:text-zinc-400"
                >
                  {editingSession ? '다시 보내기' : '개발 시작'}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
