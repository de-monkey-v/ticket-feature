import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Layout } from './components/Layout'
import { AccessView } from './components/AccessView'
import { ChatView } from './components/ChatView'
import { DirectView } from './components/DirectView'
import { TicketView } from './components/TicketView'
import { ClientRequestsView } from './components/ClientRequestsView'
import { IncidentsView } from './components/IncidentsView'
import { ProjectSwitcherDialog } from './components/ProjectSwitcherDialog'
import { ShortcutsHelpDialog } from './components/ShortcutsHelpDialog'
import { Sidebar } from './components/Sidebar'
import {
  CompletedRepliesSidebar,
  type CompletedReplyItem,
  type CompletedReplySortOrder,
} from './components/CompletedRepliesSidebar'
import type { AccessPermission, BackgroundRunSummary, TicketSummary, AppConfig, ClientRequest, IncidentSummary } from './lib/api'
import {
  changeOwnPassword,
  deleteClientRequest,
  deleteTicket,
  fetchBackgroundRuns,
  fetchClientRequests,
  fetchConfig,
  fetchIncidents,
  fetchTickets,
  loginAccessAccount,
  logoutAccessSession,
} from './lib/api'
import { fetchOrMigrateExplainState, saveExplainState } from './lib/explain-api'
import { fetchDirectState, saveDirectState } from './lib/direct-api'
import { loadCompletedRepliesState, saveCompletedRepliesState } from './lib/completed-replies-state'
import { evaluateBackgroundRunRefresh } from './lib/background-run-refresh'
import {
  clampSelectionIndex,
  getAltNumberSelectionIndex,
  isShortcutsHelpKey,
  orderProjectsForSelection,
} from './lib/keyboard-shortcuts'
import {
  createDefaultDirectState,
  createDirectSessionState,
  deleteDirectSessionState,
  renameDirectSessionState,
  selectDirectSessionState,
  toDirectSessionOverview,
  type DirectSessionSummary,
  type DirectState,
} from './lib/direct-state'
import {
  createDefaultExplainState,
  createExplainThreadState,
  deleteExplainThreadState,
  renameExplainThreadState,
  resolveExplainStateChange,
  selectExplainThreadState,
  toExplainThreadOverview,
  type ExplainStateChange,
  type ExplainState,
  type ExplainThreadSummary,
} from './lib/explain-state'
import { LoginView } from './components/LoginView'
import { PasswordChangeView } from './components/PasswordChangeView'
import {
  UNAUTHORIZED_EVENT,
  clearAuthToken,
  getAuthToken,
  setAuthToken
} from './lib/auth'

export type Mode = 'explain' | 'direct' | 'ticket' | 'requests' | 'incidents' | 'access'

export interface ExplainThreadCreateResult {
  ok: boolean
  kind: 'success' | 'info' | 'error'
  message: string
  threadId?: string
}

export interface DirectSessionCreateResult {
  ok: boolean
  kind: 'success' | 'info' | 'error'
  message: string
  sessionId?: string
}

const PROJECT_STORAGE_KEY = 'intentlane-codex.selected-project-id'
const SHORTCUT_HINT_DISMISSED_STORAGE_KEY = 'intentlane-codex.shortcuts-hint-dismissed'

function hasSessionPermission(
  session: Pick<AppConfig['auth']['session'], 'isAdmin' | 'permissions'>,
  permission: AccessPermission
) {
  return session.isAdmin || session.permissions.includes(permission)
}

function backgroundRunKindLabel(run: BackgroundRunSummary) {
  if (run.kind === 'explain_reply') {
    return 'Explain'
  }

  if (run.kind === 'direct_reply') {
    return 'Direct Dev'
  }

  if (run.kind === 'explain_request_draft') {
    return 'Explain Request Draft'
  }

  if (run.kind === 'manual_request_draft') {
    return 'Manual Request Draft'
  }

  return run.kind
}

function isCompletedReplyRun(run: BackgroundRunSummary) {
  return (run.kind === 'explain_reply' || run.kind === 'direct_reply') && run.status === 'completed'
}

function hasBlockingModalOpen() {
  return document.querySelector('[role="dialog"][aria-modal="true"]:not([data-project-switcher="true"])') !== null
}

function isEditableShortcutTarget(target: EventTarget | null) {
  return target instanceof Element && target.closest('input, textarea, select, [contenteditable="true"]') !== null
}

function getBackgroundRunRecoveryMode(run: BackgroundRunSummary): 'native' | 'rehydrated' | undefined {
  if (!run.result || typeof run.result !== 'object') {
    return undefined
  }

  const recoveryMode =
    'recoveryMode' in run.result ? (run.result as { recoveryMode?: unknown }).recoveryMode : undefined

  return recoveryMode === 'native' || recoveryMode === 'rehydrated' ? recoveryMode : undefined
}

export default function App() {
  const [mode, setMode] = useState<Mode>('explain')
  const [composerFocusToken, setComposerFocusToken] = useState(0)
  const [token, setTokenState] = useState(() => getAuthToken())
  const [authRequired, setAuthRequired] = useState(false)
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [authError, setAuthError] = useState<string | null>(null)
  const [passwordChangeError, setPasswordChangeError] = useState<string | null>(null)
  const [configError, setConfigError] = useState<string | null>(null)
  const [isLoadingConfig, setIsLoadingConfig] = useState(false)
  const [tickets, setTickets] = useState<TicketSummary[]>([])
  const [clientRequests, setClientRequests] = useState<ClientRequest[]>([])
  const [incidents, setIncidents] = useState<IncidentSummary[]>([])
  const [selectedTicketId, setSelectedTicketId] = useState<string | null>(null)
  const [selectedRequestId, setSelectedRequestId] = useState<string | null>(null)
  const [selectedIncidentId, setSelectedIncidentId] = useState<string | null>(null)
  const [isCreatingRequest, setIsCreatingRequest] = useState(false)
  const [isCreatingTicket, setIsCreatingTicket] = useState(false)
  const [projectId, setProjectId] = useState('')
  const [isProjectSwitcherOpen, setIsProjectSwitcherOpen] = useState(false)
  const [isShortcutsHelpOpen, setIsShortcutsHelpOpen] = useState(false)
  const [highlightedProjectIndex, setHighlightedProjectIndex] = useState(0)
  const [showShortcutHint, setShowShortcutHint] = useState(false)
  const [explainState, setExplainState] = useState<ExplainState | null>(null)
  const [explainThreads, setExplainThreads] = useState<ExplainThreadSummary[]>([])
  const [selectedExplainThreadId, setSelectedExplainThreadId] = useState('')
  const [directState, setDirectState] = useState<DirectState | null>(null)
  const [directSessions, setDirectSessions] = useState<DirectSessionSummary[]>([])
  const [selectedDirectSessionId, setSelectedDirectSessionId] = useState('')
  const [isDirectStateLoading, setIsDirectStateLoading] = useState(false)
  const [backgroundRuns, setBackgroundRuns] = useState<BackgroundRunSummary[]>([])
  const [dismissedActivityIds, setDismissedActivityIds] = useState<string[]>([])
  const [readCompletedReplyIds, setReadCompletedReplyIds] = useState<string[]>([])
  const [isCompletedRepliesCollapsed, setIsCompletedRepliesCollapsed] = useState(false)
  const [completedReplySortOrder, setCompletedReplySortOrder] = useState<CompletedReplySortOrder>('newest')
  const backgroundRunStatusRef = useRef<Map<string, string>>(new Map())
  const completedRepliesInitializedRef = useRef(false)
  const skipNextCompletedRepliesPersistRef = useRef(false)
  const explainPersistTimerRef = useRef<number | null>(null)
  const explainPersistPayloadRef = useRef<{
    contextKey: string
    projectId: string
    state: ExplainState
  } | null>(null)
  const explainContextKeyRef = useRef('')
  const explainStateRef = useRef<ExplainState | null>(null)
  const directPersistTimerRef = useRef<number | null>(null)
  const directPersistPayloadRef = useRef<{
    contextKey: string
    projectId: string
    state: DirectState
  } | null>(null)
  const directContextKeyRef = useRef('')

  const getAvailableModes = (cfg: AppConfig | null): Mode[] => {
    if (!cfg) {
      return ['explain']
    }

    const modes: Mode[] = []
    if (hasSessionPermission(cfg.auth.session, 'explain')) {
      modes.push('explain')
    }
    if (hasSessionPermission(cfg.auth.session, 'direct')) {
      modes.push('direct')
    }
    if (hasSessionPermission(cfg.auth.session, 'requests')) {
      modes.push('requests')
    }
    if (hasSessionPermission(cfg.auth.session, 'tickets')) {
      modes.push('ticket')
      if (incidents.length > 0) {
        modes.push('incidents')
      }
    }
    if (cfg.auth.session.isAdmin) {
      modes.push('access')
    }

    return modes.length > 0 ? modes : ['explain']
  }

  const explainScopeKey = config
    ? `${config.auth.session.kind}:${config.auth.session.accountId ?? ''}:${config.auth.session.tokenId ?? ''}`
    : 'anonymous'
  const mustChangePassword = Boolean(config?.auth.session.mustChangePassword)
  const orderedProjects = useMemo(
    () => orderProjectsForSelection(config?.allowedProjects ?? [], projectId),
    [config, projectId]
  )

  const clearExplainPersistTimer = useCallback(() => {
    if (explainPersistTimerRef.current !== null) {
      window.clearTimeout(explainPersistTimerRef.current)
      explainPersistTimerRef.current = null
    }
  }, [])

  const clearDirectPersistTimer = useCallback(() => {
    if (directPersistTimerRef.current !== null) {
      window.clearTimeout(directPersistTimerRef.current)
      directPersistTimerRef.current = null
    }
  }, [])

  const syncExplainOverview = useCallback((state: ExplainState | null) => {
    explainStateRef.current = state
    setExplainState(state)

    if (!state) {
      setExplainThreads([])
      setSelectedExplainThreadId('')
      return
    }

    const overview = toExplainThreadOverview(state)
    setExplainThreads(overview.threads)
    setSelectedExplainThreadId(overview.selectedThreadId)
  }, [])

  const syncDirectOverview = useCallback((state: DirectState | null) => {
    setDirectState(state)

    if (!state) {
      setDirectSessions([])
      setSelectedDirectSessionId('')
      return
    }

    const overview = toDirectSessionOverview(state)
    setDirectSessions(overview.sessions)
    setSelectedDirectSessionId(overview.selectedSessionId)
  }, [])

  const scheduleExplainStatePersist = useCallback(
    (nextProjectId: string, nextState: ExplainState, options?: { immediate?: boolean }) => {
      if (!nextProjectId) {
        return
      }

      const payload = {
        contextKey: `${explainScopeKey}:${nextProjectId}`,
        projectId: nextProjectId,
        state: nextState,
      }
      explainPersistPayloadRef.current = payload
      clearExplainPersistTimer()

      const persist = async () => {
        if (!explainPersistPayloadRef.current || explainPersistPayloadRef.current.contextKey !== explainContextKeyRef.current) {
          return
        }

        try {
          await saveExplainState(explainPersistPayloadRef.current.projectId, explainPersistPayloadRef.current.state)
        } catch (error) {
          console.error('Failed to save explain state:', error)
        }
      }

      if (options?.immediate) {
        void persist()
        return
      }

      explainPersistTimerRef.current = window.setTimeout(() => {
        explainPersistTimerRef.current = null
        void persist()
      }, 250)
    },
    [clearExplainPersistTimer, explainScopeKey]
  )

  const scheduleDirectStatePersist = useCallback(
    (nextProjectId: string, nextState: DirectState, options?: { immediate?: boolean }) => {
      if (!nextProjectId) {
        return
      }

      const payload = {
        contextKey: `${explainScopeKey}:${nextProjectId}`,
        projectId: nextProjectId,
        state: nextState,
      }
      directPersistPayloadRef.current = payload
      clearDirectPersistTimer()

      const persist = async () => {
        if (!directPersistPayloadRef.current || directPersistPayloadRef.current.contextKey !== directContextKeyRef.current) {
          return
        }

        try {
          await saveDirectState(directPersistPayloadRef.current.projectId, directPersistPayloadRef.current.state)
        } catch (error) {
          console.error('Failed to save direct state:', error)
        }
      }

      if (options?.immediate) {
        void persist()
        return
      }

      directPersistTimerRef.current = window.setTimeout(() => {
        directPersistTimerRef.current = null
        void persist()
      }, 250)
    },
    [clearDirectPersistTimer, explainScopeKey]
  )

  const flushExplainStatePersist = useCallback((options?: { keepalive?: boolean }) => {
    const payload = explainPersistPayloadRef.current
    clearExplainPersistTimer()
    explainPersistPayloadRef.current = null

    if (!payload) {
      return
    }

    void saveExplainState(payload.projectId, payload.state, options).catch((error) => {
      console.error('Failed to flush explain state:', error)
    })
  }, [clearExplainPersistTimer])

  const flushDirectStatePersist = useCallback((options?: { keepalive?: boolean }) => {
    const payload = directPersistPayloadRef.current
    clearDirectPersistTimer()
    directPersistPayloadRef.current = null

    if (!payload) {
      return
    }

    void saveDirectState(payload.projectId, payload.state, options).catch((error) => {
      console.error('Failed to flush direct state:', error)
    })
  }, [clearDirectPersistTimer])

  const resetAuthBoundary = useCallback((nextAuthRequired: boolean, nextAuthError: string | null) => {
    flushExplainStatePersist()
    flushDirectStatePersist()
    clearAuthToken()
    clearExplainPersistTimer()
    clearDirectPersistTimer()
    explainPersistPayloadRef.current = null
    directPersistPayloadRef.current = null
    setTokenState('')
    setAuthRequired(nextAuthRequired)
    setConfig(null)
    setAuthError(nextAuthError)
    setPasswordChangeError(null)
    setConfigError(null)
    setMode('explain')
    setProjectId('')
    setIsProjectSwitcherOpen(false)
    setIsShortcutsHelpOpen(false)
    setHighlightedProjectIndex(0)
    setTickets([])
    setClientRequests([])
    setIncidents([])
    setBackgroundRuns([])
    setDismissedActivityIds([])
    setReadCompletedReplyIds([])
    completedRepliesInitializedRef.current = false
    backgroundRunStatusRef.current = new Map()
    setSelectedTicketId(null)
    setSelectedRequestId(null)
    setSelectedIncidentId(null)
    setIsCreatingRequest(false)
    setIsCreatingTicket(false)
    syncExplainOverview(null)
    syncDirectOverview(null)
    setIsDirectStateLoading(false)
  }, [
    clearDirectPersistTimer,
    clearExplainPersistTimer,
    flushDirectStatePersist,
    flushExplainStatePersist,
    syncDirectOverview,
    syncExplainOverview,
  ])

  useEffect(() => {
    explainContextKeyRef.current = `${explainScopeKey}:${projectId}`
  }, [explainScopeKey, projectId])

  useEffect(() => {
    directContextKeyRef.current = `${explainScopeKey}:${projectId}`
  }, [explainScopeKey, projectId])

  useEffect(() => {
    if (!projectId) {
      skipNextCompletedRepliesPersistRef.current = false
      setDismissedActivityIds([])
      return
    }

    const loaded = loadCompletedRepliesState(explainScopeKey, projectId)
    skipNextCompletedRepliesPersistRef.current = true
    setDismissedActivityIds(loaded.dismissedRunIds)
  }, [explainScopeKey, projectId])

  useEffect(() => {
    if (!projectId) {
      return
    }

    if (skipNextCompletedRepliesPersistRef.current) {
      skipNextCompletedRepliesPersistRef.current = false
      return
    }

    saveCompletedRepliesState(explainScopeKey, projectId, {
      dismissedRunIds: dismissedActivityIds,
    })
  }, [dismissedActivityIds, explainScopeKey, projectId])

  useEffect(() => {
    clearExplainPersistTimer()
    explainPersistPayloadRef.current = null
    syncExplainOverview(null)
    clearDirectPersistTimer()
    directPersistPayloadRef.current = null
    syncDirectOverview(null)
    setIsDirectStateLoading(false)
  }, [clearDirectPersistTimer, clearExplainPersistTimer, explainScopeKey, syncDirectOverview, syncExplainOverview])

  useEffect(() => {
    const flushPendingStateForUnload = () => {
      flushExplainStatePersist({ keepalive: true })
      flushDirectStatePersist({ keepalive: true })
    }

    window.addEventListener('pagehide', flushPendingStateForUnload)
    window.addEventListener('beforeunload', flushPendingStateForUnload)

    return () => {
      window.removeEventListener('pagehide', flushPendingStateForUnload)
      window.removeEventListener('beforeunload', flushPendingStateForUnload)
    }
  }, [flushDirectStatePersist, flushExplainStatePersist])

  useEffect(() => {
    return () => {
      flushExplainStatePersist({ keepalive: true })
      flushDirectStatePersist({ keepalive: true })
    }
  }, [flushDirectStatePersist, flushExplainStatePersist])

  const refreshConfig = async () => {
    const cfg = await fetchConfig()
    setAuthRequired(false)
    setAuthError(null)
    setConfig(cfg)
    setProjectId((currentProjectId) => {
      if (cfg.allowedProjects.some((project) => project.id === currentProjectId)) {
        return currentProjectId
      }

      return cfg.defaultProjectId
    })
    return cfg
  }

  useEffect(() => {
    const handleUnauthorized = () => {
      resetAuthBoundary(true, '토큰이 올바르지 않거나 세션이 만료되었습니다.')
    }

    window.addEventListener(UNAUTHORIZED_EVENT, handleUnauthorized)
    return () => {
      window.removeEventListener(UNAUTHORIZED_EVENT, handleUnauthorized)
    }
  }, [resetAuthBoundary])

  useEffect(() => {
    setIsLoadingConfig(true)
    setConfigError(null)

    refreshConfig()
      .then((cfg) => {
        const storedProjectId = sessionStorage.getItem(PROJECT_STORAGE_KEY)
        const fallbackProjectId = cfg.allowedProjects.some((project) => project.id === storedProjectId)
          ? storedProjectId || cfg.defaultProjectId
          : cfg.defaultProjectId
        setProjectId(fallbackProjectId)
      })
      .catch((error: Error) => {
        if (error.name === 'UnauthorizedError') {
          setConfig(null)
          setProjectId('')
          setConfigError(null)
          return
        }
        setConfigError(error.message)
      })
      .finally(() => {
        setIsLoadingConfig(false)
      })
  }, [token])

  useEffect(() => {
    if (projectId) {
      sessionStorage.setItem(PROJECT_STORAGE_KEY, projectId)
    }
  }, [projectId])

  useEffect(() => {
    if (!config || mustChangePassword || typeof window === 'undefined') {
      setShowShortcutHint(false)
      return
    }

    setShowShortcutHint(window.localStorage.getItem(SHORTCUT_HINT_DISMISSED_STORAGE_KEY) !== 'true')
  }, [config, mustChangePassword])

  useEffect(() => {
    flushExplainStatePersist()
    flushDirectStatePersist()
    setSelectedTicketId(null)
    setSelectedRequestId(null)
    setSelectedIncidentId(null)
    setIsCreatingRequest(false)
    setIsCreatingTicket(false)
    setBackgroundRuns([])
    setReadCompletedReplyIds([])
    completedRepliesInitializedRef.current = false
    backgroundRunStatusRef.current = new Map()
    syncExplainOverview(null)
    syncDirectOverview(null)
    setIsDirectStateLoading(false)
    clearExplainPersistTimer()
    clearDirectPersistTimer()
    explainPersistPayloadRef.current = null
    directPersistPayloadRef.current = null
  }, [
    clearDirectPersistTimer,
    clearExplainPersistTimer,
    flushDirectStatePersist,
    flushExplainStatePersist,
    projectId,
    syncDirectOverview,
    syncExplainOverview,
  ])

  useEffect(() => {
    if (isCreatingRequest) {
      return
    }

    if (clientRequests.length === 0) {
      setSelectedRequestId(null)
      return
    }

    if (selectedRequestId && clientRequests.some((request) => request.id === selectedRequestId)) {
      return
    }

    setSelectedRequestId(clientRequests[0]?.id ?? null)
  }, [clientRequests, isCreatingRequest, selectedRequestId])

  useEffect(() => {
    if (isCreatingTicket) {
      return
    }

    if (tickets.length === 0) {
      setSelectedTicketId(null)
      return
    }

    if (selectedTicketId && tickets.some((ticket) => ticket.id === selectedTicketId)) {
      return
    }

    setSelectedTicketId(tickets[0]?.id ?? null)
  }, [isCreatingTicket, selectedTicketId, tickets])

  useEffect(() => {
    if (!selectedIncidentId && incidents.length > 0) {
      setSelectedIncidentId(incidents[0].id)
      return
    }

    if (selectedIncidentId && !incidents.some((incident) => incident.id === selectedIncidentId)) {
      setSelectedIncidentId(incidents[0]?.id ?? null)
    }
  }, [incidents, selectedIncidentId])

  useEffect(() => {
    if (!config || !projectId) {
      syncExplainOverview(null)
      return
    }

    if (mustChangePassword) {
      syncExplainOverview(null)
      return
    }

    if (!(config.auth.session.isAdmin || config.auth.session.permissions.includes('explain'))) {
      syncExplainOverview(null)
      return
    }

    let cancelled = false

    fetchOrMigrateExplainState(projectId)
      .then((state) => {
        if (cancelled) {
          return
        }

        syncExplainOverview(state)
      })
      .catch((error) => {
        if (cancelled) {
          return
        }

        console.error('Failed to load explain state:', error)
        syncExplainOverview(createDefaultExplainState())
      })

    return () => {
      cancelled = true
    }
  }, [config, mustChangePassword, projectId, explainScopeKey, syncExplainOverview])

  useEffect(() => {
    if (!config || !projectId) {
      syncDirectOverview(null)
      setIsDirectStateLoading(false)
      return
    }

    if (mustChangePassword) {
      syncDirectOverview(null)
      setIsDirectStateLoading(false)
      return
    }

    if (!hasSessionPermission(config.auth.session, 'direct')) {
      syncDirectOverview(null)
      setIsDirectStateLoading(false)
      return
    }

    let cancelled = false
    setIsDirectStateLoading(true)

    fetchDirectState(projectId)
      .then((loaded) => {
        if (cancelled) {
          return
        }

        syncDirectOverview(loaded.state)
        setIsDirectStateLoading(false)
      })
      .catch((error) => {
        if (cancelled) {
          return
        }

        console.error('Failed to load direct state:', error)
        syncDirectOverview(createDefaultDirectState())
        setIsDirectStateLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [config, mustChangePassword, projectId, explainScopeKey, syncDirectOverview])

  const refreshTickets = async () => {
    const list = await fetchTickets(projectId)
    setTickets(list)
  }

  const refreshClientRequests = async () => {
    const list = await fetchClientRequests(projectId)
    setClientRequests(list)
  }

  const refreshIncidents = async () => {
    const list = await fetchIncidents(projectId)
    setIncidents(list)
    return list
  }

  const refreshExplainStateFromServer = useCallback(
    async (options?: { selectedThreadId?: string }) => {
      if (!config || !projectId || mustChangePassword || !hasSessionPermission(config.auth.session, 'explain')) {
        return null
      }

      const loaded = await fetchOrMigrateExplainState(projectId)
      const nextState = selectExplainThreadState(loaded, options?.selectedThreadId ?? selectedExplainThreadId)
      syncExplainOverview(nextState)
      return nextState
    },
    [config, mustChangePassword, projectId, selectedExplainThreadId, syncExplainOverview]
  )

  const refreshDirectStateFromServer = useCallback(
    async (options?: { selectedSessionId?: string }) => {
      if (!config || !projectId || mustChangePassword || !hasSessionPermission(config.auth.session, 'direct')) {
        return null
      }

      const loaded = await fetchDirectState(projectId)
      const nextState = selectDirectSessionState(loaded.state, options?.selectedSessionId ?? selectedDirectSessionId)
      syncDirectOverview(nextState)
      return nextState
    },
    [config, mustChangePassword, projectId, selectedDirectSessionId, syncDirectOverview]
  )

  const handleOpenIncidentHome = useCallback(async () => {
    const list = await refreshIncidents()
    setSelectedIncidentId((current) =>
      current && list.some((incident) => incident.id === current) ? current : list[0]?.id ?? null
    )
    setMode('incidents')
  }, [projectId])

  const handleDeleteTicket = async (ticketId: string) => {
    await deleteTicket(ticketId)
    setSelectedTicketId((current) => (current === ticketId ? null : current))
    await refreshTickets()
  }

  const handleDeleteRequest = async (requestId: string) => {
    await deleteClientRequest(requestId)
    setSelectedRequestId((current) => (current === requestId ? null : current))
    await refreshClientRequests()
  }

  const handleExplainStateChange = useCallback(
    (change: ExplainStateChange, options?: { immediate?: boolean }) => {
      const nextState = resolveExplainStateChange(explainStateRef.current, change)
      if (!nextState) {
        return
      }

      syncExplainOverview(nextState)
      if (!projectId) {
        return
      }

      scheduleExplainStatePersist(projectId, nextState, options)
    },
    [projectId, scheduleExplainStatePersist, syncExplainOverview]
  )

  const handleDirectStateChange = useCallback(
    (nextState: DirectState, options?: { immediate?: boolean }) => {
      syncDirectOverview(nextState)
      if (!projectId) {
        return
      }

      scheduleDirectStatePersist(projectId, nextState, options)
    },
    [projectId, scheduleDirectStatePersist, syncDirectOverview]
  )

  const handleRequestCreated = useCallback((request: ClientRequest) => {
    setClientRequests((current) => [request, ...current.filter((entry) => entry.id !== request.id)])
  }, [])

  const handleOpenExplainHome = useCallback(() => {
    if (explainState) {
      handleExplainStateChange(selectExplainThreadState(explainState, selectedExplainThreadId), { immediate: true })
    }
    setMode('explain')
  }, [explainState, handleExplainStateChange, selectedExplainThreadId])

  const handleOpenDirectHome = useCallback(() => {
    if (directState) {
      handleDirectStateChange(selectDirectSessionState(directState, selectedDirectSessionId), { immediate: true })
    }
    setMode('direct')
  }, [directState, handleDirectStateChange, selectedDirectSessionId])

  const handleOpenRequestHome = useCallback(() => {
    setIsCreatingRequest(false)
    setSelectedRequestId((current) => {
      if (current && clientRequests.some((request) => request.id === current)) {
        return current
      }

      return clientRequests[0]?.id ?? null
    })
    setMode('requests')
  }, [clientRequests])

  const handleStartCreateRequest = useCallback(() => {
    setIsCreatingRequest(true)
    setSelectedRequestId(null)
    setMode('requests')
  }, [])

  const handleOpenTicketHome = useCallback(() => {
    setIsCreatingTicket(false)
    setSelectedTicketId((current) => {
      if (current && tickets.some((ticket) => ticket.id === current)) {
        return current
      }

      return tickets[0]?.id ?? null
    })
    setMode('ticket')
  }, [tickets])

  const handleStartCreateTicket = useCallback(() => {
    setIsCreatingTicket(true)
    setSelectedTicketId(null)
    setMode('ticket')
  }, [])

  const handleSelectRequestFromSidebar = useCallback((requestId: string) => {
    setIsCreatingRequest(false)
    setSelectedRequestId(requestId)
    setMode('requests')
  }, [])

  const handleSelectTicketFromSidebar = useCallback((ticketId: string) => {
    setIsCreatingTicket(false)
    setSelectedTicketId(ticketId)
    setMode('ticket')
  }, [])

  const handleSelectIncidentFromSidebar = useCallback((incidentId: string | null) => {
    setSelectedIncidentId(incidentId)
    if (incidentId) {
      setMode('incidents')
    }
  }, [])

  const handleSelectExplainThread = useCallback(
    (threadId: string) => {
      if (!explainState) {
        return
      }

      handleExplainStateChange(selectExplainThreadState(explainState, threadId), { immediate: true })
    },
    [explainState, handleExplainStateChange]
  )

  const handleCreateExplainThread = useCallback(async (): Promise<ExplainThreadCreateResult> => {
    if (!projectId) {
      return {
        ok: false,
        kind: 'error',
        message: '프로젝트를 먼저 선택하세요.',
      }
    }

    if (!explainState) {
      return {
        ok: false,
        kind: 'info',
        message: 'Explain 스레드를 아직 불러오는 중입니다.',
      }
    }

    const nextState = createExplainThreadState(explainState)
    handleExplainStateChange(nextState, { immediate: true })
    setComposerFocusToken((current) => current + 1)
    return {
      ok: true,
      kind: 'success',
      message: '새 explain thread를 열었습니다.',
      threadId: nextState.selectedThreadId,
    }
  }, [explainState, handleExplainStateChange, projectId])

  const handleDeleteExplainThread = useCallback(
    async (threadId: string) => {
      if (!projectId || !explainState) {
        return
      }

      handleExplainStateChange(deleteExplainThreadState(explainState, threadId), { immediate: true })
    },
    [explainState, handleExplainStateChange, projectId]
  )

  const handleRenameExplainThread = useCallback(
    async (threadId: string, title: string) => {
      if (!projectId || !explainState) {
        return
      }

      handleExplainStateChange(renameExplainThreadState(explainState, threadId, title), { immediate: true })
    },
    [explainState, handleExplainStateChange, projectId]
  )

  const handleSelectDirectSession = useCallback(
    (sessionId: string) => {
      if (!directState) {
        return
      }

      handleDirectStateChange(selectDirectSessionState(directState, sessionId), { immediate: true })
    },
    [directState, handleDirectStateChange]
  )

  const handleCreateDirectSession = useCallback(async (): Promise<DirectSessionCreateResult> => {
    if (!projectId) {
      return {
        ok: false,
        kind: 'error',
        message: '프로젝트를 먼저 선택하세요.',
      }
    }

    if (!directState) {
      return {
        ok: false,
        kind: 'info',
        message: 'Direct Dev 세션을 아직 불러오는 중입니다.',
      }
    }

    const nextState = createDirectSessionState(directState)
    handleDirectStateChange(nextState, { immediate: true })
    setComposerFocusToken((current) => current + 1)
    return {
      ok: true,
      kind: 'success',
      message: '새 Direct Dev 세션을 열었습니다.',
      sessionId: nextState.selectedSessionId,
    }
  }, [directState, handleDirectStateChange, projectId])

  const handleRenameDirectSession = useCallback(
    async (sessionId: string, title: string) => {
      if (!projectId || !directState) {
        return
      }

      handleDirectStateChange(renameDirectSessionState(directState, sessionId, title), { immediate: true })
    },
    [directState, handleDirectStateChange, projectId]
  )

  const handleDeleteDirectSession = useCallback(
    async (sessionId: string) => {
      if (!projectId || !directState) {
        return
      }

      handleDirectStateChange(deleteDirectSessionState(directState, sessionId), { immediate: true })
    },
    [directState, handleDirectStateChange, projectId]
  )

  const dismissActivity = useCallback((id: string) => {
    setDismissedActivityIds((current) => [...current.filter((entry) => entry !== id), id])
  }, [])

  const dismissAllCompletedReplies = useCallback((runIds: string[]) => {
    if (runIds.length === 0) {
      return
    }

    setDismissedActivityIds((current) => {
      const next = new Set(current)
      for (const runId of runIds) {
        next.add(runId)
      }
      return Array.from(next)
    })
  }, [])

  const markCompletedRepliesRead = useCallback((runIds: string[]) => {
    if (runIds.length === 0) {
      return
    }

    setReadCompletedReplyIds((current) => {
      const next = new Set(current)
      let changed = false

      for (const runId of runIds) {
        if (!next.has(runId)) {
          next.add(runId)
          changed = true
        }
      }

      return changed ? Array.from(next) : current
    })
  }, [])

  const handleOpenBackgroundRun = useCallback(
    async (run: BackgroundRunSummary) => {
      if (isCompletedReplyRun(run)) {
        markCompletedRepliesRead([run.id])
      }

      if (run.kind === 'direct_reply') {
        try {
          const nextState = await refreshDirectStateFromServer({ selectedSessionId: run.scopeId })
          if (!nextState && directState) {
            handleDirectStateChange(selectDirectSessionState(directState, run.scopeId), { immediate: true })
          }
        } catch (error) {
          console.error('Failed to refresh direct state before opening activity:', error)
          if (directState) {
            handleDirectStateChange(selectDirectSessionState(directState, run.scopeId), { immediate: true })
          }
        }
        setMode('direct')
      } else if (run.kind === 'manual_request_draft') {
        handleStartCreateRequest()
      } else {
        try {
          const nextState = await refreshExplainStateFromServer({ selectedThreadId: run.scopeId })
          if (!nextState && explainState) {
            handleExplainStateChange(selectExplainThreadState(explainState, run.scopeId), { immediate: true })
          }
        } catch (error) {
          console.error('Failed to refresh explain state before opening activity:', error)
          if (explainState) {
            handleExplainStateChange(selectExplainThreadState(explainState, run.scopeId), { immediate: true })
          }
        }
        setMode('explain')
      }
    },
    [
      directState,
      explainState,
      handleDirectStateChange,
      handleExplainStateChange,
      handleStartCreateRequest,
      markCompletedRepliesRead,
      refreshDirectStateFromServer,
      refreshExplainStateFromServer,
    ]
  )

  const completedReplyItems = useMemo<CompletedReplyItem[]>(() => {
    const visibleRuns = backgroundRuns
      .filter((run) => isCompletedReplyRun(run) && !dismissedActivityIds.includes(run.id))
      .sort((left, right) => {
        const leftTime = new Date(left.completedAt ?? left.updatedAt).getTime()
        const rightTime = new Date(right.completedAt ?? right.updatedAt).getTime()
        const leftUnread = !readCompletedReplyIds.includes(left.id)
        const rightUnread = !readCompletedReplyIds.includes(right.id)

        if (completedReplySortOrder === 'unread' && leftUnread !== rightUnread) {
          return leftUnread ? -1 : 1
        }

        if (completedReplySortOrder === 'oldest') {
          return leftTime - rightTime
        }

        return rightTime - leftTime
      })

    return visibleRuns
      .map((run) => ({
        id: run.id,
        kindLabel: backgroundRunKindLabel(run),
        scopeLabel: run.scopeLabel,
        promptPreview: run.messagePreview,
        completedAt: run.completedAt ?? run.updatedAt,
        isUnread: !readCompletedReplyIds.includes(run.id),
        isRecovered: getBackgroundRunRecoveryMode(run) === 'rehydrated',
        onOpen: () => {
          dismissActivity(run.id)
          void handleOpenBackgroundRun(run)
        },
        onDismiss: () => {
          dismissActivity(run.id)
        },
      }))
  }, [
    backgroundRuns,
    completedReplySortOrder,
    dismissedActivityIds,
    dismissActivity,
    handleOpenBackgroundRun,
    readCompletedReplyIds,
  ])

  useEffect(() => {
    if (!config || !projectId) {
      setTickets([])
      setSelectedTicketId(null)
      return
    }

    if (mustChangePassword) {
      setTickets([])
      setSelectedTicketId(null)
      return
    }

    if (!hasSessionPermission(config.auth.session, 'tickets')) {
      setTickets([])
      setSelectedTicketId(null)
      return
    }

    refreshTickets().catch((error) => {
      console.error('Failed to preload tickets:', error)
      setTickets([])
    })
  }, [config, mustChangePassword, projectId])

  useEffect(() => {
    if (!config || !projectId) {
      setClientRequests([])
      setSelectedRequestId(null)
      return
    }

    if (mustChangePassword) {
      setClientRequests([])
      setSelectedRequestId(null)
      return
    }

    if (!hasSessionPermission(config.auth.session, 'requests')) {
      setClientRequests([])
      setSelectedRequestId(null)
      return
    }

    refreshClientRequests().catch((error) => {
      console.error('Failed to preload client requests:', error)
      setClientRequests([])
    })
  }, [config, mustChangePassword, projectId])

  useEffect(() => {
    if (!config || !projectId) {
      setIncidents([])
      setSelectedIncidentId(null)
      return
    }

    if (mustChangePassword) {
      setIncidents([])
      setSelectedIncidentId(null)
      return
    }

    if (!hasSessionPermission(config.auth.session, 'tickets')) {
      setIncidents([])
      setSelectedIncidentId(null)
      return
    }

    refreshIncidents().catch((error) => {
      console.error('Failed to refresh incidents:', error)
      setIncidents([])
    })
  }, [config, mustChangePassword, projectId])

  useEffect(() => {
    if (!config || !projectId || mustChangePassword) {
      setBackgroundRuns([])
      setReadCompletedReplyIds([])
      completedRepliesInitializedRef.current = false
      backgroundRunStatusRef.current = new Map()
      return
    }

    let cancelled = false

    const loadRuns = async () => {
      try {
        const runs = await fetchBackgroundRuns(projectId)
        if (!cancelled) {
          setBackgroundRuns(runs)
        }
      } catch (error) {
        if (!cancelled) {
          console.error('Failed to refresh background runs:', error)
        }
      }
    }

    void loadRuns()
    const timer = window.setInterval(() => {
      void loadRuns()
    }, 3000)

    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [config, mustChangePassword, projectId])

  useEffect(() => {
    const completedReplyIds = backgroundRuns.filter((run) => isCompletedReplyRun(run)).map((run) => run.id)

    if (!completedRepliesInitializedRef.current) {
      completedRepliesInitializedRef.current = true
      markCompletedRepliesRead(completedReplyIds)
      return
    }

    setReadCompletedReplyIds((current) => current.filter((id) => completedReplyIds.includes(id)))
  }, [backgroundRuns, markCompletedRepliesRead])

  useEffect(() => {
    const { nextStatuses, shouldRefreshExplain, shouldRefreshDirect } = evaluateBackgroundRunRefresh({
      backgroundRuns,
      previousStatuses: backgroundRunStatusRef.current,
      explainState,
      directState,
    })

    backgroundRunStatusRef.current = nextStatuses

    if (shouldRefreshExplain) {
      void refreshExplainStateFromServer().catch((error) => {
        console.error('Failed to refresh explain state after background run completion:', error)
      })
    }

    if (shouldRefreshDirect) {
      void refreshDirectStateFromServer().catch((error) => {
        console.error('Failed to refresh direct state after background run completion:', error)
      })
    }
  }, [backgroundRuns, directState, explainState, refreshDirectStateFromServer, refreshExplainStateFromServer])

  useEffect(() => {
    const runIdsToMarkRead = backgroundRuns
      .filter((run) => {
        if (!isCompletedReplyRun(run)) {
          return false
        }

        if (run.kind === 'explain_reply') {
          return mode === 'explain' && selectedExplainThreadId === run.scopeId
        }

        return mode === 'direct' && selectedDirectSessionId === run.scopeId
      })
      .map((run) => run.id)

    markCompletedRepliesRead(runIdsToMarkRead)
  }, [
    backgroundRuns,
    markCompletedRepliesRead,
    mode,
    selectedDirectSessionId,
    selectedExplainThreadId,
  ])

  useEffect(() => {
    if (
      !config ||
      !projectId ||
      mustChangePassword ||
      !hasSessionPermission(config.auth.session, 'tickets')
    ) {
      return
    }

    let cancelled = false

    const loadTickets = async () => {
      try {
        const list = await fetchTickets(projectId)
        if (!cancelled) {
          setTickets(list)
        }
      } catch (error) {
        if (!cancelled) {
          console.error('Failed to refresh tickets:', error)
        }
      }
    }

    const timer = window.setInterval(() => {
      void loadTickets()
    }, 5000)

    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [config, mustChangePassword, projectId])

  useEffect(() => {
    if (!config) {
      return
    }

    if (mustChangePassword) {
      return
    }

    const availableModes = getAvailableModes(config)
    if (!availableModes.includes(mode)) {
      setMode(availableModes[0] ?? 'explain')
      return
    }

    if (mode === 'ticket') {
      refreshTickets().catch((error) => {
        console.error('Failed to refresh tickets:', error)
      })
    }

    if (mode === 'requests') {
      refreshClientRequests().catch((error) => {
        console.error('Failed to refresh client requests:', error)
      })
    }
  }, [mode, config, incidents.length, mustChangePassword, projectId])

  const handleAccountLogin = async (name: string, password: string) => {
    try {
      const result = await loginAccessAccount({ name, password })
      setAuthError(null)
      setPasswordChangeError(null)
      setConfigError(null)
      setAuthToken(result.token)
      setTokenState(result.token)
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : '계정 로그인에 실패했습니다.')
    }
  }

  const handleLogout = useCallback(async () => {
    try {
      await logoutAccessSession()
    } catch (error) {
      if (!(error instanceof Error) || error.name !== 'UnauthorizedError') {
        console.error('Failed to log out:', error)
      }
    } finally {
      resetAuthBoundary(true, null)
    }
  }, [resetAuthBoundary])

  const handlePasswordChange = useCallback(
    async (currentPassword: string, newPassword: string) => {
      try {
        await changeOwnPassword({ currentPassword, newPassword })
        setPasswordChangeError(null)
        await refreshConfig()
      } catch (error) {
        setPasswordChangeError(error instanceof Error ? error.message : '비밀번호 변경에 실패했습니다.')
      }
    },
    []
  )

  const handleCloseProjectSwitcher = useCallback(() => {
    setIsProjectSwitcherOpen(false)
  }, [])

  const handleOpenShortcutsHelp = useCallback(() => {
    setIsShortcutsHelpOpen(true)
  }, [])

  const handleCloseShortcutsHelp = useCallback(() => {
    setIsShortcutsHelpOpen(false)
  }, [])

  const handleOpenProjectSwitcher = useCallback(() => {
    if (orderedProjects.length === 0) {
      return
    }

    setHighlightedProjectIndex(0)
    setIsProjectSwitcherOpen(true)
  }, [orderedProjects.length])

  const handleSelectProjectFromSwitcher = useCallback((nextProjectId: string) => {
    setProjectId(nextProjectId)
    setIsProjectSwitcherOpen(false)
    setHighlightedProjectIndex(0)
  }, [])

  const handleDismissShortcutHint = useCallback(() => {
    setShowShortcutHint(false)

    if (typeof window !== 'undefined') {
      window.localStorage.setItem(SHORTCUT_HINT_DISMISSED_STORAGE_KEY, 'true')
    }
  }, [])

  const handleSelectConversationByShortcut = useCallback(
    (index: number) => {
      if (mode === 'explain') {
        const nextThread = explainThreads[index]
        if (nextThread) {
          handleSelectExplainThread(nextThread.id)
        }
        return
      }

      if (mode !== 'direct') {
        return
      }

      const nextSession = directSessions[index]
      if (nextSession) {
        handleSelectDirectSession(nextSession.id)
      }
    },
    [directSessions, explainThreads, handleSelectDirectSession, handleSelectExplainThread, mode]
  )

  useEffect(() => {
    if (!isProjectSwitcherOpen) {
      return
    }

    if (orderedProjects.length === 0) {
      setIsProjectSwitcherOpen(false)
      setHighlightedProjectIndex(0)
      return
    }

    setHighlightedProjectIndex((current) => clampSelectionIndex(current, orderedProjects.length))
  }, [isProjectSwitcherOpen, orderedProjects.length])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) {
        return
      }

      const hasAltShortcutModifier = event.altKey && !event.ctrlKey && !event.metaKey
      const isHelpShortcut = isShortcutsHelpKey({
        key: event.key,
        code: event.code,
        shiftKey: event.shiftKey,
      })
      const canHandleHelpShortcut = isHelpShortcut && !event.altKey && !event.ctrlKey && !event.metaKey

      if (isShortcutsHelpOpen) {
        if (canHandleHelpShortcut && !isEditableShortcutTarget(event.target)) {
          event.preventDefault()
          handleCloseShortcutsHelp()
        }

        return
      }

      if (isProjectSwitcherOpen) {
        if (hasAltShortcutModifier && event.code === 'KeyP') {
          event.preventDefault()
          handleCloseProjectSwitcher()
        }

        return
      }

      if (hasBlockingModalOpen()) {
        return
      }

      if (canHandleHelpShortcut && !isEditableShortcutTarget(event.target)) {
        event.preventDefault()
        handleOpenShortcutsHelp()
        return
      }

      if (!hasAltShortcutModifier) {
        return
      }

      if (event.code === 'KeyP') {
        event.preventDefault()
        handleOpenProjectSwitcher()
        return
      }

      if (mode !== 'explain' && mode !== 'direct') {
        return
      }

      if (event.code === 'KeyE') {
        event.preventDefault()
        setComposerFocusToken((current) => current + 1)
        return
      }

      if (event.code === 'KeyN') {
        event.preventDefault()

        if (mode === 'explain') {
          void handleCreateExplainThread()
          return
        }

        void handleCreateDirectSession()
        return
      }

      const selectionIndex = getAltNumberSelectionIndex(event.code)
      if (selectionIndex === null) {
        return
      }

      event.preventDefault()
      handleSelectConversationByShortcut(selectionIndex)
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [
    handleCloseShortcutsHelp,
    handleCloseProjectSwitcher,
    handleCreateDirectSession,
    handleCreateExplainThread,
    handleOpenShortcutsHelp,
    handleOpenProjectSwitcher,
    handleSelectConversationByShortcut,
    isProjectSwitcherOpen,
    isShortcutsHelpOpen,
    mode,
  ])

  if (authRequired && !token) {
    return <LoginView error={authError} onAccountSubmit={handleAccountLogin} />
  }

  if (isLoadingConfig || !config) {
    return (
      <div className="min-h-screen bg-zinc-950 text-zinc-100 flex items-center justify-center p-6">
        <div className="text-center">
          <p className="text-sm text-zinc-400">
            {configError ? `설정을 불러오지 못했습니다: ${configError}` : '설정을 불러오는 중...'}
          </p>
        </div>
      </div>
    )
  }

  if (mustChangePassword) {
    return (
      <PasswordChangeView
        accountName={config.auth.session.accountName}
        error={passwordChangeError}
        onLogout={handleLogout}
        onSubmit={handlePasswordChange}
      />
    )
  }

  return (
    <>
      <Layout
        sidebar={
          <Sidebar
            mode={mode}
            onModeChange={setMode}
            onOpenExplainHome={handleOpenExplainHome}
            onOpenDirectHome={handleOpenDirectHome}
            onOpenRequestHome={handleOpenRequestHome}
            onCreateRequest={handleStartCreateRequest}
            onOpenTicketHome={handleOpenTicketHome}
            onCreateTicket={handleStartCreateTicket}
            onOpenIncidentHome={() => {
              void handleOpenIncidentHome()
            }}
            tickets={tickets}
            requests={clientRequests}
            incidents={incidents}
            selectedTicketId={selectedTicketId}
            selectedRequestId={selectedRequestId}
            selectedIncidentId={selectedIncidentId}
            onSelectTicket={handleSelectTicketFromSidebar}
            onSelectRequest={handleSelectRequestFromSidebar}
            onSelectIncident={handleSelectIncidentFromSidebar}
            onDeleteTicket={handleDeleteTicket}
            onDeleteRequest={handleDeleteRequest}
            explainThreads={explainThreads}
            selectedExplainThreadId={selectedExplainThreadId}
            onSelectExplainThread={handleSelectExplainThread}
            onCreateExplainThread={handleCreateExplainThread}
            onDeleteExplainThread={handleDeleteExplainThread}
            onRenameExplainThread={handleRenameExplainThread}
            directSessions={directSessions}
            selectedDirectSessionId={selectedDirectSessionId}
            onSelectDirectSession={handleSelectDirectSession}
            onCreateDirectSession={handleCreateDirectSession}
            onDeleteDirectSession={handleDeleteDirectSession}
            onRenameDirectSession={handleRenameDirectSession}
            onOpenShortcutsHelp={handleOpenShortcutsHelp}
            authSession={config.auth.session}
            onLogout={handleLogout}
          />
        }
        secondarySidebar={
          <CompletedRepliesSidebar
            items={completedReplyItems}
            collapsed={isCompletedRepliesCollapsed}
            sortOrder={completedReplySortOrder}
            onToggleCollapse={() => {
              setIsCompletedRepliesCollapsed((current) => !current)
            }}
            onSortOrderChange={setCompletedReplySortOrder}
            onDismissAll={() => {
              dismissAllCompletedReplies(completedReplyItems.map((item) => item.id))
            }}
          />
        }
      >
        {mode === 'explain' ? (
          <ChatView
            projectId={projectId}
            explainState={explainState}
            selectedExplainThreadId={selectedExplainThreadId}
            composerFocusToken={composerFocusToken}
            config={config}
            onProjectChange={setProjectId}
            onExplainStateChange={handleExplainStateChange}
            onRequestCreated={handleRequestCreated}
            onConfigUpdated={async () => {
              await refreshConfig()
            }}
          />
        ) : mode === 'direct' ? (
          <DirectView
            projectId={projectId}
            directState={directState}
            selectedDirectSessionId={selectedDirectSessionId}
            isStateLoading={isDirectStateLoading}
            composerFocusToken={composerFocusToken}
            config={config}
            onProjectChange={setProjectId}
            onDirectStateChange={handleDirectStateChange}
            onConfigUpdated={async () => {
              await refreshConfig()
            }}
          />
        ) : mode === 'requests' ? (
          <ClientRequestsView
            projectId={projectId}
            config={config}
            requests={clientRequests}
            isCreatingRequest={isCreatingRequest}
            selectedRequestId={selectedRequestId}
            onSelectRequest={(requestId) => {
              setIsCreatingRequest(false)
              setSelectedRequestId(requestId)
            }}
            onProjectChange={setProjectId}
            onStartCreate={handleStartCreateRequest}
            onCancelCreate={handleOpenRequestHome}
            onRefresh={refreshClientRequests}
            onConfigUpdated={async () => {
              await refreshConfig()
            }}
            onOpenTicket={(ticketId: string) => {
              setIsCreatingTicket(false)
              setSelectedTicketId(ticketId)
              setMode('ticket')
              refreshTickets()
            }}
          />
        ) : mode === 'incidents' ? (
          <IncidentsView
            projectId={projectId}
            config={config}
            incidents={incidents}
            selectedIncidentId={selectedIncidentId}
            onSelectIncident={handleSelectIncidentFromSidebar}
            onProjectChange={setProjectId}
            onRefresh={() => {
              void refreshIncidents()
            }}
            onConfigUpdated={async () => {
              await refreshConfig()
            }}
            onIncidentDeleted={(incidentId) => {
              if (selectedIncidentId === incidentId) {
                setSelectedIncidentId(null)
              }
            }}
          />
        ) : mode === 'access' ? (
          <AccessView
            config={config}
            projectId={projectId}
            onProjectChange={setProjectId}
            onConfigUpdated={async () => {
              await refreshConfig()
            }}
          />
        ) : (
          <TicketView
            projectId={projectId}
            config={config}
            ticketCount={tickets.length}
            isCreatingTicket={isCreatingTicket}
            selectedTicketId={selectedTicketId}
            onTicketCreated={(id) => {
              setIsCreatingTicket(false)
              setSelectedTicketId(id)
              refreshTickets()
            }}
            onTicketDeleted={() => {
              setSelectedTicketId(null)
            }}
            onProjectChange={setProjectId}
            onStartCreate={handleStartCreateTicket}
            onCancelCreate={handleOpenTicketHome}
            onRefresh={refreshTickets}
            onConfigUpdated={async () => {
              await refreshConfig()
            }}
            onOpenIncident={async (ticketId) => {
              const list = await fetchIncidents(projectId, ticketId)
              setIncidents(list)
              setSelectedIncidentId(list[0]?.id ?? null)
              setMode('incidents')
            }}
          />
        )}
      </Layout>

      {showShortcutHint ? (
        <div className="pointer-events-none fixed inset-x-4 top-4 z-40 flex justify-center">
          <div className="pointer-events-auto w-full max-w-md rounded-2xl border border-zinc-700 bg-zinc-950/96 p-4 shadow-2xl backdrop-blur">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-zinc-100">Keyboard Shortcuts</p>
                <p className="mt-1 text-xs leading-5 text-zinc-400">
                  프로젝트 전환과 대화 이동을 키보드로 바로 할 수 있습니다.
                </p>
              </div>
              <button
                type="button"
                onClick={handleDismissShortcutHint}
                className="shrink-0 rounded-lg border border-zinc-700 px-2.5 py-1.5 text-xs font-medium text-zinc-200 transition-colors hover:border-zinc-600 hover:bg-zinc-900"
              >
                닫기
              </button>
            </div>
            <div className="mt-3 grid gap-2 text-sm text-zinc-200 sm:grid-cols-2">
              <div className="rounded-xl border border-zinc-800 bg-zinc-900/70 px-3 py-2">
                <span className="font-medium text-sky-200">Alt+P</span>
                <span className="ml-2 text-zinc-400">프로젝트 전환</span>
              </div>
              <div className="rounded-xl border border-zinc-800 bg-zinc-900/70 px-3 py-2">
                <span className="font-medium text-emerald-200">Alt+1-5</span>
                <span className="ml-2 text-zinc-400">thread/session 선택</span>
              </div>
              <div className="rounded-xl border border-zinc-800 bg-zinc-900/70 px-3 py-2">
                <span className="font-medium text-amber-200">Alt+N</span>
                <span className="ml-2 text-zinc-400">새 thread/session</span>
              </div>
              <div className="rounded-xl border border-zinc-800 bg-zinc-900/70 px-3 py-2">
                <span className="font-medium text-violet-200">Alt+E</span>
                <span className="ml-2 text-zinc-400">입력창 포커스</span>
              </div>
              <div className="rounded-xl border border-zinc-800 bg-zinc-900/70 px-3 py-2 sm:col-span-2">
                <span className="font-medium text-fuchsia-200">?</span>
                <span className="ml-2 text-zinc-400">전체 단축키 도움말</span>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      <ShortcutsHelpDialog
        open={isShortcutsHelpOpen}
        onClose={handleCloseShortcutsHelp}
      />

      <ProjectSwitcherDialog
        open={isProjectSwitcherOpen}
        projects={orderedProjects}
        projectId={projectId}
        highlightedIndex={highlightedProjectIndex}
        onHighlightChange={setHighlightedProjectIndex}
        onProjectChange={handleSelectProjectFromSwitcher}
        onClose={handleCloseProjectSwitcher}
      />
    </>
  )
}
