import { useEffect, useMemo, useRef, useState } from 'react'
import { useSSE } from '../hooks/useSSE'
import type {
  AppConfig,
  BackgroundRunStatus,
  ClientRequest,
  GeneratedRequestDraft,
  RequestTemplateFields,
} from '../lib/api'
import {
  createClientRequest,
  createTicketFromClientRequest,
  deleteClientRequest,
  startClientRequestDraftRun,
  stopBackgroundRun,
  updateRequestScreeningSettings,
} from '../lib/api'
import {
  clearRequestComposeState,
  loadRequestComposeState,
  saveRequestComposeState,
  type RequestComposeDraftSelections,
} from '../lib/request-compose-state'
import { WorkspaceHeader } from './WorkspaceHeader'

function createEmptyTemplate(): RequestTemplateFields {
  return {
    problem: '',
    desiredOutcome: '',
    userScenarios: '',
    constraints: '',
    nonGoals: '',
    openQuestions: '',
  }
}

function hasRequestDraftInput(title: string, template: RequestTemplateFields) {
  return Boolean(
    title.trim() ||
      template.problem.trim() ||
      template.desiredOutcome.trim() ||
      template.userScenarios.trim() ||
      template.constraints?.trim() ||
      template.nonGoals?.trim() ||
      template.openQuestions?.trim()
  )
}

function buildRequestDraftSignature(data: {
  requester: string
  title: string
  categoryId: string
  template: RequestTemplateFields
}) {
  return JSON.stringify(data)
}

function renderDraftValue(value: string | undefined, fallback = 'No suggestion') {
  return value?.trim() ? value : fallback
}

function hasChangedSuggestion(suggestedValue: string | undefined, currentValue: string) {
  return Boolean(suggestedValue?.trim() && suggestedValue !== currentValue)
}

const TEMPLATE_FIELD_CONFIG: Array<{ key: keyof RequestTemplateFields; label: string }> = [
  { key: 'problem', label: 'Problem' },
  { key: 'desiredOutcome', label: 'Desired Outcome' },
  { key: 'userScenarios', label: 'User Scenarios' },
  { key: 'constraints', label: 'Constraints' },
  { key: 'nonGoals', label: 'Non-Goals' },
  { key: 'openQuestions', label: 'Open Questions' },
]

type DraftSelectableFieldKey = 'title' | 'categoryId' | keyof RequestTemplateFields

type DraftSelectionState = RequestComposeDraftSelections & Record<DraftSelectableFieldKey, boolean>

function createEmptyDraftSelections(): DraftSelectionState {
  return {
    title: false,
    categoryId: false,
    problem: false,
    desiredOutcome: false,
    userScenarios: false,
    constraints: false,
    nonGoals: false,
    openQuestions: false,
  }
}

function isActiveBackgroundRunStatus(status: BackgroundRunStatus | undefined) {
  return status === 'queued' || status === 'running' || status === 'stopping'
}

function createDraftSelections(
  draft: GeneratedRequestDraft,
  current: {
    title: string
    categoryId: string
    template: RequestTemplateFields
  }
): DraftSelectionState {
  return {
    title: hasChangedSuggestion(draft.title, current.title),
    categoryId: Boolean(draft.categoryId.trim() && draft.categoryId !== current.categoryId),
    problem: hasChangedSuggestion(draft.template.problem, current.template.problem),
    desiredOutcome: hasChangedSuggestion(draft.template.desiredOutcome, current.template.desiredOutcome),
    userScenarios: hasChangedSuggestion(draft.template.userScenarios, current.template.userScenarios),
    constraints: hasChangedSuggestion(draft.template.constraints, current.template.constraints ?? ''),
    nonGoals: hasChangedSuggestion(draft.template.nonGoals, current.template.nonGoals ?? ''),
    openQuestions: hasChangedSuggestion(draft.template.openQuestions, current.template.openQuestions ?? ''),
  }
}

function parseGeneratedDraft(value: unknown): GeneratedRequestDraft | null {
  if (!value || typeof value !== 'object') {
    return null
  }

  const record = value as Record<string, unknown>
  const title = typeof record.title === 'string' ? record.title.trim() : ''
  const categoryId = typeof record.categoryId === 'string' ? record.categoryId.trim() : ''
  const templateSource =
    typeof record.template === 'object' && record.template !== null ? (record.template as Record<string, unknown>) : null

  const template = {
    problem: typeof templateSource?.problem === 'string' ? templateSource.problem.trim() : '',
    desiredOutcome: typeof templateSource?.desiredOutcome === 'string' ? templateSource.desiredOutcome.trim() : '',
    userScenarios: typeof templateSource?.userScenarios === 'string' ? templateSource.userScenarios.trim() : '',
    constraints: typeof templateSource?.constraints === 'string' ? templateSource.constraints.trim() : '',
    nonGoals: typeof templateSource?.nonGoals === 'string' ? templateSource.nonGoals.trim() : '',
    openQuestions: typeof templateSource?.openQuestions === 'string' ? templateSource.openQuestions.trim() : '',
  }

  if (!title || !categoryId || !template.problem || !template.desiredOutcome || !template.userScenarios) {
    return null
  }

  return {
    title,
    categoryId,
    template,
    rationale: typeof record.rationale === 'string' ? record.rationale.trim() || undefined : undefined,
  }
}

interface DraftSuggestionFieldProps {
  label: string
  value: string
  selected: boolean
  disabled: boolean
  helperText: string
  onToggle: (checked: boolean) => void
}

function DraftSuggestionField({
  label,
  value,
  selected,
  disabled,
  helperText,
  onToggle,
}: DraftSuggestionFieldProps) {
  return (
    <label
      className={`mt-2 block rounded-lg border px-3 py-3 ${
        selected && !disabled
          ? 'border-emerald-800/80 bg-emerald-950/20'
          : 'border-zinc-800 bg-zinc-950/50'
      } ${disabled ? 'opacity-70' : ''}`}
    >
      <div className="flex items-start gap-3">
        <input
          type="checkbox"
          checked={selected}
          disabled={disabled}
          onChange={(e) => onToggle(e.target.checked)}
          className="mt-0.5 h-4 w-4 rounded border-zinc-600 bg-zinc-900 text-emerald-500 focus:ring-emerald-600 disabled:cursor-not-allowed disabled:opacity-60"
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <p className="text-xs font-medium text-zinc-300">{label}</p>
            <p className="text-[11px] text-zinc-500">{helperText}</p>
          </div>
          <p className="mt-2 whitespace-pre-wrap text-sm text-zinc-200">{renderDraftValue(value)}</p>
        </div>
      </div>
    </label>
  )
}

function requestStatusLabel(status: ClientRequest['status']) {
  if (status === 'new') return '신규'
  if (status === 'ticket_created') return '티켓 생성됨'
  return status
}

function requestStatusBadge(status: ClientRequest['status']) {
  if (status === 'ticket_created') return 'bg-emerald-950/40 text-emerald-200'
  return 'bg-zinc-800 text-zinc-300'
}

function readinessStatusLabel(status: ClientRequest['readinessStatus']) {
  if (status === 'ready_for_ticket') return '티켓 생성 가능'
  if (status === 'needs_clarification') return '보완 필요'
  return status
}

function readinessStatusBadge(status: ClientRequest['readinessStatus']) {
  if (status === 'ready_for_ticket') return 'bg-blue-950/40 text-blue-200'
  return 'bg-amber-950/40 text-amber-200'
}

function requestSourceLabel(source: ClientRequest['source']) {
  if (source === 'chat') return 'Explain'
  return 'Manual'
}

function formatTimestamp(value: string) {
  return new Date(value).toLocaleString()
}

interface ClientRequestsViewProps {
  projectId: string
  config: AppConfig
  requests: ClientRequest[]
  isCreatingRequest: boolean
  selectedRequestId: string | null
  onSelectRequest: (requestId: string | null) => void
  onProjectChange: (projectId: string) => void
  onStartCreate: () => void
  onCancelCreate: () => void
  onRefresh: () => Promise<void> | void
  onConfigUpdated: () => Promise<void> | void
  onOpenTicket: (ticketId: string) => void
}

export function ClientRequestsView({
  projectId,
  config,
  requests,
  isCreatingRequest,
  selectedRequestId,
  onSelectRequest,
  onProjectChange,
  onStartCreate,
  onCancelCreate,
  onRefresh,
  onConfigUpdated,
  onOpenTicket,
}: ClientRequestsViewProps) {
  const [requester, setRequester] = useState('')
  const [title, setTitle] = useState('')
  const [template, setTemplate] = useState<RequestTemplateFields>(() => createEmptyTemplate())
  const [categoryId, setCategoryId] = useState(config.flows.ticket.categories[0]?.id ?? '')
  const [screeningModel, setScreeningModel] = useState(config.requests.screening.selectedModel)
  const [screeningModelSelectMode, setScreeningModelSelectMode] = useState(
    config.requests.screening.availableModels.some((entry) => entry.id === config.requests.screening.selectedModel)
      ? config.requests.screening.selectedModel
      : 'custom'
  )
  const [customScreeningModel, setCustomScreeningModel] = useState(config.requests.screening.selectedModel)
  const [isSavingScreeningModel, setIsSavingScreeningModel] = useState(false)
  const [screeningModelError, setScreeningModelError] = useState<string | null>(null)
  const [isGeneratingDraft, setIsGeneratingDraft] = useState(false)
  const [draftPreview, setDraftPreview] = useState<GeneratedRequestDraft | null>(null)
  const [draftSelections, setDraftSelections] = useState<DraftSelectionState>(() => createEmptyDraftSelections())
  const [draftError, setDraftError] = useState<string | null>(null)
  const [draftIsStale, setDraftIsStale] = useState(false)
  const [draftStatusLabel, setDraftStatusLabel] = useState<string | null>(null)
  const [draftStatusDetail, setDraftStatusDetail] = useState<string | null>(null)
  const [activeRunId, setActiveRunId] = useState<string | undefined>()
  const currentRunIdRef = useRef<string | undefined>(undefined)
  const draftSourceSignatureRef = useRef('')
  const draftSubscriptionIdRef = useRef(0)
  const currentDraftSignatureRef = useRef('')
  const loadedComposeProjectIdRef = useRef<string | null>(null)
  const { startEventStream, abort } = useSSE()

  const categoriesById = useMemo(
    () => Object.fromEntries(config.flows.ticket.categories.map((category) => [category.id, category])),
    [config]
  )
  const selectedRequest = useMemo(
    () => requests.find((request) => request.id === selectedRequestId) ?? null,
    [requests, selectedRequestId]
  )
  const screeningModelOptions = config.requests.screening.availableModels
  const screeningModelIsCurated = screeningModelOptions.some((entry) => entry.id === screeningModel)

  useEffect(() => {
    setScreeningModel(config.requests.screening.selectedModel)
    setScreeningModelSelectMode(
      config.requests.screening.availableModels.some((entry) => entry.id === config.requests.screening.selectedModel)
        ? config.requests.screening.selectedModel
        : 'custom'
    )
    setCustomScreeningModel(config.requests.screening.selectedModel)
    setScreeningModelError(null)
  }, [config.requests.screening.availableModels, config.requests.screening.selectedModel])

  useEffect(() => {
    if (!projectId || !isCreatingRequest) {
      loadedComposeProjectIdRef.current = null
      return
    }

    if (loadedComposeProjectIdRef.current === projectId) {
      return
    }

    const persisted = loadRequestComposeState(projectId)
    loadedComposeProjectIdRef.current = projectId

    setRequester(persisted?.requester ?? '')
    setTitle(persisted?.title ?? '')
    setTemplate(persisted?.template ?? createEmptyTemplate())
    setCategoryId(persisted?.categoryId || config.flows.ticket.categories[0]?.id || '')
    setDraftPreview(persisted?.draftPreview ?? null)
    setDraftSelections({
      ...createEmptyDraftSelections(),
      ...(persisted?.draftSelections ?? {}),
    })
    setDraftError(persisted?.draftError ?? null)
    setDraftIsStale(persisted?.draftIsStale ?? false)
    setDraftStatusLabel(null)
    setDraftStatusDetail(null)
    setActiveRunId(persisted?.activeRunId)
    currentRunIdRef.current = persisted?.activeRunId
  }, [config.flows.ticket.categories, isCreatingRequest, projectId])

  useEffect(() => {
    currentRunIdRef.current = activeRunId
  }, [activeRunId])

  currentDraftSignatureRef.current = buildRequestDraftSignature({
    requester,
    title,
    categoryId,
    template,
  })

  useEffect(() => {
    if (!projectId) {
      return
    }

    saveRequestComposeState(projectId, {
      requester,
      title,
      categoryId,
      template,
      draftPreview,
      draftSelections,
      draftError,
      draftIsStale,
      activeRunId,
    })
  }, [
    activeRunId,
    categoryId,
    draftError,
    draftIsStale,
    draftPreview,
    draftSelections,
    projectId,
    requester,
    template,
    title,
  ])

  const canSave =
    !!requester.trim() &&
    !!title.trim() &&
    !!template.problem.trim() &&
    !!template.desiredOutcome.trim() &&
    !!template.userScenarios.trim() &&
    !!categoryId
  const canGenerateDraft = !!projectId && !!categoryId && hasRequestDraftInput(title, template)

  const markDraftStale = (shouldMark = true) => {
    if (!shouldMark || !draftPreview) {
      return
    }

    setDraftIsStale(true)
  }

  const resetDraftPreview = () => {
    setDraftPreview(null)
    setDraftSelections(createEmptyDraftSelections())
    setDraftError(null)
    setDraftIsStale(false)
    if (!activeRunId) {
      setDraftStatusLabel(null)
      setDraftStatusDetail(null)
    }
  }

  const updateRequester = (value: string, shouldMarkDraftStale = true) => {
    setRequester(value)
    markDraftStale(shouldMarkDraftStale)
  }

  const updateTitle = (value: string, shouldMarkDraftStale = true) => {
    setTitle(value)
    markDraftStale(shouldMarkDraftStale)
  }

  const updateCategory = (value: string, shouldMarkDraftStale = true) => {
    setCategoryId(value)
    markDraftStale(shouldMarkDraftStale)
  }

  const updateTemplateField = (
    field: keyof RequestTemplateFields,
    value: string,
    shouldMarkDraftStale = true
  ) => {
    setTemplate((prev) => ({ ...prev, [field]: value }))
    markDraftStale(shouldMarkDraftStale)
  }

  const connectToDraftRun = async (runId: string) => {
    const subscriptionId = draftSubscriptionIdRef.current + 1
    draftSubscriptionIdRef.current = subscriptionId
    setIsGeneratingDraft(true)

    const isCurrentDraftSubscription = () =>
      draftSubscriptionIdRef.current === subscriptionId && currentRunIdRef.current === runId

    await startEventStream(`/api/background-runs/${encodeURIComponent(runId)}/events`, {
      onInit: (data) => {
        if (!isCurrentDraftSubscription()) {
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

        setIsGeneratingDraft(isActiveBackgroundRunStatus(run?.status))
        setDraftStatusLabel(run?.latestLabel ?? '요청 초안 정리 중')
        setDraftStatusDetail(run?.latestDetail ?? null)
      },
      onState: (data) => {
        if (!isCurrentDraftSubscription()) {
          return
        }

        setDraftStatusLabel(typeof data.label === 'string' ? data.label : '요청 초안 정리 중')
        setDraftStatusDetail(typeof data.detail === 'string' ? data.detail : null)
      },
      onDone: (data) => {
        if (!isCurrentDraftSubscription()) {
          return
        }

        draftSubscriptionIdRef.current += 1
        currentRunIdRef.current = undefined
        setActiveRunId(undefined)
        setIsGeneratingDraft(false)

        if (data.status === 'stopped') {
          const stoppedMessage =
            typeof data.error === 'string' ? data.error : '요청 초안 생성이 중단되었습니다.'
          setDraftError(stoppedMessage)
          setDraftStatusLabel('요청 초안 중단됨')
          setDraftStatusDetail(stoppedMessage)
          return
        }

        const generatedDraft = parseGeneratedDraft(data.draft)
        if (!generatedDraft) {
          setDraftError('요청 초안 결과를 해석하지 못했습니다.')
          setDraftStatusLabel('요청 초안 생성 실패')
          setDraftStatusDetail('요청 초안 결과를 해석하지 못했습니다.')
          return
        }

        setDraftPreview(generatedDraft)
        setDraftSelections(
          createDraftSelections(generatedDraft, {
            title,
            categoryId,
            template,
          })
        )
        setDraftError(null)
        setDraftIsStale(currentDraftSignatureRef.current !== draftSourceSignatureRef.current)
        setDraftStatusLabel(null)
        setDraftStatusDetail(null)
      },
      onError: (data) => {
        if (!isCurrentDraftSubscription()) {
          return
        }

        draftSubscriptionIdRef.current += 1
        currentRunIdRef.current = undefined
        setActiveRunId(undefined)
        setIsGeneratingDraft(false)
        setDraftError(data.message)
        setDraftStatusLabel('요청 초안 생성 실패')
        setDraftStatusDetail(data.message)
      },
    })
  }

  useEffect(() => {
    if (!projectId || !isCreatingRequest || !activeRunId) {
      return
    }

    void connectToDraftRun(activeRunId)

    return () => {
      draftSubscriptionIdRef.current += 1
      abort({ silent: true })
    }
  }, [abort, activeRunId, isCreatingRequest, projectId, startEventStream])

  useEffect(() => {
    if (isCreatingRequest) {
      return
    }

    draftSubscriptionIdRef.current += 1
    abort({ silent: true })
  }, [abort, isCreatingRequest])

  useEffect(() => {
    return () => {
      draftSubscriptionIdRef.current += 1
      abort({ silent: true })
    }
  }, [abort])

  const handleGenerateDraft = async () => {
    if (!canGenerateDraft || isGeneratingDraft || activeRunId) {
      return
    }

    draftSourceSignatureRef.current = currentDraftSignatureRef.current
    setIsGeneratingDraft(true)
    setDraftError(null)
    setDraftStatusLabel('요청 초안 정리 중')
    setDraftStatusDetail('입력한 내용을 바탕으로 AI draft를 생성하고 있습니다.')

    try {
      const started = await startClientRequestDraftRun({
        requester,
        title,
        template,
        projectId,
        categoryId,
        scopeLabel: title.trim() || requester.trim() || 'New Request Draft',
      })

      currentRunIdRef.current = started.run.id
      setActiveRunId(started.run.id)
      setIsGeneratingDraft(isActiveBackgroundRunStatus(started.run.status))
      setDraftStatusLabel(started.run.latestLabel ?? '요청 초안 정리 중')
      setDraftStatusDetail(started.run.latestDetail ?? '입력한 내용을 바탕으로 AI draft를 생성하고 있습니다.')
    } catch (error) {
      currentRunIdRef.current = undefined
      setActiveRunId(undefined)
      setIsGeneratingDraft(false)
      setDraftStatusLabel('요청 초안 생성 실패')
      setDraftStatusDetail(error instanceof Error ? error.message : 'Request draft generation failed')
      setDraftError(error instanceof Error ? error.message : 'Request draft generation failed')
    }
  }

  const handleCreate = async () => {
    if (!canSave || isGeneratingDraft || activeRunId) {
      return
    }

    const createdRequest = await createClientRequest({
      requester,
      title,
      template,
      projectId,
      categoryId,
    })

    resetDraftPreview()
    setRequester('')
    setTitle('')
    setTemplate(createEmptyTemplate())
    setCategoryId(config.flows.ticket.categories[0]?.id ?? '')
    setDraftStatusLabel(null)
    setDraftStatusDetail(null)
    setActiveRunId(undefined)
    currentRunIdRef.current = undefined
    clearRequestComposeState(projectId)
    await onRefresh()
    onSelectRequest(createdRequest.id)
  }

  const handleCreateTicket = async (requestId: string) => {
    const result = await createTicketFromClientRequest(requestId)
    await onRefresh()
    onOpenTicket(result.ticket.id)
  }

  const handleDeleteRequest = async (requestId: string) => {
    await deleteClientRequest(requestId)
    await onRefresh()
    onSelectRequest(null)
  }

  const persistScreeningModel = async (nextModel: string) => {
    const normalizedModel = nextModel.trim()
    if (!normalizedModel) {
      setScreeningModelError('Screening model ID를 입력해 주세요.')
      return
    }

    setIsSavingScreeningModel(true)
    setScreeningModelError(null)

    try {
      await updateRequestScreeningSettings({ model: normalizedModel })
      setScreeningModel(normalizedModel)
      setScreeningModelSelectMode(
        screeningModelOptions.some((entry) => entry.id === normalizedModel) ? normalizedModel : 'custom'
      )
      setCustomScreeningModel(normalizedModel)
      await onConfigUpdated()
    } catch (error) {
      setScreeningModelError(error instanceof Error ? error.message : 'Screening model 저장에 실패했습니다.')
    } finally {
      setIsSavingScreeningModel(false)
    }
  }

  const handleStopDraftGeneration = async () => {
    if (!activeRunId) {
      return
    }

    setDraftStatusLabel('중단 요청 중')
    setDraftStatusDetail('백그라운드 요청 초안 생성을 멈추고 있습니다.')

    try {
      const stoppedRun = await stopBackgroundRun(activeRunId)
      setIsGeneratingDraft(isActiveBackgroundRunStatus(stoppedRun.status))
      setDraftStatusLabel(stoppedRun.latestLabel ?? '중단 요청 중')
      setDraftStatusDetail(stoppedRun.latestDetail ?? '백그라운드 요청 초안 생성을 멈추고 있습니다.')
    } catch (error) {
      setDraftError(error instanceof Error ? error.message : '요청 초안 중단에 실패했습니다.')
      setDraftStatusLabel('중단 요청 실패')
      setDraftStatusDetail(error instanceof Error ? error.message : '요청 초안 중단에 실패했습니다.')
    }
  }

  const isDraftFieldApplicable = (
    field: DraftSelectableFieldKey,
    nextValues = {
      title,
      categoryId,
      template,
    }
  ) => {
    if (!draftPreview) {
      return false
    }

    if (field === 'title') {
      return hasChangedSuggestion(draftPreview.title, nextValues.title)
    }

    if (field === 'categoryId') {
      return Boolean(draftPreview.categoryId.trim() && draftPreview.categoryId !== nextValues.categoryId)
    }

    return hasChangedSuggestion(draftPreview.template[field], nextValues.template[field] ?? '')
  }

  const hasSelectedDraftChanges =
    !!draftPreview &&
    ((draftSelections.title && isDraftFieldApplicable('title')) ||
      (draftSelections.categoryId && isDraftFieldApplicable('categoryId')) ||
      TEMPLATE_FIELD_CONFIG.some((field) => draftSelections[field.key] && isDraftFieldApplicable(field.key)))

  const setDraftSelection = (field: DraftSelectableFieldKey, checked: boolean) => {
    setDraftSelections((prev) => ({
      ...prev,
      [field]: checked,
    }))
  }

  const draftHelperText = (field: DraftSelectableFieldKey) => {
    if (!draftPreview) {
      return ''
    }

    if (field === 'title') {
      if (!draftPreview.title.trim()) {
        return '제안 없음'
      }

      return draftPreview.title === title ? '현재 값과 동일' : draftSelections.title ? '적용 예정' : '적용 안 함'
    }

    if (field === 'categoryId') {
      if (!draftPreview.categoryId.trim()) {
        return '제안 없음'
      }

      return draftPreview.categoryId === categoryId
        ? '현재 값과 동일'
        : draftSelections.categoryId
          ? '적용 예정'
          : '적용 안 함'
    }

    const suggestedValue = draftPreview.template[field] ?? ''
    const currentValue = template[field] ?? ''

    if (!suggestedValue.trim()) {
      return '제안 없음'
    }

    return suggestedValue === currentValue ? '현재 값과 동일' : draftSelections[field] ? '적용 예정' : '적용 안 함'
  }

  const handleApplySelectedDraft = () => {
    if (!draftPreview) {
      return
    }

    let nextTitle = title
    let nextCategoryId = categoryId
    let nextTemplate = template
    let templateChanged = false

    if (draftSelections.title && isDraftFieldApplicable('title')) {
      nextTitle = draftPreview.title
    }

    if (draftSelections.categoryId && isDraftFieldApplicable('categoryId')) {
      nextCategoryId = draftPreview.categoryId
    }

    for (const field of TEMPLATE_FIELD_CONFIG) {
      if (!draftSelections[field.key] || !isDraftFieldApplicable(field.key)) {
        continue
      }

      if (!templateChanged) {
        nextTemplate = { ...template }
        templateChanged = true
      }

      nextTemplate[field.key] = draftPreview.template[field.key] ?? ''
    }

    if (nextTitle !== title) {
      updateTitle(nextTitle, false)
    }

    if (nextCategoryId !== categoryId) {
      updateCategory(nextCategoryId, false)
    }

    if (templateChanged) {
      setTemplate(nextTemplate)
    }

    setDraftSelections((prev) => {
      const nextSelections = { ...prev }
      const nextValues = {
        title: nextTitle,
        categoryId: nextCategoryId,
        template: nextTemplate,
      }

      if (nextSelections.title && !isDraftFieldApplicable('title', nextValues)) {
        nextSelections.title = false
      }

      if (nextSelections.categoryId && !isDraftFieldApplicable('categoryId', nextValues)) {
        nextSelections.categoryId = false
      }

      for (const field of TEMPLATE_FIELD_CONFIG) {
        if (nextSelections[field.key] && !isDraftFieldApplicable(field.key, nextValues)) {
          nextSelections[field.key] = false
        }
      }

      return nextSelections
    })
  }

  const requestsSubtitle = isCreatingRequest
    ? '새 client request를 작성합니다'
    : selectedRequest
      ? '선택한 request를 검토하고 ticket으로 전환합니다'
      : requests.length === 0
        ? '프로젝트 request가 아직 없습니다'
        : '프로젝트 request를 확인합니다'
  const requestsHeader = (
    <WorkspaceHeader
      authSession={config.auth.session}
      projects={config.allowedProjects}
      projectId={projectId}
      onProjectChange={onProjectChange}
      onConfigUpdated={onConfigUpdated}
      title="Requests"
      subtitle={requestsSubtitle}
    />
  )

  if (!isCreatingRequest && selectedRequest) {
    const category = categoriesById[selectedRequest.categoryId]

    return (
      <div className="flex h-full flex-col">
        {requestsHeader}
        <div className="flex-1 overflow-y-auto p-6">
          <div className="mx-auto max-w-4xl space-y-6">
            <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-5">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <span className="text-xs font-mono text-zinc-500">{selectedRequest.id}</span>
                    <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-xs text-zinc-300">
                      {category?.label ?? selectedRequest.categoryId}
                    </span>
                    <span className={`rounded-full px-2 py-0.5 text-xs ${requestStatusBadge(selectedRequest.status)}`}>
                      {requestStatusLabel(selectedRequest.status)}
                    </span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs ${readinessStatusBadge(selectedRequest.readinessStatus)}`}
                    >
                      {readinessStatusLabel(selectedRequest.readinessStatus)}
                    </span>
                  </div>
                  <h2 className="text-xl font-bold text-zinc-100">{selectedRequest.title}</h2>
                  <p className="mt-2 text-sm text-zinc-400">
                    {selectedRequest.requester} · {requestSourceLabel(selectedRequest.source)}
                  </p>
                </div>
                <button
                  onClick={onStartCreate}
                  className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 transition-colors hover:bg-zinc-800"
                >
                  New Request
                </button>
              </div>

              <div className="mt-4 grid gap-3 text-sm text-zinc-400 sm:grid-cols-2">
                <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 px-3 py-3">
                  <p className="text-xs font-medium uppercase tracking-[0.18em] text-zinc-500">Created</p>
                  <p className="mt-2 text-zinc-200">{formatTimestamp(selectedRequest.createdAt)}</p>
                </div>
                <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 px-3 py-3">
                  <p className="text-xs font-medium uppercase tracking-[0.18em] text-zinc-500">Updated</p>
                  <p className="mt-2 text-zinc-200">{formatTimestamp(selectedRequest.updatedAt)}</p>
                </div>
              </div>

              <div className="mt-4 flex flex-wrap gap-2">
                {selectedRequest.linkedTicketId ? (
                  <button
                    onClick={() => onOpenTicket(selectedRequest.linkedTicketId!)}
                    className="rounded-lg bg-zinc-700 px-3 py-2 text-sm font-medium text-zinc-100 transition-colors hover:bg-zinc-600"
                  >
                    Open Ticket
                  </button>
                ) : (
                  <button
                    onClick={() => handleCreateTicket(selectedRequest.id)}
                    disabled={selectedRequest.readinessStatus !== 'ready_for_ticket'}
                    className="rounded-lg bg-green-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-green-700 disabled:bg-zinc-700 disabled:text-zinc-500"
                  >
                    Create Ticket
                  </button>
                )}
                <button
                  onClick={() => handleDeleteRequest(selectedRequest.id)}
                  disabled={Boolean(selectedRequest.linkedTicketId)}
                  title={selectedRequest.linkedTicketId ? '연결된 ticket을 먼저 삭제해야 합니다.' : undefined}
                  className="rounded-lg bg-red-950/40 px-3 py-2 text-sm font-medium text-red-200 transition-colors hover:bg-red-950/60 disabled:bg-zinc-800 disabled:text-zinc-500 disabled:hover:bg-zinc-800"
                >
                  Delete Request
                </button>
              </div>

              {selectedRequest.linkedTicketId ? (
                <p className="mt-3 text-xs text-zinc-500">
                  이 요청은 ticket에 연결되어 있어서 ticket을 먼저 삭제해야 요청을 삭제할 수 있습니다.
                </p>
              ) : null}
            </div>

            <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-5">
              <h3 className="text-sm font-semibold text-zinc-100">Request Details</h3>
              <div className="mt-4 grid gap-3">
                {TEMPLATE_FIELD_CONFIG.map((field) => {
                  const value = selectedRequest.template[field.key] ?? ''
                  if (!value.trim()) {
                    return null
                  }

                  return (
                    <div key={field.key} className="rounded-lg border border-zinc-800 bg-zinc-950/40 px-4 py-3">
                      <p className="text-xs font-medium text-zinc-500">{field.label}</p>
                      <p className="mt-2 whitespace-pre-wrap text-sm text-zinc-200">{value}</p>
                    </div>
                  )
                })}
              </div>

              {selectedRequest.readinessNotes.length > 0 ? (
                <div className="mt-4 rounded-lg border border-amber-900/60 bg-amber-950/20 px-4 py-3 text-sm text-amber-100/90">
                  <p className="text-xs font-medium uppercase tracking-[0.18em] text-amber-200/80">Readiness Notes</p>
                  <div className="mt-2 space-y-1">
                    {selectedRequest.readinessNotes.map((note) => (
                      <p key={note}>- {note}</p>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    )
  }

  if (!isCreatingRequest && requests.length === 0) {
    return (
      <div className="flex h-full flex-col">
        {requestsHeader}
        <div className="flex-1 overflow-y-auto p-6">
          <div className="mx-auto flex min-h-[60vh] max-w-3xl items-center justify-center">
            <div className="w-full rounded-2xl border border-zinc-800 bg-zinc-900/50 p-8 text-center">
              <p className="text-sm font-medium text-zinc-200">아직 request가 없습니다.</p>
              <p className="mt-2 text-sm text-zinc-500">요청 목록은 여기에서 보고, 새로 만들 때만 intake 화면으로 들어가면 됩니다.</p>
              <button
                onClick={onStartCreate}
                className="mt-5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700"
              >
                New Request
              </button>
            </div>
          </div>
        </div>
      </div>
    )
  }

  if (!isCreatingRequest) {
    return (
      <div className="flex h-full flex-col">
        {requestsHeader}
        <div className="flex-1 overflow-y-auto p-6">
          <div className="mx-auto flex min-h-[60vh] max-w-3xl items-center justify-center">
            <div className="w-full rounded-2xl border border-zinc-800 bg-zinc-900/50 p-8 text-center">
              <p className="text-sm font-medium text-zinc-200">가장 최근 request를 여는 중입니다.</p>
              <p className="mt-2 text-sm text-zinc-500">잠시 뒤에도 바뀌지 않으면 왼쪽 목록에서 request를 직접 선택할 수 있습니다.</p>
              <button
                onClick={onStartCreate}
                className="mt-5 rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-2 text-sm font-medium text-zinc-200 transition-colors hover:bg-zinc-800"
              >
                New Request
              </button>
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      {requestsHeader}
      <div className="flex-1 overflow-y-auto p-6">
        <div className="mx-auto max-w-4xl">
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-5">
            <div className="mb-4 flex flex-col gap-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-lg font-bold">Client Request Intake</h2>
                  <p className="mt-1 text-xs text-zinc-500">무의미한 입력 차단용 screening 모델을 요청 폼에서 따로 고를 수 있습니다.</p>
                </div>
                <button
                  onClick={onCancelCreate}
                  className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 transition-colors hover:bg-zinc-800"
                >
                  {requests.length > 0 ? 'Back to Latest' : 'Back'}
                </button>
              </div>
              <div className="rounded-lg border border-zinc-800 bg-zinc-950/50 p-3">
                <p className="text-xs font-medium text-zinc-400">Request Screening Model</p>
                <div className="mt-2 grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
                  <select
                    value={screeningModelSelectMode}
                    disabled={isSavingScreeningModel}
                    onChange={(e) => {
                      const nextValue = e.target.value
                      setScreeningModelError(null)

                      if (nextValue === 'custom') {
                        setScreeningModelSelectMode('custom')
                        setCustomScreeningModel(screeningModelIsCurated ? '' : screeningModel)
                        return
                      }

                      setScreeningModelSelectMode(nextValue)
                      void persistScreeningModel(nextValue)
                    }}
                    className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm focus:border-zinc-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {screeningModelOptions.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label}
                      </option>
                    ))}
                    <option value="custom">Custom model ID</option>
                  </select>
                  <input
                    value={customScreeningModel}
                    onChange={(e) => setCustomScreeningModel(e.target.value)}
                    placeholder="gpt-5.3-codex-spark"
                    disabled={screeningModelSelectMode !== 'custom' || isSavingScreeningModel}
                    className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm focus:border-zinc-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
                  />
                  <button
                    onClick={() => void persistScreeningModel(customScreeningModel)}
                    disabled={screeningModelSelectMode !== 'custom' || !customScreeningModel.trim() || isSavingScreeningModel}
                    className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm font-medium text-zinc-200 transition-colors hover:bg-zinc-800 disabled:cursor-not-allowed disabled:text-zinc-500"
                  >
                    {isSavingScreeningModel ? 'Saving...' : 'Apply'}
                  </button>
                </div>
                <p className="mt-2 text-[11px] text-zinc-500">현재 선택: {config.requests.screening.selectedModel}</p>
                {screeningModelError ? <p className="mt-2 text-xs text-red-400">{screeningModelError}</p> : null}
              </div>
            </div>
          {(draftStatusLabel || draftError) && isCreatingRequest ? (
            <div className="mb-4 rounded-xl border border-zinc-800 bg-zinc-950/60 px-4 py-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-zinc-100">{draftStatusLabel ?? '요청 초안 상태'}</p>
                  {draftStatusDetail ? <p className="mt-1 text-xs text-zinc-400">{draftStatusDetail}</p> : null}
                </div>
                {activeRunId ? (
                  <button
                    type="button"
                    onClick={() => {
                      void handleStopDraftGeneration()
                    }}
                    className="rounded-lg border border-red-900/70 bg-red-950/30 px-3 py-1.5 text-sm font-medium text-red-100 transition hover:bg-red-950/50"
                  >
                    중단
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}
          {draftPreview ? (
            <div className="mb-4 rounded-2xl border border-emerald-800/70 bg-emerald-950/20 p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-emerald-200">AI Draft Staging</p>
                  <p className="text-xs text-emerald-100/70">
                    체크된 항목만 현재 intake form에 한 번에 반영됩니다. 기본값은 모두 선택입니다.
                  </p>
                </div>
                <span className="rounded-full border border-emerald-800 bg-emerald-950/60 px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-emerald-200">
                  {isGeneratingDraft ? 'Refreshing' : draftIsStale ? 'Stale' : 'Ready'}
                </span>
              </div>

              {draftIsStale ? (
                <div className="mt-3 rounded-lg border border-amber-900/60 bg-amber-950/20 px-3 py-2 text-xs text-amber-100/90">
                  현재 form 내용이 이 초안 이후에 바뀌었습니다. 최신 입력을 반영하려면 AI 초안을 다시 생성하세요.
                </div>
              ) : null}

              <div className="mt-3 flex flex-wrap gap-3">
                <button
                  onClick={handleApplySelectedDraft}
                  disabled={!hasSelectedDraftChanges}
                  className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-zinc-800 disabled:text-zinc-500"
                >
                  선택 항목 적용
                </button>
                <button
                  onClick={resetDraftPreview}
                  className="rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-2 text-sm font-medium text-zinc-200 transition-colors hover:bg-zinc-800"
                >
                  초안 닫기
                </button>
              </div>
            </div>
          ) : null}
          <input
            value={requester}
            onChange={(e) => updateRequester(e.target.value)}
            placeholder="Requester name"
            className="mb-3 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-2 text-sm placeholder-zinc-500 focus:border-zinc-500 focus:outline-none"
          />
          <input
            value={title}
            onChange={(e) => updateTitle(e.target.value)}
            placeholder="Request title"
            className="mb-3 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-2 text-sm placeholder-zinc-500 focus:border-zinc-500 focus:outline-none"
          />
          {draftPreview ? (
            <DraftSuggestionField
              label="Title"
              value={draftPreview.title}
              selected={draftSelections.title && isDraftFieldApplicable('title')}
              disabled={!isDraftFieldApplicable('title')}
              helperText={draftHelperText('title')}
              onToggle={(checked) => setDraftSelection('title', checked)}
            />
          ) : null}
          <select
            value={categoryId}
            onChange={(e) => updateCategory(e.target.value)}
            className="mb-3 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-2 text-sm focus:border-zinc-500 focus:outline-none"
          >
            {config.flows.ticket.categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.label}
              </option>
            ))}
          </select>
          {draftPreview ? (
            <DraftSuggestionField
              label="Category"
              value={
                draftPreview.categoryId.trim()
                  ? `${categoriesById[draftPreview.categoryId]?.label ?? draftPreview.categoryId} (${draftPreview.categoryId})`
                  : ''
              }
              selected={draftSelections.categoryId && isDraftFieldApplicable('categoryId')}
              disabled={!isDraftFieldApplicable('categoryId')}
              helperText={draftHelperText('categoryId')}
              onToggle={(checked) => setDraftSelection('categoryId', checked)}
            />
          ) : null}
          <textarea
            value={template.problem}
            onChange={(e) => updateTemplateField('problem', e.target.value)}
            placeholder="Problem / background"
            rows={4}
            className="mb-3 w-full resize-none rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-2 text-sm placeholder-zinc-500 focus:border-zinc-500 focus:outline-none"
          />
          {draftPreview ? (
            <DraftSuggestionField
              label="Problem"
              value={draftPreview.template.problem}
              selected={draftSelections.problem && isDraftFieldApplicable('problem')}
              disabled={!isDraftFieldApplicable('problem')}
              helperText={draftHelperText('problem')}
              onToggle={(checked) => setDraftSelection('problem', checked)}
            />
          ) : null}
          <textarea
            value={template.desiredOutcome}
            onChange={(e) => updateTemplateField('desiredOutcome', e.target.value)}
            placeholder="Desired outcome"
            rows={4}
            className="mb-3 w-full resize-none rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-2 text-sm placeholder-zinc-500 focus:border-zinc-500 focus:outline-none"
          />
          {draftPreview ? (
            <DraftSuggestionField
              label="Desired Outcome"
              value={draftPreview.template.desiredOutcome}
              selected={draftSelections.desiredOutcome && isDraftFieldApplicable('desiredOutcome')}
              disabled={!isDraftFieldApplicable('desiredOutcome')}
              helperText={draftHelperText('desiredOutcome')}
              onToggle={(checked) => setDraftSelection('desiredOutcome', checked)}
            />
          ) : null}
          <textarea
            value={template.userScenarios}
            onChange={(e) => updateTemplateField('userScenarios', e.target.value)}
            placeholder="User scenarios"
            rows={4}
            className="mb-3 w-full resize-none rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-2 text-sm placeholder-zinc-500 focus:border-zinc-500 focus:outline-none"
          />
          {draftPreview ? (
            <DraftSuggestionField
              label="User Scenarios"
              value={draftPreview.template.userScenarios}
              selected={draftSelections.userScenarios && isDraftFieldApplicable('userScenarios')}
              disabled={!isDraftFieldApplicable('userScenarios')}
              helperText={draftHelperText('userScenarios')}
              onToggle={(checked) => setDraftSelection('userScenarios', checked)}
            />
          ) : null}
          <textarea
            value={template.constraints ?? ''}
            onChange={(e) => updateTemplateField('constraints', e.target.value)}
            placeholder="Constraints (optional)"
            rows={3}
            className="mb-3 w-full resize-none rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-2 text-sm placeholder-zinc-500 focus:border-zinc-500 focus:outline-none"
          />
          {draftPreview ? (
            <DraftSuggestionField
              label="Constraints"
              value={draftPreview.template.constraints ?? ''}
              selected={draftSelections.constraints && isDraftFieldApplicable('constraints')}
              disabled={!isDraftFieldApplicable('constraints')}
              helperText={draftHelperText('constraints')}
              onToggle={(checked) => setDraftSelection('constraints', checked)}
            />
          ) : null}
          <textarea
            value={template.nonGoals ?? ''}
            onChange={(e) => updateTemplateField('nonGoals', e.target.value)}
            placeholder="Non-goals (optional)"
            rows={3}
            className="mb-3 w-full resize-none rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-2 text-sm placeholder-zinc-500 focus:border-zinc-500 focus:outline-none"
          />
          {draftPreview ? (
            <DraftSuggestionField
              label="Non-Goals"
              value={draftPreview.template.nonGoals ?? ''}
              selected={draftSelections.nonGoals && isDraftFieldApplicable('nonGoals')}
              disabled={!isDraftFieldApplicable('nonGoals')}
              helperText={draftHelperText('nonGoals')}
              onToggle={(checked) => setDraftSelection('nonGoals', checked)}
            />
          ) : null}
          <textarea
            value={template.openQuestions ?? ''}
            onChange={(e) => updateTemplateField('openQuestions', e.target.value)}
            placeholder="Open questions (optional)"
            rows={3}
            className="mb-3 w-full resize-none rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-2 text-sm placeholder-zinc-500 focus:border-zinc-500 focus:outline-none"
          />
          {draftPreview ? (
            <DraftSuggestionField
              label="Open Questions"
              value={draftPreview.template.openQuestions ?? ''}
              selected={draftSelections.openQuestions && isDraftFieldApplicable('openQuestions')}
              disabled={!isDraftFieldApplicable('openQuestions')}
              helperText={draftHelperText('openQuestions')}
              onToggle={(checked) => setDraftSelection('openQuestions', checked)}
            />
          ) : null}

          <div className="grid gap-3 sm:grid-cols-2">
            <button
              onClick={handleGenerateDraft}
              disabled={!canGenerateDraft || isGeneratingDraft || Boolean(activeRunId)}
              className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-medium transition-colors hover:bg-emerald-600 disabled:bg-zinc-700 disabled:text-zinc-500"
            >
              {isGeneratingDraft ? 'AI 초안 생성 중...' : 'AI로 초안 만들기'}
            </button>
            <button
              onClick={handleCreate}
              disabled={!canSave || isGeneratingDraft || Boolean(activeRunId)}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium transition-colors hover:bg-blue-700 disabled:bg-zinc-700 disabled:text-zinc-500"
            >
              Save Client Request
            </button>
          </div>

          <p className="mt-3 text-xs text-zinc-500">제목 또는 본문 일부만 입력해도 AI 초안 미리보기를 만들 수 있습니다.</p>

          {draftError && !draftStatusLabel ? <p className="mt-3 text-xs text-red-400">{draftError}</p> : null}
          {draftPreview?.rationale ? (
            <div className="mt-4 rounded-lg border border-emerald-900/60 bg-emerald-950/30 px-3 py-2">
              <p className="text-xs font-medium text-emerald-200">Codex Note</p>
              <p className="mt-1 whitespace-pre-wrap text-xs text-emerald-100/80">{draftPreview.rationale}</p>
            </div>
          ) : null}
        </div>
      </div>
      </div>
    </div>
  )
}
