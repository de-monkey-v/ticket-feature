import type { DirectSessionCreateResult, ExplainThreadCreateResult, Mode } from '../App'
import type { AppConfig, ClientRequest, IncidentSummary, TicketSummary } from '../lib/api'
import { useEffect, useRef, useState } from 'react'
import { getDirectAgentDescriptor, type DirectAgentRole, type DirectSessionSummary } from '../lib/direct-state'
import { type ExplainThreadSummary } from '../lib/explain-state'

function ticketRunStateLabel(runState: string) {
  if (runState === 'created') return '준비됨'
  if (runState === 'queued') return '대기 중'
  if (runState === 'running') return '실행 중'
  if (runState === 'stopped') return '중단됨'
  if (runState === 'blocked') return '일시 중단'
  if (runState === 'needs_decision') return '결정 필요'
  if (runState === 'needs_request_clarification') return '요구사항 보완 필요'
  if (runState === 'awaiting_merge') return '머지 대기'
  if (runState === 'completed') return '완료'
  if (runState === 'discarded') return '폐기됨'
  if (runState === 'failed') return '실패'
  return runState
}

function requestStatusLabel(status: ClientRequest['status']) {
  if (status === 'new') return '신규'
  if (status === 'ticket_created') return '티켓 생성됨'
  return status
}

function requestReadinessLabel(readinessStatus: ClientRequest['readinessStatus']) {
  if (readinessStatus === 'ready_for_ticket') return '티켓 생성 가능'
  if (readinessStatus === 'needs_clarification') return '보완 필요'
  return readinessStatus
}

function incidentStatusLabel(status: IncidentSummary['status']) {
  if (status === 'captured') return '분석 대기'
  if (status === 'analyzing') return '분석 중'
  if (status === 'analyzed') return '분석 완료'
  if (status === 'analysis_failed') return '분석 실패'
  return status
}

function incidentStatusBadge(status: IncidentSummary['status']) {
  if (status === 'analyzing') return 'bg-blue-950/40 text-blue-200'
  if (status === 'analyzed') return 'bg-emerald-950/40 text-emerald-200'
  if (status === 'analysis_failed') return 'bg-red-950/40 text-red-200'
  return 'bg-amber-950/40 text-amber-200'
}

function incidentTriggerLabel(kind: IncidentSummary['trigger']['kind']) {
  if (kind === 'analyze_failed') return '분석 실패'
  if (kind === 'verify_failed') return '검증 실패'
  if (kind === 'review_failed') return '리뷰 실패'
  if (kind === 'runner_exception') return '실행 예외'
  if (kind === 'retry_failed') return '재시도 실패'
  if (kind === 'merge_failed') return '머지 실패'
  if (kind === 'discard_failed') return '폐기 실패'
  return kind
}

function compactText(text?: string, maxLength = 96) {
  const normalized = (text ?? '').replace(/\s+/g, ' ').trim()
  if (!normalized) {
    return ''
  }

  if (normalized.length <= maxLength) {
    return normalized
  }

  return `${normalized.slice(0, maxLength - 1)}…`
}

function formatTimestamp(value: string) {
  return new Date(value).toLocaleString()
}

function authSessionKindLabel(kind: AppConfig['auth']['session']['kind']) {
  if (kind === 'account_session') return '계정 세션'
  if (kind === 'access_token') return 'Access token'
  if (kind === 'shared_admin') return 'Shared admin'
  return 'Open access'
}

function authSessionScopeLabel(session: AppConfig['auth']['session']) {
  if (session.isAdmin) {
    return '모든 프로젝트 · 전체 기능'
  }

  const projects = session.permissions.length > 0 ? session.permissions.join(', ') : '권한 없음'
  return `${projects} 권한`
}

function sessionListFeedbackStyles(kind: ExplainThreadCreateResult['kind'] | DirectSessionCreateResult['kind']) {
  if (kind === 'success') {
    return 'border-emerald-900/70 bg-emerald-950/20 text-emerald-200'
  }

  if (kind === 'info') {
    return 'border-sky-900/70 bg-sky-950/20 text-sky-200'
  }

  return 'border-red-900/70 bg-red-950/20 text-red-200'
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

function hasSessionPermission(
  session: Pick<AppConfig['auth']['session'], 'isAdmin' | 'permissions'>,
  permission: 'explain' | 'requests' | 'tickets' | 'direct'
) {
  return session.isAdmin || session.permissions.includes(permission)
}

interface TrashButtonProps {
  ariaLabel: string
  active: boolean
  disabled?: boolean
  title?: string
  onClick: () => void
}

function TrashButton({ ariaLabel, active, disabled = false, title, onClick }: TrashButtonProps) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      title={title}
      onClick={(event) => {
        event.stopPropagation()
        onClick()
      }}
      disabled={disabled}
      className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border transition-opacity transition-colors ${
        active
          ? 'border-zinc-700 bg-zinc-900 text-zinc-300 opacity-100 hover:border-red-800 hover:bg-red-950/30 hover:text-red-200'
          : 'border-zinc-900/80 bg-zinc-950/40 text-zinc-600 opacity-70 group-hover:border-zinc-800 group-hover:bg-zinc-900 group-hover:text-zinc-300 group-hover:opacity-100 group-focus-within:border-zinc-800 group-focus-within:bg-zinc-900 group-focus-within:text-zinc-300 group-focus-within:opacity-100 hover:border-zinc-800 hover:bg-zinc-900 hover:text-red-200 hover:opacity-100'
      } ${disabled ? 'pointer-events-none opacity-40' : 'pointer-events-auto'}`}
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 16 16"
        className="h-3.5 w-3.5 translate-y-px"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M5.5 3.25h5" />
        <path d="M3.75 4.75h8.5" />
        <path d="M5 4.75v6a1 1 0 0 0 1 1h4a1 1 0 0 0 1-1v-6" />
        <path d="M7 6.5v3.25" />
        <path d="M9 6.5v3.25" />
      </svg>
    </button>
  )
}

interface SidebarProps {
  mode: Mode
  onModeChange: (mode: Mode) => void
  onOpenExplainHome: () => void
  onOpenDirectHome: () => void
  onOpenRequestHome: () => void
  onCreateRequest: () => void
  onOpenTicketHome: () => void
  onCreateTicket: () => void
  onOpenIncidentHome: () => void
  tickets: TicketSummary[]
  requests: ClientRequest[]
  incidents: IncidentSummary[]
  selectedTicketId: string | null
  selectedRequestId: string | null
  selectedIncidentId: string | null
  onSelectTicket: (id: string) => void
  onSelectRequest: (id: string) => void
  onSelectIncident: (id: string) => void
  onDeleteTicket: (id: string) => Promise<void>
  onDeleteRequest: (id: string) => Promise<void>
  authSession: AppConfig['auth']['session']
  explainThreads: ExplainThreadSummary[]
  selectedExplainThreadId: string
  onSelectExplainThread: (id: string) => void
  onCreateExplainThread: () => Promise<ExplainThreadCreateResult>
  onDeleteExplainThread: (id: string) => Promise<void>
  onRenameExplainThread: (id: string, title: string) => Promise<void>
  directSessions: DirectSessionSummary[]
  selectedDirectSessionId: string
  onSelectDirectSession: (id: string) => void
  onCreateDirectSession: () => Promise<DirectSessionCreateResult>
  onDeleteDirectSession: (id: string) => Promise<void>
  onRenameDirectSession: (id: string, title: string) => Promise<void>
  onLogout: () => Promise<void>
}

interface ModeNavEntry {
  id: Mode
  label: string
  onClick: () => void
  count?: number | null
}

export function Sidebar({
  mode,
  onModeChange,
  onOpenExplainHome,
  onOpenDirectHome,
  onOpenRequestHome,
  onCreateRequest,
  onOpenTicketHome,
  onCreateTicket,
  onOpenIncidentHome,
  tickets,
  requests,
  incidents,
  selectedTicketId,
  selectedRequestId,
  selectedIncidentId,
  onSelectTicket,
  onSelectRequest,
  onSelectIncident,
  onDeleteTicket,
  onDeleteRequest,
  authSession,
  explainThreads,
  selectedExplainThreadId,
  onSelectExplainThread,
  onCreateExplainThread,
  onDeleteExplainThread,
  onRenameExplainThread,
  directSessions,
  selectedDirectSessionId,
  onSelectDirectSession,
  onCreateDirectSession,
  onDeleteDirectSession,
  onRenameDirectSession,
  onLogout,
}: SidebarProps) {
  const [isLoggingOut, setIsLoggingOut] = useState(false)
  const [logoutError, setLogoutError] = useState<string | null>(null)
  const [isCreatingExplainThread, setIsCreatingExplainThread] = useState(false)
  const [highlightedExplainThreadId, setHighlightedExplainThreadId] = useState<string | null>(null)
  const [explainThreadFeedback, setExplainThreadFeedback] = useState<{
    kind: ExplainThreadCreateResult['kind']
    message: string
  } | null>(null)
  const [deletingExplainThreadIds, setDeletingExplainThreadIds] = useState<string[]>([])
  const [editingExplainThreadId, setEditingExplainThreadId] = useState<string | null>(null)
  const [editingExplainThreadTitle, setEditingExplainThreadTitle] = useState('')
  const [isCreatingDirectSession, setIsCreatingDirectSession] = useState(false)
  const [highlightedDirectSessionId, setHighlightedDirectSessionId] = useState<string | null>(null)
  const [directSessionFeedback, setDirectSessionFeedback] = useState<{
    kind: DirectSessionCreateResult['kind']
    message: string
  } | null>(null)
  const [deletingDirectSessionIds, setDeletingDirectSessionIds] = useState<string[]>([])
  const [editingDirectSessionId, setEditingDirectSessionId] = useState<string | null>(null)
  const [editingDirectSessionTitle, setEditingDirectSessionTitle] = useState('')
  const [deletingTicketIds, setDeletingTicketIds] = useState<string[]>([])
  const [deletingRequestIds, setDeletingRequestIds] = useState<string[]>([])
  const [requestDeleteMessage, setRequestDeleteMessage] = useState<string | null>(null)
  const deleteTimersRef = useRef<Record<string, number>>({})
  const ignoreExplainRenameBlurRef = useRef(false)
  const ignoreDirectRenameBlurRef = useRef(false)

  useEffect(() => {
    return () => {
      Object.values(deleteTimersRef.current).forEach((timerId) => {
        window.clearTimeout(timerId)
      })
      deleteTimersRef.current = {}
    }
  }, [])

  useEffect(() => {
    if (editingExplainThreadId && !explainThreads.some((thread) => thread.id === editingExplainThreadId)) {
      setEditingExplainThreadId(null)
      setEditingExplainThreadTitle('')
    }
  }, [editingExplainThreadId, explainThreads])

  useEffect(() => {
    if (editingDirectSessionId && !directSessions.some((session) => session.id === editingDirectSessionId)) {
      setEditingDirectSessionId(null)
      setEditingDirectSessionTitle('')
    }
  }, [directSessions, editingDirectSessionId])

  const isExplainReady = explainThreads.length > 0
  const isDirectReady = directSessions.length > 0
  const canLogOut = authSession.kind !== 'open'
  const canUseExplain = hasSessionPermission(authSession, 'explain')
  const canUseDirect = hasSessionPermission(authSession, 'direct')
  const canUseRequests = hasSessionPermission(authSession, 'requests')
  const canUseTickets = hasSessionPermission(authSession, 'tickets')
  const workModes = [
    canUseExplain ? { id: 'explain' as const, label: 'Explain', onClick: onOpenExplainHome, count: explainThreads.length } : null,
    canUseDirect ? { id: 'direct' as const, label: 'Direct Dev', onClick: onOpenDirectHome, count: directSessions.length } : null,
    canUseRequests
      ? { id: 'requests' as const, label: 'Requests', onClick: onOpenRequestHome, count: requests.length }
      : null,
    canUseTickets
      ? { id: 'ticket' as const, label: 'Ticket', onClick: onOpenTicketHome, count: tickets.length }
      : null,
  ].filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
  const operationsModes = [
    canUseTickets && incidents.length > 0
      ? { id: 'incidents' as const, label: 'Incidents', onClick: onOpenIncidentHome, count: incidents.length }
      : null,
    authSession.isAdmin
      ? { id: 'access' as const, label: 'Access Control', onClick: () => onModeChange('access') }
      : null,
  ].filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))

  const renderModeButton = (entry: ModeNavEntry) => (
    <button
      key={entry.id}
      type="button"
      onClick={entry.onClick}
      className={`flex w-full items-center justify-between gap-3 rounded-xl border px-3 py-2 text-left text-sm font-medium transition-colors ${
        mode === entry.id
          ? 'border-blue-700 bg-blue-950/50 text-white'
          : 'border-zinc-800 bg-zinc-900/60 text-zinc-300 hover:border-zinc-700 hover:bg-zinc-800/80 hover:text-zinc-100'
      }`}
    >
      <span className="truncate">{entry.label}</span>
      {typeof entry.count === 'number' ? (
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] ${
            mode === entry.id ? 'bg-blue-800/80 text-blue-100' : 'bg-zinc-800 text-zinc-400'
          }`}
        >
          {entry.count}
        </span>
      ) : null}
    </button>
  )

  const handleDeleteExplainThread = (threadId: string) => {
    if (deletingExplainThreadIds.includes(threadId)) {
      return
    }

    setDeletingExplainThreadIds((current) => [...current, threadId])
    deleteTimersRef.current[threadId] = window.setTimeout(() => {
      void onDeleteExplainThread(threadId)
        .catch((error) => {
          console.error('Failed to delete explain thread:', error)
        })
        .finally(() => {
          setDeletingExplainThreadIds((current) => current.filter((id) => id !== threadId))
          delete deleteTimersRef.current[threadId]
        })
    }, 180)
  }

  const showExplainThreadFeedback = (kind: ExplainThreadCreateResult['kind'], message: string) => {
    const timerKey = 'explain-thread-feedback'
    if (deleteTimersRef.current[timerKey]) {
      window.clearTimeout(deleteTimersRef.current[timerKey])
    }

    setExplainThreadFeedback({ kind, message })
    deleteTimersRef.current[timerKey] = window.setTimeout(() => {
      setExplainThreadFeedback((current) => (current?.message === message ? null : current))
      delete deleteTimersRef.current[timerKey]
    }, 2200)
  }

  const startExplainThreadRename = (thread: ExplainThreadSummary) => {
    if (deletingExplainThreadIds.includes(thread.id)) {
      return
    }

    onSelectExplainThread(thread.id)
    setEditingExplainThreadId(thread.id)
    setEditingExplainThreadTitle(thread.title ?? thread.label)
  }

  const cancelExplainThreadRename = () => {
    setEditingExplainThreadId(null)
    setEditingExplainThreadTitle('')
  }

  const commitExplainThreadRename = async () => {
    if (!editingExplainThreadId) {
      return
    }

    const threadId = editingExplainThreadId
    const nextTitle = editingExplainThreadTitle
    cancelExplainThreadRename()

    try {
      await onRenameExplainThread(threadId, nextTitle)
    } catch (error) {
      showExplainThreadFeedback('error', error instanceof Error ? error.message : 'thread 제목을 저장하지 못했습니다.')
    }
  }

  const highlightExplainThread = (threadId: string) => {
    const timerKey = `explain-thread-highlight:${threadId}`
    if (deleteTimersRef.current[timerKey]) {
      window.clearTimeout(deleteTimersRef.current[timerKey])
    }

    setHighlightedExplainThreadId(threadId)
    deleteTimersRef.current[timerKey] = window.setTimeout(() => {
      setHighlightedExplainThreadId((current) => (current === threadId ? null : current))
      delete deleteTimersRef.current[timerKey]
    }, 1600)
  }

  const handleCreateExplainThreadClick = async () => {
    if (isCreatingExplainThread) {
      return
    }

    setIsCreatingExplainThread(true)

    try {
      const result = await onCreateExplainThread()
      showExplainThreadFeedback(result.kind, result.message)

      if (result.ok && result.threadId) {
        highlightExplainThread(result.threadId)
      }
    } catch (error) {
      showExplainThreadFeedback('error', error instanceof Error ? error.message : '새 explain thread를 만들지 못했습니다.')
    } finally {
      setIsCreatingExplainThread(false)
    }
  }

  const handleDeleteDirectSession = (sessionId: string) => {
    if (deletingDirectSessionIds.includes(sessionId)) {
      return
    }

    setDeletingDirectSessionIds((current) => [...current, sessionId])
    deleteTimersRef.current[sessionId] = window.setTimeout(() => {
      void onDeleteDirectSession(sessionId)
        .catch((error) => {
          console.error('Failed to delete direct session:', error)
        })
        .finally(() => {
          setDeletingDirectSessionIds((current) => current.filter((id) => id !== sessionId))
          delete deleteTimersRef.current[sessionId]
        })
    }, 180)
  }

  const showDirectSessionFeedback = (kind: DirectSessionCreateResult['kind'], message: string) => {
    const timerKey = 'direct-session-feedback'
    if (deleteTimersRef.current[timerKey]) {
      window.clearTimeout(deleteTimersRef.current[timerKey])
    }

    setDirectSessionFeedback({ kind, message })
    deleteTimersRef.current[timerKey] = window.setTimeout(() => {
      setDirectSessionFeedback((current) => (current?.message === message ? null : current))
      delete deleteTimersRef.current[timerKey]
    }, 2200)
  }

  const startDirectSessionRename = (session: DirectSessionSummary) => {
    if (deletingDirectSessionIds.includes(session.id)) {
      return
    }

    onSelectDirectSession(session.id)
    setEditingDirectSessionId(session.id)
    setEditingDirectSessionTitle(session.title ?? session.label)
  }

  const cancelDirectSessionRename = () => {
    setEditingDirectSessionId(null)
    setEditingDirectSessionTitle('')
  }

  const commitDirectSessionRename = async () => {
    if (!editingDirectSessionId) {
      return
    }

    const sessionId = editingDirectSessionId
    const nextTitle = editingDirectSessionTitle
    cancelDirectSessionRename()

    try {
      await onRenameDirectSession(sessionId, nextTitle)
    } catch (error) {
      showDirectSessionFeedback('error', error instanceof Error ? error.message : '세션 제목을 저장하지 못했습니다.')
    }
  }

  const highlightDirectSession = (sessionId: string) => {
    const timerKey = `direct-session-highlight:${sessionId}`
    if (deleteTimersRef.current[timerKey]) {
      window.clearTimeout(deleteTimersRef.current[timerKey])
    }

    setHighlightedDirectSessionId(sessionId)
    deleteTimersRef.current[timerKey] = window.setTimeout(() => {
      setHighlightedDirectSessionId((current) => (current === sessionId ? null : current))
      delete deleteTimersRef.current[timerKey]
    }, 1600)
  }

  const handleCreateDirectSessionClick = async () => {
    if (isCreatingDirectSession) {
      return
    }

    setIsCreatingDirectSession(true)

    try {
      const result = await onCreateDirectSession()
      showDirectSessionFeedback(result.kind, result.message)

      if (result.ok && result.sessionId) {
        highlightDirectSession(result.sessionId)
      }
    } catch (error) {
      showDirectSessionFeedback('error', error instanceof Error ? error.message : '새 Direct Dev 세션을 만들지 못했습니다.')
    } finally {
      setIsCreatingDirectSession(false)
    }
  }

  const handleDeleteTicket = async (ticketId: string) => {
    if (deletingTicketIds.includes(ticketId)) {
      return
    }

    setDeletingTicketIds((current) => [...current, ticketId])

    try {
      await onDeleteTicket(ticketId)
    } catch (error) {
      console.error('Failed to delete ticket:', error)
    } finally {
      setDeletingTicketIds((current) => current.filter((id) => id !== ticketId))
    }
  }

  const handleDeleteRequest = async (requestId: string) => {
    if (deletingRequestIds.includes(requestId)) {
      return
    }

    setRequestDeleteMessage(null)
    setDeletingRequestIds((current) => [...current, requestId])

    try {
      await onDeleteRequest(requestId)
    } catch (error) {
      console.error('Failed to delete client request:', error)
      setRequestDeleteMessage(error instanceof Error ? error.message : 'request를 삭제하지 못했습니다.')
    } finally {
      setDeletingRequestIds((current) => current.filter((id) => id !== requestId))
    }
  }

  const handleBlockedRequestDelete = (request: ClientRequest) => {
    setRequestDeleteMessage('연결된 ticket이 있는 request는 ticket을 먼저 삭제해야 합니다.')
    onSelectRequest(request.id)
  }

  const handleLogout = async () => {
    if (isLoggingOut) {
      return
    }

    setIsLoggingOut(true)
    setLogoutError(null)

    try {
      await onLogout()
    } catch (error) {
      const message = error instanceof Error ? error.message : '로그아웃에 실패했습니다.'
      setLogoutError(message)
    } finally {
      setIsLoggingOut(false)
    }
  }

  return (
    <div className="flex flex-col h-full">
      <div className="border-b border-zinc-800 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-lg font-bold">Intentlane</h1>
            {canLogOut ? (
              <p className="mt-1 truncate text-[11px] text-zinc-500">
                <span className="text-zinc-300">{authSession.accountName ?? authSession.label}</span>
                {` · ${authSessionKindLabel(authSession.kind)} · ${authSessionScopeLabel(authSession)}`}
              </p>
            ) : null}
          </div>

          {canLogOut ? (
            <button
              type="button"
              onClick={() => void handleLogout()}
              disabled={isLoggingOut}
              className="shrink-0 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs font-medium text-zinc-200 transition-colors hover:border-zinc-600 hover:bg-zinc-800 disabled:text-zinc-500"
            >
              {isLoggingOut ? '로그아웃 중…' : 'Log Out'}
            </button>
          ) : null}
        </div>

        {logoutError ? <p className="mt-2 text-xs text-red-300">{logoutError}</p> : null}
      </div>

      <div className="p-3 border-b border-zinc-800 space-y-4">
        <div>
          <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-zinc-500">Workspace</p>
          <div className="mt-2 space-y-2">
            {workModes.map((entry) => renderModeButton(entry))}
          </div>
        </div>

        {operationsModes.length > 0 ? (
          <div>
            <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-zinc-500">Operations</p>
            <div className="mt-2 space-y-2">
              {operationsModes.map((entry) => renderModeButton(entry))}
            </div>
          </div>
        ) : null}
      </div>

      {mode === 'explain' && canUseExplain && (
        <div className="flex-1 overflow-y-auto p-2">
          <div className="mb-3 px-1">
            <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-zinc-500">Explain Threads</p>
            <button
              type="button"
              onClick={() => {
                void handleCreateExplainThreadClick()
              }}
              disabled={isCreatingExplainThread}
              className={`mt-2 flex w-full items-center justify-center gap-2 rounded-lg border px-2 py-2 text-sm font-medium text-zinc-200 transition-all duration-200 ${
                isCreatingExplainThread
                  ? 'border-zinc-700 bg-zinc-800/80 text-zinc-400'
                  : 'border-zinc-700 bg-zinc-800 hover:-translate-y-0.5 hover:border-zinc-500 hover:bg-zinc-700 active:translate-y-0 active:scale-[0.985]'
              }`}
            >
              <span
                className={`inline-flex h-5 w-5 items-center justify-center rounded-full border border-current/25 text-base leading-none transition-transform ${
                  isCreatingExplainThread ? 'animate-pulse' : ''
                }`}
                aria-hidden="true"
              >
                +
              </span>
              {isCreatingExplainThread ? 'Creating…' : 'New Thread'}
            </button>
            {!isExplainReady && !explainThreadFeedback ? (
              <p className="mt-2 text-[11px] text-zinc-500">Explain 스레드를 불러오는 중입니다.</p>
            ) : null}
            {explainThreadFeedback ? (
              <div
                aria-live="polite"
                className={`mt-2 rounded-lg border px-2.5 py-2 text-[11px] leading-5 transition-all duration-200 ${sessionListFeedbackStyles(explainThreadFeedback.kind)}`}
              >
                {explainThreadFeedback.message}
              </div>
            ) : null}
          </div>

          {explainThreads.map((thread) => {
            const isDeleting = deletingExplainThreadIds.includes(thread.id)
            const isHighlighted = highlightedExplainThreadId === thread.id
            const isEditing = editingExplainThreadId === thread.id
            const threadCardClassName = `min-w-0 flex-1 rounded border p-2 text-left text-sm transition-all duration-300 ${
              selectedExplainThreadId === thread.id
                ? 'border-zinc-700 bg-zinc-800 text-white'
                : 'border-transparent text-zinc-400 hover:border-zinc-800 hover:bg-zinc-800/50 hover:text-zinc-200'
            } ${
              isHighlighted
                ? 'scale-[1.01] border-emerald-700/70 bg-emerald-950/20 text-emerald-50 shadow-[0_0_0_1px_rgba(16,185,129,0.18)]'
                : ''
            } ${isDeleting ? 'pointer-events-none' : ''}`

            return (
              <div
                key={thread.id}
                className={`mb-1 overflow-hidden transition-all duration-200 ease-out ${
                  isDeleting ? 'max-h-0 translate-x-2 opacity-0' : 'max-h-24 translate-x-0 opacity-100'
                }`}
              >
                <div className="group flex items-center gap-1">
                  {isEditing ? (
                    <div className={threadCardClassName}>
                      <input
                        type="text"
                        value={editingExplainThreadTitle}
                        maxLength={120}
                        autoFocus
                        aria-label="Explain thread title"
                        placeholder={thread.label}
                        onChange={(event) => {
                          setEditingExplainThreadTitle(event.target.value)
                        }}
                        onFocus={(event) => {
                          event.currentTarget.select()
                        }}
                        onClick={(event) => {
                          event.stopPropagation()
                        }}
                        onDoubleClick={(event) => {
                          event.stopPropagation()
                        }}
                        onBlur={() => {
                          if (ignoreExplainRenameBlurRef.current) {
                            ignoreExplainRenameBlurRef.current = false
                            return
                          }

                          void commitExplainThreadRename()
                        }}
                        onKeyDown={(event) => {
                          if (event.key === 'Escape') {
                            event.preventDefault()
                            ignoreExplainRenameBlurRef.current = true
                            cancelExplainThreadRename()
                            return
                          }

                          if (event.key !== 'Enter' || event.nativeEvent.isComposing) {
                            return
                          }

                          event.preventDefault()
                          ignoreExplainRenameBlurRef.current = true
                          void commitExplainThreadRename()
                        }}
                        className="w-full min-w-0 bg-transparent font-medium text-inherit outline-none placeholder:text-zinc-500"
                      />
                      <div className="mt-0.5 text-xs text-zinc-500 truncate">{thread.preview}</div>
                    </div>
                  ) : (
                    <button
                      onClick={() => onSelectExplainThread(thread.id)}
                      onDoubleClick={() => {
                        startExplainThreadRename(thread)
                      }}
                      disabled={isDeleting}
                      className={threadCardClassName}
                    >
                      <div className="flex items-center gap-2">
                        <div className="min-w-0 flex-1 font-medium truncate">{thread.label}</div>
                        {thread.continuityMode === 'rehydrated' ? (
                          <span className="shrink-0 rounded-full border border-amber-900/70 bg-amber-950/30 px-1.5 py-0.5 text-[10px] font-medium text-amber-200">
                            세션 복구됨
                          </span>
                        ) : null}
                      </div>
                      <div className="mt-0.5 text-xs text-zinc-500 truncate">{thread.preview}</div>
                    </button>
                  )}
                  <TrashButton
                    ariaLabel={`Delete thread ${thread.label}`}
                    active={selectedExplainThreadId === thread.id}
                    disabled={isDeleting}
                    onClick={() => {
                      handleDeleteExplainThread(thread.id)
                    }}
                  />
                </div>
              </div>
            )
          })}
        </div>
      )}

      {mode === 'direct' && canUseDirect && (
        <div className="flex-1 overflow-y-auto p-2">
          <div className="mb-3 px-1">
            <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-zinc-500">Direct Sessions</p>
            <button
              type="button"
              onClick={() => {
                void handleCreateDirectSessionClick()
              }}
              disabled={isCreatingDirectSession}
              className={`mt-2 flex w-full items-center justify-center gap-2 rounded-lg border px-2 py-2 text-sm font-medium text-zinc-200 transition-all duration-200 ${
                isCreatingDirectSession
                  ? 'border-zinc-700 bg-zinc-800/80 text-zinc-400'
                  : 'border-zinc-700 bg-zinc-800 hover:-translate-y-0.5 hover:border-zinc-500 hover:bg-zinc-700 active:translate-y-0 active:scale-[0.985]'
              }`}
            >
              <span
                className={`inline-flex h-5 w-5 items-center justify-center rounded-full border border-current/25 text-base leading-none transition-transform ${
                  isCreatingDirectSession ? 'animate-pulse' : ''
                }`}
                aria-hidden="true"
              >
                +
              </span>
              {isCreatingDirectSession ? 'Creating…' : 'New Session'}
            </button>
            {!isDirectReady && !directSessionFeedback ? (
              <p className="mt-2 text-[11px] text-zinc-500">Direct Dev 세션이 없습니다. New Session으로 시작하세요.</p>
            ) : null}
            {directSessionFeedback ? (
              <div
                aria-live="polite"
                className={`mt-2 rounded-lg border px-2.5 py-2 text-[11px] leading-5 transition-all duration-200 ${sessionListFeedbackStyles(directSessionFeedback.kind)}`}
              >
                {directSessionFeedback.message}
              </div>
            ) : null}
          </div>

          {directSessions.map((session) => {
            const isDeleting = deletingDirectSessionIds.includes(session.id)
            const isHighlighted = highlightedDirectSessionId === session.id
            const isEditing = editingDirectSessionId === session.id
            const roleDescriptor = getDirectAgentDescriptor(session.agentRole)
            const sessionCardClassName = `min-w-0 flex-1 rounded border p-2 text-left text-sm transition-all duration-300 ${
              selectedDirectSessionId === session.id
                ? 'border-zinc-700 bg-zinc-800 text-white'
                : 'border-transparent text-zinc-400 hover:border-zinc-800 hover:bg-zinc-800/50 hover:text-zinc-200'
            } ${
              isHighlighted
                ? 'scale-[1.01] border-emerald-700/70 bg-emerald-950/20 text-emerald-50 shadow-[0_0_0_1px_rgba(16,185,129,0.18)]'
                : ''
            } ${isDeleting ? 'pointer-events-none' : ''}`

            return (
              <div
                key={session.id}
                className={`mb-1 overflow-hidden transition-all duration-200 ease-out ${
                  isDeleting ? 'max-h-0 translate-x-2 opacity-0' : 'max-h-24 translate-x-0 opacity-100'
                }`}
              >
                <div className="group flex items-center gap-1">
                  {isEditing ? (
                    <div className={sessionCardClassName}>
                      <div className="flex items-center gap-2">
                        <input
                          type="text"
                          value={editingDirectSessionTitle}
                          maxLength={120}
                          autoFocus
                          aria-label="Direct session title"
                          placeholder={session.label}
                          onChange={(event) => {
                            setEditingDirectSessionTitle(event.target.value)
                          }}
                          onFocus={(event) => {
                            event.currentTarget.select()
                          }}
                          onClick={(event) => {
                            event.stopPropagation()
                          }}
                          onDoubleClick={(event) => {
                            event.stopPropagation()
                          }}
                          onBlur={() => {
                            if (ignoreDirectRenameBlurRef.current) {
                              ignoreDirectRenameBlurRef.current = false
                              return
                            }

                            void commitDirectSessionRename()
                          }}
                          onKeyDown={(event) => {
                            if (event.key === 'Escape') {
                              event.preventDefault()
                              ignoreDirectRenameBlurRef.current = true
                              cancelDirectSessionRename()
                              return
                            }

                            if (event.key !== 'Enter' || event.nativeEvent.isComposing) {
                              return
                            }

                            event.preventDefault()
                            ignoreDirectRenameBlurRef.current = true
                            void commitDirectSessionRename()
                          }}
                          className="min-w-0 flex-1 bg-transparent font-medium text-inherit outline-none placeholder:text-zinc-500"
                        />
                        <span
                          className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${directRoleBadgeClassName(session.agentRole)}`}
                        >
                          {roleDescriptor.label}
                        </span>
                      </div>
                      <div className="mt-0.5 text-xs text-zinc-500 truncate">{session.preview}</div>
                    </div>
                  ) : (
                    <button
                      onClick={() => onSelectDirectSession(session.id)}
                      onDoubleClick={() => {
                        startDirectSessionRename(session)
                      }}
                      disabled={isDeleting}
                      className={sessionCardClassName}
                    >
                      <div className="flex items-center gap-2">
                        <div className="min-w-0 flex-1 font-medium truncate">{session.label}</div>
                        {session.continuityMode === 'rehydrated' ? (
                          <span className="shrink-0 rounded-full border border-amber-900/70 bg-amber-950/30 px-1.5 py-0.5 text-[10px] font-medium text-amber-200">
                            세션 복구됨
                          </span>
                        ) : null}
                        <span
                          className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${directRoleBadgeClassName(session.agentRole)}`}
                        >
                          {roleDescriptor.label}
                        </span>
                      </div>
                      <div className="mt-0.5 text-xs text-zinc-500 truncate">{session.preview}</div>
                    </button>
                  )}
                  <TrashButton
                    ariaLabel={`Delete session ${session.label}`}
                    active={selectedDirectSessionId === session.id}
                    disabled={isDeleting}
                    onClick={() => {
                      handleDeleteDirectSession(session.id)
                    }}
                  />
                </div>
              </div>
            )
          })}
        </div>
      )}

      {mode === 'requests' && canUseRequests && (
        <div className="flex-1 overflow-y-auto p-2">
          <div className="mb-3 px-1">
            <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-zinc-500">Client Requests</p>
            <button
              onClick={() => {
                setRequestDeleteMessage(null)
                onCreateRequest()
              }}
              className="mt-2 w-full rounded bg-zinc-800 px-2 py-1.5 text-sm text-zinc-200 transition-colors hover:bg-zinc-700"
            >
              New Request
            </button>
            {requestDeleteMessage ? (
              <p className="mt-2 rounded-md border border-amber-900/70 bg-amber-950/20 px-2 py-1.5 text-[11px] text-amber-100/90">
                {requestDeleteMessage}
              </p>
            ) : null}
          </div>

          {requests.length === 0 ? (
            <p className="text-xs text-zinc-500 p-2">No client requests yet</p>
          ) : (
            requests.map((request) => {
              const isDeleting = deletingRequestIds.includes(request.id)
              const canDeleteRequest = !request.linkedTicketId

              return (
                <div key={request.id} className="group mb-1 flex items-center gap-1">
                  <button
                    onClick={() => {
                      setRequestDeleteMessage(null)
                      onSelectRequest(request.id)
                    }}
                    disabled={isDeleting}
                    className={`min-w-0 flex-1 rounded p-2 text-left text-sm transition-colors ${
                      selectedRequestId === request.id
                        ? 'bg-zinc-800 text-white'
                        : 'text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-200'
                    } ${isDeleting ? 'pointer-events-none opacity-60' : ''}`}
                  >
                    <div className="font-medium truncate">{request.title}</div>
                    <div className="mt-0.5 text-xs text-zinc-500">
                      {request.requester} · {requestStatusLabel(request.status)}
                    </div>
                    <div className="mt-0.5 truncate text-[11px] text-zinc-600">
                      {requestReadinessLabel(request.readinessStatus)}
                      {request.linkedTicketId ? ` · ${request.linkedTicketId}` : ''}
                    </div>
                  </button>
                  <TrashButton
                    ariaLabel={`Delete request ${request.title}`}
                    active={selectedRequestId === request.id}
                    disabled={isDeleting}
                    title={!canDeleteRequest ? '연결된 ticket을 먼저 삭제해야 합니다.' : undefined}
                    onClick={() => {
                      if (!canDeleteRequest) {
                        handleBlockedRequestDelete(request)
                        return
                      }

                      void handleDeleteRequest(request.id)
                    }}
                  />
                </div>
              )
            })
          )}
        </div>
      )}

      {mode === 'ticket' && canUseTickets && (
        <div className="flex-1 overflow-y-auto p-2">
          <div className="mb-3 px-1">
            <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-zinc-500">Tickets</p>
            <button
              onClick={onCreateTicket}
              className="mt-2 w-full rounded bg-zinc-800 px-2 py-1.5 text-sm text-zinc-200 transition-colors hover:bg-zinc-700"
            >
              New Ticket
            </button>
          </div>
          {tickets.length === 0 ? (
            <p className="text-xs text-zinc-500 p-2">No tickets yet</p>
          ) : (
            tickets.map((ticket) => {
              const isDeleting = deletingTicketIds.includes(ticket.id)
              const canDeleteTicket = ticket.runState !== 'queued' && ticket.runState !== 'running'

              return (
                <div key={ticket.id} className="group mb-1 flex items-center gap-1">
                  <button
                    onClick={() => onSelectTicket(ticket.id)}
                    disabled={isDeleting}
                    className={`min-w-0 flex-1 rounded p-2 text-left text-sm transition-colors ${
                      selectedTicketId === ticket.id
                        ? 'bg-zinc-800 text-white'
                        : 'text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-200'
                    } ${isDeleting ? 'pointer-events-none opacity-60' : ''}`}
                  >
                    <div className="font-medium truncate">{ticket.title}</div>
                    <div className="text-xs text-zinc-500 mt-0.5">
                      {ticket.id} · {ticket.categoryId} · {ticketRunStateLabel(ticket.runState)}
                    </div>
                    <div className="text-[11px] text-zinc-600 mt-0.5">
                      {ticket.currentPhase ?? 'idle'}
                      {ticket.recoveryRequired ? ' · recovery required' : ''}
                    </div>
                  </button>
                  <TrashButton
                    ariaLabel={`Delete ticket ${ticket.title}`}
                    active={selectedTicketId === ticket.id}
                    disabled={isDeleting || !canDeleteTicket}
                    title={!canDeleteTicket ? '실행 중인 ticket은 삭제할 수 없습니다.' : undefined}
                    onClick={() => {
                      void handleDeleteTicket(ticket.id)
                    }}
                  />
                </div>
              )
            })
          )}
        </div>
      )}

      {mode === 'incidents' && canUseTickets && (
        <div className="flex-1 overflow-y-auto p-2">
          <div className="mb-3 px-1">
            <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-zinc-500">Incidents</p>
            <p className="mt-1 text-xs text-zinc-600">자동 복구로도 해결되지 않은 실패와 실행 예외를 모아 봅니다.</p>
          </div>
          {incidents.length === 0 ? (
            <p className="p-2 text-xs text-zinc-500">아직 incident가 없습니다.</p>
          ) : (
            incidents.map((incident) => (
              <button
                key={incident.id}
                onClick={() => onSelectIncident(incident.id)}
                className={`mb-2 w-full rounded-xl border p-3 text-left text-sm transition-colors ${
                  selectedIncidentId === incident.id
                    ? 'border-blue-700 bg-blue-950/30 text-white'
                    : 'border-zinc-900/80 bg-zinc-950/40 text-zinc-400 hover:border-zinc-800 hover:bg-zinc-900 hover:text-zinc-200'
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate font-medium">{incident.title}</div>
                    <div className="mt-1 flex flex-wrap gap-1">
                      <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-[11px] text-zinc-200">
                        {incidentTriggerLabel(incident.trigger.kind)}
                      </span>
                      <span
                        className={`rounded-full px-2 py-0.5 text-[11px] ${
                          selectedIncidentId === incident.id
                            ? 'bg-blue-900/70 text-blue-100'
                            : incidentStatusBadge(incident.status)
                        }`}
                      >
                        {incidentStatusLabel(incident.status)}
                      </span>
                    </div>
                  </div>
                  <span className="shrink-0 text-[11px] text-zinc-600">{formatTimestamp(incident.updatedAt)}</span>
                </div>
                <div className="mt-2 text-xs text-zinc-500">
                  티켓 {incident.sourceId} · {incident.id}
                </div>
                <div className="mt-1 text-[11px] text-zinc-600">{compactText(incident.trigger.message)}</div>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}
