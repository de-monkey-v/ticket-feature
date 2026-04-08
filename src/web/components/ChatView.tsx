import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { useSSE } from '../hooks/useSSE'
import {
  createClientRequest,
  startExplainBackgroundRun,
  startExplainRequestDraftRun,
  stopBackgroundRun,
  updateChatSettings,
  updateExplainSettings,
  type BackgroundRunKind,
  type BackgroundRunStatus,
  type AppConfig,
  type ClientRequest,
  type RequestTemplateFields,
} from '../lib/api'
import {
  buildNextExplainMessages,
  shouldInterceptImplementationRequestForExplain,
  shouldBypassRequestInterceptForExplain,
  type ChatMessageRecord,
} from '../lib/chat-session'
import { CHAT_INITIAL_SCROLL_TARGET_OPTIONS, getLastUserMessageId } from '../lib/chat-scroll'
import {
  DEFAULT_EXPLAIN_TEXT_EFFECT,
  EXPLAIN_TEXT_EFFECT_OPTIONS,
  normalizeExplainTextEffect,
  shouldQueueExplainDeltas,
  type ExplainTextEffectId,
} from '../lib/explain-effects'
import {
  removeExplainDraftState,
  selectExplainThreadState,
  updateExplainDraftState,
  updateExplainThreadState,
  type ExplainStateChange,
  type ExplainState,
} from '../lib/explain-state'
import { ChatMessage } from './ChatMessage'
import { ChatRequestDraftCard, type ChatRequestDraft } from './ChatRequestDraftCard'
import { WorkspaceHeader } from './WorkspaceHeader'

type Message = ChatMessageRecord
type StreamPhase =
  | 'idle'
  | 'submitting'
  | 'waiting'
  | 'tool'
  | 'answering'
  | 'stopping'
  | 'stopped'
  | 'error'

interface ChatViewProps {
  projectId: string
  explainState: ExplainState | null
  selectedExplainThreadId: string
  composerFocusToken: number
  config: AppConfig
  onConfigUpdated: () => Promise<void> | void
  onProjectChange: (projectId: string) => void
  onExplainStateChange: (change: ExplainStateChange, options?: { immediate?: boolean }) => void
  onRequestCreated?: (request: ClientRequest) => Promise<void> | void
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
  originalContent: string
  previousInput: string
  hadFollowUp: boolean
}

const REQUEST_DRAFT_TOOL_NAME = 'create_client_request_draft'
const CHAT_REQUESTER = 'Codex Chat'
const STREAM_REVEAL_INTERVAL_MS = 24

function getRevealChunkSize(pendingLength: number) {
  if (pendingLength > 120) {
    return 12
  }

  if (pendingLength > 60) {
    return 8
  }

  if (pendingLength > 24) {
    return 4
  }

  return 2
}

function createDraftKey() {
  return `draft-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function createIdleStreamStatus(): StreamStatus {
  return {
    phase: 'idle',
    label: '',
    updatedAt: Date.now(),
  }
}

function isActiveBackgroundRunStatus(status: BackgroundRunStatus | undefined) {
  return status === 'queued' || status === 'running' || status === 'stopping'
}

export function inferExplainReconnectRunKind(params: {
  activeRunId?: string
  messages: Message[]
  drafts: ChatRequestDraft[]
}): BackgroundRunKind | undefined {
  if (!params.activeRunId) {
    return undefined
  }

  if (params.drafts.some((draft) => draft.status === 'drafting')) {
    return 'explain_request_draft'
  }

  return params.messages.some((message) => message.role === 'assistant') ? 'explain_reply' : undefined
}

export function createReconnectStreamStatus(
  runKind: BackgroundRunKind | undefined,
  messages: Message[]
): StreamStatus {
  const updatedAt = Date.now()

  if (runKind === 'explain_request_draft') {
    return {
      phase: 'tool',
      label: '요청 초안 정리 중',
      detail: '진행 중인 요청 초안을 다시 연결하고 있습니다.',
      startedAt: updatedAt,
      updatedAt,
    }
  }

  if (runKind === 'explain_reply') {
    const lastAssistantMessage = [...messages].reverse().find((message) => message.role === 'assistant')
    const hasAssistantText = Boolean(lastAssistantMessage?.content.trim())

    return {
      phase: hasAssistantText ? 'answering' : 'waiting',
      label: hasAssistantText ? '답변 생성 중' : '응답 준비 중',
      detail: hasAssistantText
        ? '진행 중인 답변 생성을 다시 연결하고 있습니다.'
        : '진행 중인 응답을 다시 연결하고 있습니다.',
      startedAt: updatedAt,
      updatedAt,
    }
  }

  return createIdleStreamStatus()
}

export function shouldHydrateSelectedExplainThread(params: {
  contextChanged: boolean
  nextMessages: Message[]
  currentMessages: Message[]
  nextDrafts: ChatRequestDraft[]
  currentDrafts: ChatRequestDraft[]
  nextThreadId?: string
  currentThreadId?: string
  nextActiveRunId?: string
  currentActiveRunId?: string
}) {
  if (params.contextChanged) {
    return true
  }

  return (
    params.nextMessages !== params.currentMessages ||
    params.nextDrafts !== params.currentDrafts ||
    params.nextThreadId !== params.currentThreadId ||
    params.nextActiveRunId !== params.currentActiveRunId
  )
}

function upsertDraftList(drafts: ChatRequestDraft[], nextDraft: ChatRequestDraft) {
  const nextDrafts = [...drafts]
  const index = nextDrafts.findIndex((draft) => draft.id === nextDraft.id)

  if (index === -1) {
    nextDrafts.push(nextDraft)
    return nextDrafts
  }

  nextDrafts[index] = {
    ...nextDrafts[index],
    ...nextDraft,
  }
  return nextDrafts
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readString(value: unknown) {
  return typeof value === 'string' ? value : undefined
}

function normalizeCategoryId(
  categoryId: string | undefined,
  categories: AppConfig['flows']['ticket']['categories']
) {
  const normalized = categoryId?.trim().toLowerCase()
  if (normalized && categories.some((category) => category.id === normalized)) {
    return normalized
  }

  return categories[0]?.id ?? ''
}

function parseDraftResult(
  result: unknown,
  categories: AppConfig['flows']['ticket']['categories']
): Pick<ChatRequestDraft, 'title' | 'template' | 'categoryId' | 'rationale'> | undefined {
  if (!isRecord(result)) {
    return undefined
  }

  const title = readString(result.title)?.trim()
  const template = isRecord(result.template)
    ? {
        problem: readString(result.template.problem)?.trim() ?? '',
        desiredOutcome: readString(result.template.desiredOutcome)?.trim() ?? '',
        userScenarios: readString(result.template.userScenarios)?.trim() ?? '',
        constraints: readString(result.template.constraints)?.trim() || undefined,
        nonGoals: readString(result.template.nonGoals)?.trim() || undefined,
        openQuestions: readString(result.template.openQuestions)?.trim() || undefined,
      }
    : undefined
  if (!title || !template?.problem || !template.desiredOutcome || !template.userScenarios) {
    return undefined
  }

  return {
    title,
    template,
    categoryId: normalizeCategoryId(readString(result.categoryId), categories),
    rationale: readString(result.rationale)?.trim() || undefined,
  }
}

function createEmptyRequestTemplate(): RequestTemplateFields {
  return {
    problem: '',
    desiredOutcome: '',
    userScenarios: '',
    constraints: '',
    nonGoals: '',
    openQuestions: '',
  }
}

function describeToolActivity(tool: string, error?: string) {
  if (tool === 'search_repository') {
    return {
      label: error ? '레포 검색 오류 처리 중' : '레포 검색 중',
      detail: error ? '검색 중 오류가 발생해 다른 근거를 찾고 있습니다.' : '관련 파일과 구현 범위를 찾고 있습니다.',
    }
  }

  if (tool === 'read_repository_file') {
    return {
      label: error ? '파일 읽기 오류 처리 중' : '파일 읽는 중',
      detail: error ? '파일 내용을 다시 확인할 경로를 찾고 있습니다.' : '근거가 되는 구현 파일을 읽고 있습니다.',
    }
  }

  if (tool === 'list_repository_files') {
    return {
      label: error ? '파일 목록 오류 처리 중' : '파일 목록 확인 중',
      detail: error ? '디렉터리 구조를 다시 점검하고 있습니다.' : '관련 디렉터리와 진입점을 확인하고 있습니다.',
    }
  }

  if (tool === REQUEST_DRAFT_TOOL_NAME) {
    return {
      label: error ? '요청 초안 오류 처리 중' : '요청 초안 정리 중',
      detail: error ? '초안 생성 결과를 다시 정리하고 있습니다.' : '현재 대화를 request 초안으로 구조화하고 있습니다.',
    }
  }

  return {
    label: error ? '도구 오류 처리 중' : '추가 정보 확인 중',
    detail: error ? `${tool} 실행 중 오류가 발생했습니다.` : `${tool} 도구로 추가 정보를 확인하고 있습니다.`,
  }
}

function updateLastAssistantMessage(messages: Message[], updateContent: (current: string) => string) {
  const updated = [...messages]

  for (let index = updated.length - 1; index >= 0; index -= 1) {
    if (updated[index]?.role === 'assistant') {
      updated[index] = {
        ...updated[index],
        content: updateContent(updated[index].content),
      }
      return updated
    }
  }

  return updated
}

function markLastAssistantStopped(messages: Message[]) {
  return updateLastAssistantMessage(messages, (current) =>
    current.trim() ? current : '_응답이 중단되었습니다._'
  )
}

export function resolveCompletedAssistantContent(current: string, finalResponse?: string) {
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

export function completeExplainReplyThreadState(
  state: ExplainState,
  threadKey: string,
  params: {
    threadId?: string
    finalResponse?: string
    stopped?: boolean
    updatedAt?: string
  }
) {
  const updatedAt = params.updatedAt ?? new Date().toISOString()

  return updateExplainThreadState(state, threadKey, (thread) => {
    const completedMessages = updateLastAssistantMessage(thread.messages, (current) =>
      resolveCompletedAssistantContent(current, params.finalResponse)
    )

    return {
      ...thread,
      threadId: params.threadId ?? thread.threadId,
      activeRunId: undefined,
      messages: params.stopped ? markLastAssistantStopped(completedMessages) : completedMessages,
      updatedAt,
    }
  })
}

export function failExplainReplyThreadState(
  state: ExplainState,
  threadKey: string,
  params: {
    threadId?: string
    errorMessage: string
    updatedAt?: string
  }
) {
  const updatedAt = params.updatedAt ?? new Date().toISOString()

  return updateExplainThreadState(state, threadKey, (thread) => ({
    ...thread,
    threadId: params.threadId ?? thread.threadId,
    activeRunId: undefined,
    messages: updateLastAssistantMessage(thread.messages, (current) =>
      current ? `${current}\n\n**Error**: ${params.errorMessage}` : `**Error**: ${params.errorMessage}`
    ),
    updatedAt,
  }))
}

function formatElapsed(ms: number) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  if (totalSeconds < 60) {
    return `${totalSeconds}초 경과`
  }

  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}분 ${seconds}초 경과`
}

function streamStatusStyles(phase: StreamPhase) {
  if (phase === 'error') {
    return 'border-red-900/70 bg-red-950/20 text-red-100'
  }

  if (phase === 'stopped' || phase === 'stopping') {
    return 'border-amber-900/70 bg-amber-950/20 text-amber-100'
  }

  return 'border-sky-900/70 bg-sky-950/20 text-sky-100'
}

function streamIndicatorColor(phase: StreamPhase) {
  if (phase === 'error') {
    return 'bg-red-400'
  }

  if (phase === 'stopped' || phase === 'stopping') {
    return 'bg-amber-400'
  }

  return 'bg-sky-400'
}

export function ChatView({
  projectId,
  explainState,
  selectedExplainThreadId,
  composerFocusToken,
  config,
  onConfigUpdated,
  onProjectChange,
  onExplainStateChange,
  onRequestCreated,
}: ChatViewProps) {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  const [isGeneratingDraft, setIsGeneratingDraft] = useState(false)
  const [activeRunId, setActiveRunId] = useState<string | undefined>()
  const [activeRunKind, setActiveRunKind] = useState<BackgroundRunKind | undefined>()
  const [threadId, setThreadId] = useState<string | undefined>()
  const [drafts, setDrafts] = useState<ChatRequestDraft[]>([])
  const [requestInterceptInput, setRequestInterceptInput] = useState<string | null>(null)
  const [model, setModel] = useState(config.explain.selectedModel)
  const [reasoningEffort, setReasoningEffort] = useState(config.explain.selectedReasoningEffort)
  const [interceptImplementationRequests, setInterceptImplementationRequests] = useState(
    config.explain.interceptImplementationRequests
  )
  const [textEffect, setTextEffect] = useState<ExplainTextEffectId>(DEFAULT_EXPLAIN_TEXT_EFFECT)
  const [streamStatus, setStreamStatus] = useState<StreamStatus>(() => createIdleStreamStatus())
  const [editingSession, setEditingSession] = useState<EditSession | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const scrollViewportRef = useRef<HTMLDivElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const userMessageRefs = useRef(new Map<string, HTMLDivElement>())
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const threadIdRef = useRef<string | undefined>(undefined)
  const activeThreadKeyRef = useRef('')
  const discardedDraftIdsRef = useRef<Set<string>>(new Set())
  const skipNextPersistRef = useRef(true)
  const activeStreamSessionRef = useRef(0)
  const currentRunIdRef = useRef<string | undefined>(undefined)
  const currentRunKindRef = useRef<BackgroundRunKind | undefined>(undefined)
  const connectedRunIdRef = useRef<string | undefined>(undefined)
  const pendingDeltaRef = useRef('')
  const pendingFlushTimerRef = useRef<number | null>(null)
  const pendingDraftSourceSignatureRef = useRef('')
  const pendingInitialScrollTargetRef = useRef<AppConfig['chat']['initialScrollTarget'] | null>(null)
  const skipAutoScrollRef = useRef(false)
  const { startEventStream, abort } = useSSE()
  const selectedModelCapability =
    config.explain.availableModels.find((entry) => entry.id === model) ?? config.explain.availableModels[0]
  const canManageExplainSettings = Boolean(projectId)
  const canCreateRequests = config.auth.session.isAdmin || config.auth.session.permissions.includes('requests')
  const selectedThread =
    explainState?.threads.find((thread) => thread.id === (selectedExplainThreadId || explainState.selectedThreadId)) ?? null
  const hasActiveThread = Boolean(
    explainState &&
      selectedExplainThreadId &&
      explainState.threads.some((thread) => thread.id === selectedExplainThreadId)
  )
  const continuityNotice =
    selectedThread?.continuityMode === 'rehydrated'
      ? selectedThread.lastRecoveryReason ?? '이전 Codex 세션을 복구하지 못해 현재 대화 기록을 바탕으로 새 세션에서 이어가고 있습니다.'
      : undefined

  const focusComposer = () => {
    if (!composerRef.current || composerRef.current.disabled) {
      return
    }

    composerRef.current.focus()
    const cursor = composerRef.current.value.length
    composerRef.current.setSelectionRange(cursor, cursor)
  }

  const scrollToBottom = () => {
    if (scrollViewportRef.current) {
      scrollViewportRef.current.scrollTop = scrollViewportRef.current.scrollHeight
      return
    }

    bottomRef.current?.scrollIntoView({ block: 'end' })
  }

  const registerUserMessageAnchor = (messageId: string) => (node: HTMLDivElement | null) => {
    if (node) {
      userMessageRefs.current.set(messageId, node)
      return
    }

    userMessageRefs.current.delete(messageId)
  }

  const scrollToLastUserMessage = () => {
    const targetMessageId = getLastUserMessageId(messages)
    if (!targetMessageId) {
      return false
    }

    const target = userMessageRefs.current.get(targetMessageId)
    if (!target) {
      return false
    }

    target.scrollIntoView({ block: 'start' })
    return true
  }

  const applyInitialScrollTarget = (target: AppConfig['chat']['initialScrollTarget']) => {
    if (target === 'last_user_message' && scrollToLastUserMessage()) {
      return
    }

    scrollToBottom()
  }

  const clearPendingDeltaFlushTimer = () => {
    if (pendingFlushTimerRef.current === null) {
      return
    }

    window.clearTimeout(pendingFlushTimerRef.current)
    pendingFlushTimerRef.current = null
  }

  const clearPendingDeltaState = () => {
    clearPendingDeltaFlushTimer()
    pendingDeltaRef.current = ''
  }

  const appendAssistantDelta = (text: string) => {
    if (!text) {
      return
    }

    setMessages((prev) => updateLastAssistantMessage(prev, (current) => current + text))
  }

  const flushPendingDelta = (
    streamSessionId: number,
    threadKey: string,
    options?: {
      immediate?: boolean
    }
  ) => {
    clearPendingDeltaFlushTimer()

    if (activeStreamSessionRef.current !== streamSessionId || activeThreadKeyRef.current !== threadKey) {
      return
    }

    if (!pendingDeltaRef.current) {
      return
    }

    const nextText = options?.immediate
      ? pendingDeltaRef.current
      : pendingDeltaRef.current.slice(0, getRevealChunkSize(pendingDeltaRef.current.length))

    pendingDeltaRef.current = pendingDeltaRef.current.slice(nextText.length)
    appendAssistantDelta(nextText)

    if (!options?.immediate && pendingDeltaRef.current) {
      pendingFlushTimerRef.current = window.setTimeout(() => {
        flushPendingDelta(streamSessionId, threadKey)
      }, STREAM_REVEAL_INTERVAL_MS)
    }
  }

  const schedulePendingDeltaFlush = (streamSessionId: number, threadKey: string) => {
    if (pendingFlushTimerRef.current !== null || !pendingDeltaRef.current) {
      return
    }

    pendingFlushTimerRef.current = window.setTimeout(() => {
      flushPendingDelta(streamSessionId, threadKey)
    }, STREAM_REVEAL_INTERVAL_MS)
  }

  useEffect(() => {
    if (!projectId || !explainState) {
      skipNextPersistRef.current = true
      activeStreamSessionRef.current += 1
      clearPendingDeltaState()
      abort({ silent: true })
      activeThreadKeyRef.current = ''
      currentRunIdRef.current = undefined
      currentRunKindRef.current = undefined
      connectedRunIdRef.current = undefined
      setTextEffect(DEFAULT_EXPLAIN_TEXT_EFFECT)
      setMessages([])
      setActiveRunId(undefined)
      setActiveRunKind(undefined)
      setThreadId(undefined)
      threadIdRef.current = undefined
      setDrafts([])
      setInput('')
      setRequestInterceptInput(null)
      setEditingSession(null)
      setIsStreaming(false)
      setIsGeneratingDraft(false)
      setNow(Date.now())
      setStreamStatus(createIdleStreamStatus())
      return
    }

    const nextState = selectExplainThreadState(explainState, selectedExplainThreadId)
    const selectedThread =
      nextState.threads.find((thread) => thread.id === nextState.selectedThreadId) ??
      nextState.threads[0]

    if (nextState !== explainState) {
      onExplainStateChange(nextState, { immediate: true })
    }

    const nextThreadKey = selectedThread?.id ?? ''
    const nextMessages = selectedThread?.messages ?? []
    const nextThreadId = selectedThread?.threadId
    const nextDrafts = selectedThread?.drafts ?? []
    const nextActiveRunId = selectedThread?.activeRunId
    const nextComposerDraft = selectedThread?.composerDraft ?? ''
    const nextActiveRunKind = inferExplainReconnectRunKind({
      activeRunId: nextActiveRunId,
      messages: nextMessages,
      drafts: nextDrafts,
    })
    const nextTextEffect = nextState.textEffect
    const contextChanged = activeThreadKeyRef.current !== nextThreadKey
    const shouldHydrateThread = shouldHydrateSelectedExplainThread({
      contextChanged,
      nextMessages,
      currentMessages: messages,
      nextDrafts,
      currentDrafts: drafts,
      nextThreadId,
      currentThreadId: threadId,
      nextActiveRunId,
      currentActiveRunId: activeRunId,
    })

    if (!shouldHydrateThread) {
      if (nextTextEffect !== textEffect) {
        setTextEffect(nextTextEffect)
      }
      return
    }

    skipNextPersistRef.current = true

    if (!selectedThread) {
      if (contextChanged) {
        activeStreamSessionRef.current += 1
        clearPendingDeltaState()
        abort({ silent: true })
      }

      activeThreadKeyRef.current = ''
      currentRunIdRef.current = undefined
      currentRunKindRef.current = undefined
      connectedRunIdRef.current = undefined
      setTextEffect(nextTextEffect)
      setMessages([])
      setActiveRunId(undefined)
      setActiveRunKind(undefined)
      setThreadId(undefined)
      threadIdRef.current = undefined
      setDrafts([])
      setInput('')
      setRequestInterceptInput(null)
      setEditingSession(null)
      setIsStreaming(false)
      setIsGeneratingDraft(false)
      setNow(Date.now())
      setStreamStatus(createIdleStreamStatus())
      return
    }

    const runChanged = currentRunIdRef.current !== nextActiveRunId || currentRunKindRef.current !== nextActiveRunKind
    const shouldResetStream = contextChanged || (currentRunIdRef.current && currentRunIdRef.current !== nextActiveRunId)

    if (shouldResetStream) {
      activeStreamSessionRef.current += 1
      clearPendingDeltaState()
      abort({ silent: true })
    }

    activeThreadKeyRef.current = nextThreadKey
    currentRunIdRef.current = nextActiveRunId
    currentRunKindRef.current = nextActiveRunKind
    connectedRunIdRef.current = runChanged ? undefined : connectedRunIdRef.current
    setTextEffect(nextTextEffect)
    setMessages(nextMessages)
    setActiveRunId(nextActiveRunId)
    setActiveRunKind(nextActiveRunKind)
    setThreadId(nextThreadId)
    threadIdRef.current = nextThreadId
    setDrafts(nextDrafts)

    if (contextChanged) {
      pendingInitialScrollTargetRef.current = config.chat.initialScrollTarget
      setInput(nextComposerDraft)
      setRequestInterceptInput(null)
      setEditingSession(null)
    }

    if (contextChanged || runChanged) {
      setIsStreaming(Boolean(nextActiveRunId && nextActiveRunKind === 'explain_reply'))
      setIsGeneratingDraft(Boolean(nextActiveRunId && nextActiveRunKind === 'explain_request_draft'))
      setNow(Date.now())
      setStreamStatus(
        nextActiveRunId ? createReconnectStreamStatus(nextActiveRunKind, nextMessages) : createIdleStreamStatus()
      )
    }
  }, [abort, explainState, onExplainStateChange, projectId, selectedExplainThreadId])

  useEffect(() => {
    return () => {
      abort({ silent: true })
      clearPendingDeltaState()
    }
  }, [abort])

  useEffect(() => {
    setModel(config.explain.selectedModel)
    setReasoningEffort(config.explain.selectedReasoningEffort)
    setInterceptImplementationRequests(config.explain.interceptImplementationRequests)
  }, [
    config.explain.interceptImplementationRequests,
    config.explain.selectedModel,
    config.explain.selectedReasoningEffort,
  ])

  useEffect(() => {
    if (!selectedModelCapability) {
      return
    }

    if (!selectedModelCapability.supportedReasoningEfforts.includes(reasoningEffort)) {
      setReasoningEffort(selectedModelCapability.defaultReasoningEffort)
    }
  }, [reasoningEffort, selectedModelCapability])

  useEffect(() => {
    if (!interceptImplementationRequests) {
      setRequestInterceptInput(null)
    }
  }, [interceptImplementationRequests])

  useEffect(() => {
    threadIdRef.current = threadId
  }, [threadId])

  useEffect(() => {
    currentRunIdRef.current = activeRunId
  }, [activeRunId])

  useEffect(() => {
    currentRunKindRef.current = activeRunKind
  }, [activeRunKind])

  useEffect(() => {
    if (skipNextPersistRef.current) {
      skipNextPersistRef.current = false
      return
    }

    const currentThreadKey = activeThreadKeyRef.current
    if (!currentThreadKey) {
      return
    }

    if (!explainState) {
      return
    }

    const currentThread = explainState.threads.find((thread) => thread.id === currentThreadKey)
    if (!currentThread) {
      return
    }

    if (
      currentThread.activeRunId === activeRunId &&
      currentThread.threadId === threadId &&
      currentThread.composerDraft === input &&
      currentThread.messages === messages &&
      currentThread.drafts === drafts
    ) {
      return
    }

    const updatedAt = new Date().toISOString()
    const nextState = updateExplainThreadState(explainState, currentThreadKey, (thread) => ({
      ...thread,
      activeRunId,
      threadId,
      composerDraft: input,
      messages,
      drafts,
      updatedAt,
    }))

    onExplainStateChange(nextState, activeRunId ? undefined : { immediate: true })
  }, [activeRunId, drafts, explainState, input, messages, onExplainStateChange, threadId])

  useLayoutEffect(() => {
    const pendingInitialScrollTarget = pendingInitialScrollTargetRef.current
    if (!pendingInitialScrollTarget) {
      return
    }

    applyInitialScrollTarget(pendingInitialScrollTarget)
    pendingInitialScrollTargetRef.current = null
    skipAutoScrollRef.current = true
  }, [drafts, messages])

  useLayoutEffect(() => {
    if (skipAutoScrollRef.current) {
      skipAutoScrollRef.current = false
      return
    }

    scrollToBottom()
  }, [messages, drafts, streamStatus.phase])

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

  useEffect(() => {
    if (!requestInterceptInput) {
      return
    }

    const trimmedInput = input.trim()
    if (!trimmedInput || trimmedInput === requestInterceptInput) {
      return
    }

    if (shouldBypassRequestInterceptForExplain(trimmedInput, requestInterceptInput)) {
      return
    }

    setRequestInterceptInput(null)
  }, [input, requestInterceptInput])

  useEffect(() => {
    const threadKey = activeThreadKeyRef.current

    if (!projectId || !threadKey || !activeRunId) {
      return
    }

    if (connectedRunIdRef.current === activeRunId) {
      return
    }

    void connectToBackgroundRun(activeRunId, threadKey, activeRunKind)
  }, [activeRunId, activeRunKind, projectId])

  const setFreshStreamStatus = (phase: StreamPhase, label: string, detail?: string) => {
    const startedAt = Date.now()
    setNow(startedAt)
    setStreamStatus({
      phase,
      label,
      detail,
      startedAt,
      updatedAt: startedAt,
    })
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

  const syncRunActivity = (
    nextRunId: string | undefined,
    nextRunKind: BackgroundRunKind | undefined,
    status: BackgroundRunStatus | undefined
  ) => {
    const isActiveRun = isActiveBackgroundRunStatus(status)
    const resolvedRunId = isActiveRun ? nextRunId : undefined
    const resolvedRunKind = isActiveRun ? nextRunKind : undefined

    currentRunIdRef.current = resolvedRunId
    currentRunKindRef.current = resolvedRunKind
    if (!resolvedRunId) {
      connectedRunIdRef.current = undefined
    }
    setActiveRunId(resolvedRunId)
    setActiveRunKind(resolvedRunKind)
    setIsStreaming(Boolean(resolvedRunKind === 'explain_reply' && resolvedRunId))
    setIsGeneratingDraft(Boolean(resolvedRunKind === 'explain_request_draft' && resolvedRunId))
  }

  const commitDraftToThread = (threadKey: string, nextDraft: ChatRequestDraft) => {
    if (discardedDraftIdsRef.current.has(nextDraft.id)) {
      return
    }

    if (activeThreadKeyRef.current === threadKey) {
      setDrafts((prev) => upsertDraftList(prev, nextDraft))
      return
    }

    onExplainStateChange((currentState) =>
      updateExplainThreadState(currentState, threadKey, (thread) => ({
        ...thread,
        drafts: upsertDraftList(thread.drafts, nextDraft),
        updatedAt: new Date().toISOString(),
      }))
    )
  }

  const buildRequestDraftMessages = (pendingInput?: string) => {
    const nextMessages = messages
      .filter((message) => message.content.trim())
      .map((message) => ({
        role: message.role,
        content: message.content.trim(),
      }))
    const pendingUserInput = pendingInput?.trim()

    if (pendingUserInput) {
      nextMessages.push({
        role: 'user',
        content: pendingUserInput,
      })
    }

    return nextMessages
  }

  const buildExistingDraftPayload = (draft: ChatRequestDraft) => ({
    title: draft.title,
    categoryId: draft.categoryId,
    template: draft.template,
    rationale: draft.rationale,
  })

  const connectToBackgroundRun = async (
    runId: string,
    threadKey: string,
    initialRunKind?: BackgroundRunKind
  ) => {
    const streamSessionId = activeStreamSessionRef.current + 1
    activeStreamSessionRef.current = streamSessionId
    clearPendingDeltaState()
    connectedRunIdRef.current = runId
    syncRunActivity(runId, initialRunKind, 'running')

    const isCurrentStream = () =>
      activeStreamSessionRef.current === streamSessionId &&
      activeThreadKeyRef.current === threadKey &&
      currentRunIdRef.current === runId

    await startEventStream(`/api/background-runs/${encodeURIComponent(runId)}/events`, {
      onInit: (data) => {
        if (!isCurrentStream()) {
          return
        }

        const run =
          data && typeof data.run === 'object' && data.run !== null
            ? (data.run as {
                kind?: BackgroundRunKind
                status?: BackgroundRunStatus
                latestLabel?: string
                latestDetail?: string
              })
            : undefined
        const nextRunKind = run?.kind ?? initialRunKind

        syncRunActivity(runId, nextRunKind, run?.status)

        if (run?.status === 'stopping') {
          updateStreamStatus('stopping', run.latestLabel ?? '중단 요청 중', run.latestDetail)
          return
        }

        if (nextRunKind === 'explain_request_draft') {
          updateStreamStatus('tool', run?.latestLabel ?? '요청 초안 정리 중', run?.latestDetail)
          return
        }

        updateStreamStatus('waiting', run?.latestLabel ?? '응답 준비 중', run?.latestDetail)
      },
      onState: (data) => {
        if (!isCurrentStream()) {
          return
        }

        const nextRunKind = currentRunKindRef.current ?? initialRunKind
        const label = typeof data.label === 'string' ? data.label : '작업 진행 중'
        const detail = typeof data.detail === 'string' ? data.detail : undefined

        if (label.includes('중단')) {
          updateStreamStatus('stopping', label, detail)
          return
        }

        updateStreamStatus(nextRunKind === 'explain_request_draft' ? 'tool' : 'waiting', label, detail)
      },
      onDelta: (data) => {
        if (!isCurrentStream() || currentRunKindRef.current !== 'explain_reply' || !data.text) {
          return
        }

        if (shouldQueueExplainDeltas(textEffect)) {
          pendingDeltaRef.current += data.text
          schedulePendingDeltaFlush(streamSessionId, threadKey)
        } else {
          appendAssistantDelta(data.text)
        }

        updateStreamStatus('answering', '답변 생성 중', '수집한 근거를 바탕으로 답변을 작성하고 있습니다.')
      },
      onToolUse: (data) => {
        if (!isCurrentStream() || currentRunKindRef.current !== 'explain_reply') {
          return
        }

        const toolActivity = describeToolActivity(data.tool)
        updateStreamStatus('tool', toolActivity.label, toolActivity.detail)

        if (data.tool !== REQUEST_DRAFT_TOOL_NAME) {
          return
        }

        setDrafts((prev) => {
          if (prev.some((draft) => draft.id === data.id)) {
            return prev
          }

          const createdAt = new Date().toISOString()
          return [
            ...prev,
            {
              id: data.id,
              title: '',
              categoryId: normalizeCategoryId(undefined, config.flows.ticket.categories),
              template: createEmptyRequestTemplate(),
              explainThreadId: threadIdRef.current,
              status: 'drafting',
              createdAt,
              updatedAt: createdAt,
            },
          ]
        })
      },
      onToolResult: (data) => {
        if (!isCurrentStream() || currentRunKindRef.current !== 'explain_reply') {
          return
        }

        const toolActivity = describeToolActivity(data.tool, data.error)
        updateStreamStatus(
          'waiting',
          data.error ? toolActivity.label : '답변 정리 중',
          data.error ? toolActivity.detail : `${toolActivity.label}이(가) 끝나 답변을 정리하고 있습니다.`
        )

        if (data.tool !== REQUEST_DRAFT_TOOL_NAME) {
          return
        }

        const updatedAt = new Date().toISOString()
        const parsed = parseDraftResult(data.result, config.flows.ticket.categories)

        setDrafts((prev) => {
          const next = [...prev]
          const index = next.findIndex((draft) => draft.id === data.id)

          if (!parsed) {
            const failedDraft: ChatRequestDraft = {
              id: data.id,
              title: '',
              categoryId: normalizeCategoryId(undefined, config.flows.ticket.categories),
              template: createEmptyRequestTemplate(),
              explainThreadId: threadIdRef.current,
              status: 'error',
              error: data.error || 'Codex request draft 결과를 해석하지 못했습니다.',
              createdAt: updatedAt,
              updatedAt,
            }

            if (index === -1) {
              next.push(failedDraft)
            } else {
              next[index] = {
                ...next[index],
                ...failedDraft,
                createdAt: next[index]?.createdAt ?? updatedAt,
              }
            }

            return next
          }

          const completedDraft: ChatRequestDraft = {
            id: data.id,
            ...parsed,
            explainThreadId: threadIdRef.current,
            status: data.error ? 'error' : 'draft',
            error: data.error,
            createdAt: index === -1 ? updatedAt : next[index]!.createdAt,
            updatedAt,
          }

          if (index === -1) {
            next.push(completedDraft)
          } else {
            next[index] = {
              ...next[index],
              ...completedDraft,
            }
          }

          return next
        })
      },
      onDone: (data) => {
        if (!isCurrentStream()) {
          return
        }

        const completedRunKind = currentRunKindRef.current ?? initialRunKind
        syncRunActivity(undefined, completedRunKind, data.status === 'stopped' ? 'stopped' : 'completed')

        if (completedRunKind === 'explain_request_draft') {
          const draftId = typeof data.draftId === 'string' ? data.draftId : undefined
          const draftResult = parseDraftResult(data.draft, config.flows.ticket.categories)
          const updatedAt = new Date().toISOString()

          if (draftId) {
            setDrafts((prev) =>
              prev.map((draft) =>
                draft.id === draftId
                  ? {
                      ...draft,
                      ...(draftResult
                        ? {
                            ...draftResult,
                            status: 'draft' as const,
                            error: undefined,
                          }
                        : data.status === 'stopped'
                          ? {
                              status: 'error' as const,
                              error:
                                typeof data.error === 'string'
                                  ? data.error
                                  : '요청 초안 생성이 중단되었습니다.',
                            }
                          : {}),
                      updatedAt,
                    }
                  : draft
              )
            )
          }

          if (data.status === 'stopped') {
            updateStreamStatus(
              'stopped',
              '요청 초안 중단됨',
              typeof data.error === 'string' ? data.error : '요청 초안 생성이 중단되었습니다.'
            )
            return
          }

          clearStreamStatus()
          return
        }

        flushPendingDelta(streamSessionId, threadKey, { immediate: true })

        const resolvedThreadId =
          typeof data.threadId === 'string'
            ? data.threadId
            : threadIdRef.current
        const resolvedFinalResponse =
          typeof data.finalResponse === 'string'
            ? data.finalResponse
            : undefined
        const updatedAt = new Date().toISOString()

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
                  resolvedFinalResponse
                )
              )
            )
          )
          onExplainStateChange(
            (currentState) =>
              completeExplainReplyThreadState(currentState, threadKey, {
                threadId: resolvedThreadId,
                finalResponse: resolvedFinalResponse,
                stopped: true,
                updatedAt,
              }),
            { immediate: true }
          )
          updateStreamStatus('stopped', '응답 중단됨', '질문을 수정해서 다시 보낼 수 있습니다.')
          return
        }

        setMessages((prev) =>
          updateLastAssistantMessage(prev, (current) =>
            resolveCompletedAssistantContent(
              current,
              resolvedFinalResponse
            )
          )
        )

        onExplainStateChange(
          (currentState) =>
            completeExplainReplyThreadState(currentState, threadKey, {
              threadId: resolvedThreadId,
              finalResponse: resolvedFinalResponse,
              updatedAt,
            }),
          { immediate: true }
        )

        const normalizedFinalResponse = resolvedFinalResponse?.trim() ?? ''
        if (!normalizedFinalResponse && !data.hadAssistantDelta) {
          updateStreamStatus(
            'error',
            '응답 내용이 비어 있습니다',
            'Codex가 표시할 답변 텍스트 없이 종료되었습니다. 질문을 조금 더 구체적으로 바꿔 다시 시도해 주세요.'
          )
          return
        }

        clearStreamStatus()
      },
      onError: (data) => {
        if (!isCurrentStream()) {
          return
        }

        const failedRunKind = currentRunKindRef.current ?? initialRunKind
        syncRunActivity(undefined, failedRunKind, 'failed')

        if (failedRunKind === 'explain_request_draft') {
          const draftId = typeof (data as Record<string, unknown>).draftId === 'string'
            ? ((data as Record<string, unknown>).draftId as string)
            : undefined

          if (draftId) {
            setDrafts((prev) =>
              prev.map((draft) =>
                draft.id === draftId
                  ? {
                      ...draft,
                      status: 'error',
                      error: data.message,
                      updatedAt: new Date().toISOString(),
                    }
                  : draft
              )
            )
          }

          updateStreamStatus('error', '요청 초안 생성 실패', data.message)
          return
        }

        flushPendingDelta(streamSessionId, threadKey, { immediate: true })
        setMessages((prev) =>
          updateLastAssistantMessage(prev, (current) =>
            current ? `${current}\n\n**Error**: ${data.message}` : `**Error**: ${data.message}`
          )
        )
        onExplainStateChange(
          (currentState) =>
            failExplainReplyThreadState(currentState, threadKey, {
              threadId: threadIdRef.current,
              errorMessage: data.message,
              updatedAt: new Date().toISOString(),
            }),
          { immediate: true }
        )
        updateStreamStatus('error', '응답 생성 실패', data.message)
      },
    })
  }

  const createRequestDraft = async (
    intent: 'manual' | 'implementation_request',
    pendingInput?: string,
    options?: {
      draftId?: string
    }
  ) => {
    if (isStreaming || isGeneratingDraft) {
      return
    }

    const threadKey = activeThreadKeyRef.current
    if (!threadKey) {
      return
    }

    const sourceMessages = buildRequestDraftMessages(pendingInput)
    if (sourceMessages.length === 0) {
      return
    }

    const existingDraft = options?.draftId ? drafts.find((entry) => entry.id === options.draftId) : undefined
    const requestedAt = new Date().toISOString()
    const draftId = existingDraft?.id ?? createDraftKey()
    const createdAt = existingDraft?.createdAt ?? requestedAt
    const sourceExplainThreadId = threadIdRef.current
    discardedDraftIdsRef.current.delete(draftId)
    commitDraftToThread(threadKey, {
      ...(existingDraft ?? {
        id: draftId,
        title: '',
        categoryId: normalizeCategoryId(undefined, config.flows.ticket.categories),
        template: createEmptyRequestTemplate(),
        createdAt,
      }),
      id: draftId,
      explainThreadId: sourceExplainThreadId,
      status: 'drafting',
      error: undefined,
      updatedAt: requestedAt,
    })

    setIsGeneratingDraft(true)
    setRequestInterceptInput(null)
    setFreshStreamStatus(
      'tool',
      existingDraft ? '요청 초안 다시 정리 중' : '요청 초안 정리 중',
      existingDraft
        ? '현재 초안과 최신 대화를 함께 반영해 request draft를 다시 정리하고 있습니다.'
        : intent === 'implementation_request'
        ? '구현 요청을 request draft로 전환하고 있습니다.'
        : '현재 대화를 request draft로 정리하고 있습니다.'
    )

    try {
      const started = await startExplainRequestDraftRun({
        projectId,
        threadKey,
        scopeLabel: explainState?.threads.find((thread) => thread.id === threadKey)?.title || threadKey,
        messages: sourceMessages,
        model,
        reasoningEffort,
        intent,
        existingDraft: existingDraft ? buildExistingDraftPayload(existingDraft) : undefined,
        draft: {
          ...(existingDraft ?? {
            id: draftId,
            title: '',
            categoryId: normalizeCategoryId(undefined, config.flows.ticket.categories),
            template: createEmptyRequestTemplate(),
            createdAt,
            updatedAt: requestedAt,
          }),
          id: draftId,
          explainThreadId: sourceExplainThreadId,
          status: 'drafting',
          error: undefined,
          createdAt,
          updatedAt: requestedAt,
        },
      })

      syncRunActivity(started.run.id, 'explain_request_draft', started.run.status)
      if (pendingInput?.trim() && input.trim() === pendingInput.trim()) {
        setInput('')
      }
      onExplainStateChange(
        (currentState) =>
          updateExplainThreadState(currentState, threadKey, (thread) => ({
            ...thread,
            activeRunId: started.run.id,
            updatedAt: new Date().toISOString(),
          })),
        { immediate: true }
      )
    } catch (error) {
      if (discardedDraftIdsRef.current.has(draftId)) {
        return
      }

      syncRunActivity(undefined, undefined, undefined)
      commitDraftToThread(threadKey, {
        id: draftId,
        title: existingDraft?.title ?? '',
        categoryId: existingDraft?.categoryId ?? normalizeCategoryId(undefined, config.flows.ticket.categories),
        template: existingDraft?.template ?? createEmptyRequestTemplate(),
        rationale: existingDraft?.rationale,
        explainThreadId: sourceExplainThreadId,
        status: 'error',
        error: error instanceof Error ? error.message : '요청 초안 생성에 실패했습니다.',
        createdAt,
        updatedAt: new Date().toISOString(),
      })
      updateStreamStatus(
        'error',
        '요청 초안 생성 실패',
        error instanceof Error ? error.message : '요청 초안 생성에 실패했습니다.'
      )
    }
  }

  const refineDraft = async (draftId: string) => {
    await createRequestDraft('manual', undefined, { draftId })
  }

  const discardDraft = (draftId: string) => {
    const threadKey = activeThreadKeyRef.current
    if (!threadKey) {
      return
    }

    const discardedDraft = drafts.find((entry) => entry.id === draftId)

    discardedDraftIdsRef.current.add(draftId)

    if (
      discardedDraft?.status === 'drafting' &&
      activeRunId &&
      currentRunKindRef.current === 'explain_request_draft'
    ) {
      void stopBackgroundRun(activeRunId).catch((error) => {
        console.error('Failed to stop discarded explain draft run:', error)
      })
    }

    if (activeThreadKeyRef.current === threadKey) {
      setDrafts((prev) => prev.filter((entry) => entry.id !== draftId))
    }

    onExplainStateChange((currentState) => removeExplainDraftState(currentState, threadKey, draftId))

    if (streamStatus.phase === 'tool' || streamStatus.phase === 'error') {
      clearStreamStatus()
    }
  }

  const persistExplainSettings = async (
    nextModel: string,
    nextReasoningEffort: typeof reasoningEffort,
    nextInterceptImplementationRequests: boolean
  ) => {
    if (!projectId) {
      return
    }

    await updateExplainSettings({
      projectId,
      model: nextModel,
      reasoningEffort: nextReasoningEffort,
      interceptImplementationRequests: nextInterceptImplementationRequests,
    })
    await onConfigUpdated()
  }

  const persistChatSettings = async (nextInitialScrollTarget: AppConfig['chat']['initialScrollTarget']) => {
    if (!projectId) {
      return
    }

    await updateChatSettings({
      projectId,
      initialScrollTarget: nextInitialScrollTarget,
    })
    await onConfigUpdated()
  }

  const beginEdit = (messageId: string) => {
    if (isStreaming) {
      return
    }

    const targetIndex = messages.findIndex((message) => message.id === messageId && message.role === 'user')
    if (targetIndex === -1) {
      return
    }

    const targetMessage = messages[targetIndex]
    setEditingSession({
      messageId,
      originalContent: targetMessage.content,
      previousInput: input,
      hadFollowUp: targetIndex < messages.length - 1 || drafts.length > 0,
    })
    setInput(targetMessage.content)
    scrollToBottom()
  }

  const cancelEdit = () => {
    setInput(editingSession?.previousInput ?? '')
    setEditingSession(null)
  }

  const stopStreaming = () => {
    if (!activeRunId) {
      return
    }

    updateStreamStatus(
      'stopping',
      '중단 요청 중',
      activeRunKind === 'explain_request_draft'
        ? '현재 실행 중인 요청 초안 생성을 멈추고 있습니다.'
        : '현재 실행 중인 응답을 멈추고 있습니다.'
    )
    void stopBackgroundRun(activeRunId).catch((error) => {
      updateStreamStatus(
        'error',
        '중단 요청 실패',
        error instanceof Error ? error.message : '응답 중단 요청에 실패했습니다.'
      )
    })
  }

  const acceptRequestIntercept = () => {
    if (!requestInterceptInput || !canCreateRequests || isGeneratingDraft) {
      return
    }

    void createRequestDraft('implementation_request', requestInterceptInput)
  }

  const declineRequestIntercept = () => {
    if (!requestInterceptInput || isGeneratingDraft) {
      return
    }

    const nextMessage = requestInterceptInput
    setRequestInterceptInput(null)
    void send({
      bypassRequestIntercept: true,
      messageOverride: nextMessage,
    })
  }

  const send = async (options?: { bypassRequestIntercept?: boolean; messageOverride?: string }) => {
    let message = options?.messageOverride?.trim() ?? input.trim()
    let bypassRequestIntercept = options?.bypassRequestIntercept ?? false

    if (!bypassRequestIntercept && shouldBypassRequestInterceptForExplain(message, requestInterceptInput)) {
      message = requestInterceptInput?.trim() ?? message
      bypassRequestIntercept = true
    }

    if (!message || isStreaming || isGeneratingDraft) {
      return
    }

    if (
      !bypassRequestIntercept &&
      shouldInterceptImplementationRequestForExplain(message, interceptImplementationRequests)
    ) {
      setRequestInterceptInput(message)
      return
    }

    const streamThreadKey = activeThreadKeyRef.current
    if (!streamThreadKey) {
      return
    }

    clearPendingDeltaState()
    const activeEditSession = editingSession
    const { messages: nextMessages, truncated } = buildNextExplainMessages(messages, message, {
      editMessageId: activeEditSession?.messageId,
    })
    const activeThreadId = activeEditSession ? undefined : threadIdRef.current

    setInput('')
    setRequestInterceptInput(null)
    setEditingSession(null)
    setMessages(nextMessages)
    const conversationUpdatedAt = new Date().toISOString()

    onExplainStateChange(
      (currentState) =>
        updateExplainThreadState(currentState, streamThreadKey, (thread) => ({
          ...thread,
          threadId: truncated ? undefined : activeThreadId,
          composerDraft: '',
          messages: nextMessages,
          drafts: truncated ? [] : drafts,
          sortUpdatedAt: conversationUpdatedAt,
          updatedAt: conversationUpdatedAt,
        })),
      { immediate: true }
    )

    if (truncated) {
      setDrafts([])
      setThreadId(undefined)
      threadIdRef.current = undefined
    }

    setIsStreaming(true)
    setFreshStreamStatus(
      'submitting',
      activeEditSession ? '수정한 질문 다시 보내는 중' : '질문 전송 중',
      activeEditSession
        ? '선택한 질문부터 새 스레드로 다시 시작합니다.'
        : 'Codex 세션에 질문을 전달하고 있습니다.'
    )

    try {
      const started = await startExplainBackgroundRun({
        message,
        threadId: activeThreadId,
        threadKey: streamThreadKey,
        projectId,
        model,
        reasoningEffort,
        scopeLabel: explainState?.threads.find((thread) => thread.id === streamThreadKey)?.title || streamThreadKey,
        messages: nextMessages,
        drafts: truncated ? [] : drafts,
      })

      syncRunActivity(started.run.id, 'explain_reply', started.run.status)

      onExplainStateChange(
        (currentState) =>
          updateExplainThreadState(currentState, streamThreadKey, (thread) => ({
            ...thread,
            activeRunId: started.run.id,
            updatedAt: new Date().toISOString(),
          })),
        { immediate: true }
      )
    } catch (error) {
      syncRunActivity(undefined, undefined, undefined)
      setMessages((prev) =>
        updateLastAssistantMessage(prev, (current) =>
          current
            ? `${current}\n\n**Error**: ${error instanceof Error ? error.message : '응답 생성에 실패했습니다.'}`
            : `**Error**: ${error instanceof Error ? error.message : '응답 생성에 실패했습니다.'}`
        )
      )
      updateStreamStatus(
        'error',
        '응답 생성 실패',
        error instanceof Error ? error.message : '응답 생성에 실패했습니다.'
      )
    }
  }

  const updateDraft = (draftId: string, patch: Partial<ChatRequestDraft>) => {
    setDrafts((prev) =>
      prev.map((draft) =>
        draft.id === draftId
          ? {
              ...draft,
              ...patch,
              updatedAt: new Date().toISOString(),
            }
          : draft
      )
    )
  }

  const saveDraft = async (draftId: string) => {
    const draft = drafts.find((entry) => entry.id === draftId)
    if (!draft || draft.status === 'saving' || draft.status === 'saved') {
      return
    }

    const threadKey = activeThreadKeyRef.current
    if (!threadKey) {
      return
    }

    updateDraft(draftId, { status: 'saving', error: undefined })

    try {
      const request = await createClientRequest({
        requester: CHAT_REQUESTER,
        title: draft.title.trim(),
        template: draft.template,
        projectId,
        categoryId: draft.categoryId,
        source: 'chat',
        explainThreadId: draft.explainThreadId ?? threadIdRef.current,
      })

      if (activeThreadKeyRef.current === threadKey) {
        setDrafts((prev) => prev.filter((entry) => entry.id !== draftId))
      } else {
        onExplainStateChange((currentState) => removeExplainDraftState(currentState, threadKey, draftId))
      }

      void Promise.resolve(onRequestCreated?.(request)).catch((error) => {
        console.error('Failed to sync client requests after saving draft:', error)
      })
    } catch (error) {
      const patch = {
        status: 'error' as const,
        error: error instanceof Error ? error.message : 'Request 저장에 실패했습니다.',
      }

      if (activeThreadKeyRef.current === threadKey) {
        updateDraft(draftId, patch)
      } else {
        onExplainStateChange((currentState) => updateExplainDraftState(currentState, threadKey, draftId, patch))
      }
    }
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      requestInterceptInput &&
      !e.shiftKey &&
      !e.altKey &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.nativeEvent.isComposing
    ) {
      if (e.key === '1') {
        e.preventDefault()
        acceptRequestIntercept()
        return
      }

      if (e.key === '2') {
        e.preventDefault()
        declineRequestIntercept()
        return
      }
    }

    if (e.key === 'Escape' && editingSession) {
      e.preventDefault()
      cancelEdit()
      return
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void send()
    }
  }

  const subtitle = editingSession
    ? '선택한 질문부터 새 스레드로 다시 시작합니다'
    : threadId
      ? '기존 대화를 이어가는 중'
      : '새 Codex 대화를 시작합니다'
  const elapsedLabel =
    streamStatus.startedAt && (isStreaming || isGeneratingDraft) ? formatElapsed(now - streamStatus.startedAt) : undefined
  const statusMeta = [streamStatus.detail, elapsedLabel].filter(Boolean).join(' · ')
  const showStatusPanel = streamStatus.phase === 'stopped' || streamStatus.phase === 'error'
  const sendButtonLabel = editingSession ? '다시 보내기' : '보내기'
  const requestButtonEnabled = Boolean(
    hasActiveThread && projectId && (messages.some((message) => message.content.trim()) || input.trim())
  )

  return (
    <div className="flex h-full flex-col">
      <WorkspaceHeader
        authSession={config.auth.session}
        projects={config.allowedProjects}
        projectId={projectId}
        onProjectChange={onProjectChange}
        onConfigUpdated={onConfigUpdated}
        title="Explain Mode"
        subtitle={subtitle}
        controls={
          <>
            <select
              value={model}
              disabled={isStreaming || isGeneratingDraft || !canManageExplainSettings}
              onChange={async (e) => {
                const nextModel = e.target.value
                const nextCapability =
                  config.explain.availableModels.find((entry) => entry.id === nextModel) ??
                  config.explain.availableModels[0]
                const nextReasoningEffort = nextCapability.defaultReasoningEffort
                setModel(nextModel)
                setReasoningEffort(nextReasoningEffort)
                await persistExplainSettings(
                  nextModel,
                  nextReasoningEffort,
                  interceptImplementationRequests
                )
              }}
              className="w-40 rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm focus:border-zinc-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
            >
              {config.explain.availableModels.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
            <select
              value={reasoningEffort}
              disabled={isStreaming || isGeneratingDraft || !canManageExplainSettings}
              onChange={async (e) => {
                const nextReasoningEffort = e.target.value as typeof reasoningEffort
                setReasoningEffort(nextReasoningEffort)
                await persistExplainSettings(
                  model,
                  nextReasoningEffort,
                  interceptImplementationRequests
                )
              }}
              className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm focus:border-zinc-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
            >
              {selectedModelCapability?.supportedReasoningEfforts.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
            <select
              aria-label="Explain implementation request handling"
              value={interceptImplementationRequests ? 'intercept' : 'explain_only'}
              disabled={isStreaming || isGeneratingDraft || !canManageExplainSettings}
              onChange={async (e) => {
                const nextInterceptImplementationRequests = e.target.value === 'intercept'
                setInterceptImplementationRequests(nextInterceptImplementationRequests)
                await persistExplainSettings(
                  model,
                  reasoningEffort,
                  nextInterceptImplementationRequests
                )
              }}
              className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm focus:border-zinc-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
            >
              <option value="intercept">자동 request 제안</option>
              <option value="explain_only">설명만</option>
            </select>
            <select
              aria-label="Chat initial scroll target"
              value={config.chat.initialScrollTarget}
              disabled={isStreaming || isGeneratingDraft || !projectId}
              onChange={async (e) => {
                await persistChatSettings(e.target.value as AppConfig['chat']['initialScrollTarget'])
              }}
              className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm focus:border-zinc-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
            >
              {CHAT_INITIAL_SCROLL_TARGET_OPTIONS.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
            <select
              aria-label="Explain text effect"
              value={textEffect}
              disabled={isStreaming || isGeneratingDraft}
              onChange={(e) => {
                const nextTextEffect = normalizeExplainTextEffect(e.target.value)
                setTextEffect(nextTextEffect)
                onExplainStateChange(
                  (currentState) => ({
                    ...currentState,
                    textEffect: nextTextEffect,
                  }),
                  { immediate: true }
                )
              }}
              className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm focus:border-zinc-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
            >
              {EXPLAIN_TEXT_EFFECT_OPTIONS.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </>
        }
      />

      <div
        ref={scrollViewportRef}
        className="flex-1 overflow-y-auto overflow-x-hidden px-4 sm:px-6 lg:px-8"
      >
        <div className="mx-auto w-full max-w-4xl min-w-0">
          {continuityNotice ? (
            <div className="mt-4 rounded-2xl border border-amber-900/70 bg-amber-950/20 px-4 py-3 text-amber-100">
              <p className="text-sm font-medium">세션 복구됨</p>
              <p className="mt-1 text-xs text-amber-100/80">{continuityNotice}</p>
            </div>
          ) : null}
          {messages.length === 0 && drafts.length === 0 ? (
            <div className="flex h-full min-h-[60vh] items-center justify-center text-zinc-500">
              <div className="text-center">
                <p className="text-lg font-medium">Explain Mode</p>
                <p className="mt-1 text-sm">
                  {hasActiveThread ? '프로젝트에 대해 질문하세요' : '현재 explain thread가 없습니다. 왼쪽에서 New Thread를 눌러 시작하세요'}
                </p>
              </div>
            </div>
          ) : (
            <>
              {messages.map((message, index) => {
                const isPendingAssistant =
                  isStreaming && message.role === 'assistant' && index === messages.length - 1

                return (
                  <div key={message.id} ref={message.role === 'user' ? registerUserMessageAnchor(message.id) : undefined}>
                    <ChatMessage
                      role={message.role}
                      content={message.content}
                      canEdit={message.role === 'user' && !isStreaming}
                      onEdit={message.role === 'user' ? () => beginEdit(message.id) : undefined}
                      isPending={isPendingAssistant}
                      pendingLabel={isPendingAssistant ? streamStatus.label : undefined}
                      pendingDetail={isPendingAssistant ? statusMeta : undefined}
                      streamTextEffect={isPendingAssistant ? textEffect : 'plain'}
                    />
                  </div>
                )
              })}
              {drafts.length > 0 ? (
                <div className="space-y-4 py-4">
                  {drafts.map((draft) => (
                    <ChatRequestDraftCard
                      key={draft.id}
                      draft={draft}
                      categories={config.flows.ticket.categories}
                      onChange={updateDraft}
                      onRefine={(draftId) => void refineDraft(draftId)}
                      onDiscard={discardDraft}
                      onSave={saveDraft}
                    />
                  ))}
                </div>
              ) : null}
            </>
          )}
          <div ref={bottomRef} />
        </div>
      </div>

      <div className="border-t border-zinc-800 p-4">
        <div className="mx-auto max-w-4xl space-y-3">
          {showStatusPanel ? (
            <div
              className={`rounded-2xl border px-4 py-3 ${streamStatusStyles(streamStatus.phase)}`}
              aria-live={isStreaming || isGeneratingDraft ? 'polite' : undefined}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-start gap-3">
                  <span
                    className={`mt-1.5 h-2.5 w-2.5 flex-none rounded-full ${streamIndicatorColor(streamStatus.phase)} ${
                      isStreaming || isGeneratingDraft ? 'animate-pulse' : ''
                    }`}
                  />
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{streamStatus.label}</p>
                    {statusMeta ? <p className="mt-1 text-xs opacity-80">{statusMeta}</p> : null}
                  </div>
                </div>
                {!isStreaming && !isGeneratingDraft ? (
                  <button
                    type="button"
                    onClick={clearStreamStatus}
                    className="rounded-lg bg-zinc-900/60 px-3 py-1.5 text-sm text-zinc-200 transition-colors hover:bg-zinc-800"
                  >
                    닫기
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}

          {requestInterceptInput ? (
            <div className="rounded-2xl border border-emerald-900/70 bg-emerald-950/20 px-4 py-3 text-emerald-100">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-medium">구현 요청으로 보입니다</p>
                  <p className="mt-1 text-xs text-emerald-100/80">
                    Explain 모드는 읽기 전용입니다.
                    {canCreateRequests
                      ? ' 이 요청을 request draft로 넘길까요?'
                      : ' 현재 토큰에는 request 생성 권한이 없어 draft로 넘길 수 없습니다.'}
                  </p>
                  <p className="mt-2 line-clamp-2 text-xs text-emerald-50/80">{requestInterceptInput}</p>
                </div>
                <button
                  type="button"
                  onClick={() => setRequestInterceptInput(null)}
                  className="rounded-lg bg-zinc-900/60 px-3 py-1.5 text-sm text-zinc-100 transition-colors hover:bg-zinc-800"
                >
                  닫기
                </button>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                {canCreateRequests ? (
                  <button
                    type="button"
                    onClick={acceptRequestIntercept}
                    disabled={isGeneratingDraft}
                    className="rounded-xl border border-emerald-700 bg-emerald-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-500 disabled:cursor-not-allowed disabled:border-zinc-800 disabled:bg-zinc-800 disabled:text-zinc-500"
                  >
                    1. Yes, make request
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={declineRequestIntercept}
                  disabled={isGeneratingDraft}
                  className="rounded-xl border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm font-medium text-zinc-200 transition-colors hover:bg-zinc-800 disabled:cursor-not-allowed disabled:border-zinc-800 disabled:bg-zinc-900 disabled:text-zinc-500"
                >
                  2. No, keep in explain
                </button>
              </div>
            </div>
          ) : null}

          {editingSession ? (
            <div className="rounded-2xl border border-amber-900/70 bg-amber-950/20 px-4 py-3 text-amber-100">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-medium">질문 수정 모드</p>
                  <p className="mt-1 text-xs text-amber-100/80">
                    {editingSession.hadFollowUp
                      ? '이 질문 이후의 답변과 request draft는 다시 계산됩니다.'
                      : '이 질문을 수정해서 새 스레드로 다시 보냅니다.'}
                  </p>
                  <p className="mt-2 line-clamp-2 text-xs text-amber-50/80">{editingSession.originalContent}</p>
                </div>
                <button
                  type="button"
                  onClick={cancelEdit}
                  className="rounded-lg bg-zinc-900/60 px-3 py-1.5 text-sm text-zinc-100 transition-colors hover:bg-zinc-800"
                >
                  취소
                </button>
              </div>
            </div>
          ) : null}

          <div className="flex items-start gap-2">
            <textarea
              ref={composerRef}
              value={input}
              disabled={!hasActiveThread || isGeneratingDraft}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={
                !hasActiveThread
                  ? '먼저 New Thread를 눌러 시작하세요...'
                  : editingSession
                  ? '질문을 수정하고 다시 보내세요... (Shift+Enter for newline)'
                  : '질문을 입력하세요... (Shift+Enter for newline)'
              }
              rows={1}
              className="flex-1 resize-none rounded-2xl border border-zinc-700 bg-zinc-900 px-4 py-3 text-sm placeholder-zinc-500 focus:border-zinc-500 focus:outline-none disabled:cursor-not-allowed disabled:border-zinc-800 disabled:bg-zinc-950 disabled:text-zinc-500"
            />
            {isStreaming || isGeneratingDraft ? (
              <button
                onClick={stopStreaming}
                disabled={streamStatus.phase === 'stopping'}
                className="min-w-[120px] shrink-0 rounded-2xl bg-red-600 px-4 py-2.5 text-sm font-medium transition-colors hover:bg-red-700 disabled:cursor-not-allowed disabled:bg-red-900/60"
              >
                {streamStatus.phase === 'stopping' ? '중단 중' : isGeneratingDraft ? '초안 중단' : '중단'}
              </button>
            ) : (
              <button
                onClick={() => void send()}
                disabled={!hasActiveThread || !input.trim() || !projectId || isGeneratingDraft}
                className="min-w-[120px] shrink-0 rounded-2xl bg-blue-600 px-4 py-2.5 text-sm font-medium transition-colors hover:bg-blue-700 disabled:bg-zinc-700 disabled:text-zinc-500"
              >
                {sendButtonLabel}
              </button>
            )}
            {canCreateRequests ? (
              <button
                type="button"
                onClick={() => void createRequestDraft('manual', input)}
                disabled={!requestButtonEnabled || isStreaming || isGeneratingDraft}
                className="min-w-[120px] shrink-0 rounded-2xl border border-emerald-800/70 bg-emerald-950/60 px-4 py-2.5 text-sm font-semibold text-emerald-100 transition-colors hover:border-emerald-700 hover:bg-emerald-900/70 disabled:cursor-not-allowed disabled:border-zinc-800 disabled:bg-zinc-900 disabled:text-zinc-500"
              >
                Request +
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  )
}
