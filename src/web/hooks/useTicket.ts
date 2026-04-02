import { useCallback, useRef, useState } from 'react'
import { useSSE } from './useSSE'
import type { TicketDetail, TicketRunDetail } from '../lib/api'
import {
  deleteTicket as apiDeleteTicket,
  discardTicket as apiDiscardTicket,
  fetchTicket,
  fetchTicketRun,
  mergeTicket as apiMergeTicket,
  resolveTicketMerge as apiResolveTicketMerge,
  retryTicket as apiRetryTicket,
  stopTicket as apiStopTicket,
} from '../lib/api'

const ACTIVE_RUN_STATES = new Set<TicketDetail['runState']>(['queued', 'running'])

function shouldFollowActiveRun(ticket: TicketDetail | null, selectedRunId: string | null) {
  return !selectedRunId || selectedRunId === ticket?.activeRunId
}

function resolveRunId(ticket: TicketDetail, preferredRunId?: string | null) {
  if (preferredRunId && ticket.runSummaries.some((run) => run.id === preferredRunId)) {
    return preferredRunId
  }

  return ticket.activeRunId ?? ticket.runSummaries.at(-1)?.id ?? null
}

export function useTicket() {
  const [ticket, setTicket] = useState<TicketDetail | null>(null)
  const [run, setRun] = useState<TicketRunDetail | null>(null)
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [currentStep, setCurrentStep] = useState<string | null>(null)
  const [streamingOutputs, setStreamingOutputs] = useState<Record<string, string>>({})
  const ticketRef = useRef<TicketDetail | null>(null)
  const runRef = useRef<TicketRunDetail | null>(null)
  const selectedRunIdRef = useRef<string | null>(null)
  const loadAbortRef = useRef<AbortController | null>(null)
  const loadRequestIdRef = useRef(0)
  const { startEventStream, abort: abortStream } = useSSE()

  const resetStreaming = useCallback(() => {
    setCurrentStep(null)
    setStreamingOutputs({})
  }, [])

  const applyTicketState = useCallback(
    (nextTicket: TicketDetail | null, nextRun: TicketRunDetail | null, nextSelectedRunId: string | null) => {
      ticketRef.current = nextTicket
      runRef.current = nextRun
      selectedRunIdRef.current = nextSelectedRunId
      setTicket(nextTicket)
      setRun(nextRun)
      setSelectedRunId(nextSelectedRunId)

      if (
        !nextTicket ||
        !ACTIVE_RUN_STATES.has(nextTicket.runState) ||
        !nextSelectedRunId ||
        nextSelectedRunId !== nextTicket.activeRunId
      ) {
        resetStreaming()
      }
    },
    [resetStreaming]
  )

  const cancelPendingLoad = useCallback(() => {
    loadRequestIdRef.current += 1
    loadAbortRef.current?.abort()
    loadAbortRef.current = null
  }, [])

  const clearTicketState = useCallback(() => {
    applyTicketState(null, null, null)
  }, [applyTicketState])

  const loadTicket = useCallback(
    async (id: string, preferredRunId?: string | null) => {
      cancelPendingLoad()

      const requestId = loadRequestIdRef.current
      const controller = new AbortController()
      loadAbortRef.current = controller

      try {
        const nextTicket = await fetchTicket(id, controller.signal)
        if (controller.signal.aborted || requestId !== loadRequestIdRef.current) {
          return null
        }

        const runId = resolveRunId(nextTicket, preferredRunId)
        const nextRun = runId ? await fetchTicketRun(id, runId, controller.signal) : null

        if (controller.signal.aborted || requestId !== loadRequestIdRef.current) {
          return null
        }

        applyTicketState(nextTicket, nextRun, runId)
        return { ticket: nextTicket, run: nextRun, selectedRunId: runId }
      } finally {
        if (loadAbortRef.current === controller) {
          loadAbortRef.current = null
        }
      }
    },
    [applyTicketState, cancelPendingLoad]
  )

  const selectRun = useCallback(
    async (ticketId: string, runId: string) => {
      const nextRun = await fetchTicketRun(ticketId, runId)
      runRef.current = nextRun
      selectedRunIdRef.current = runId
      setSelectedRunId(runId)
      setRun(nextRun)
      resetStreaming()
      return nextRun
    },
    [resetStreaming]
  )

  const connectToTicketStream = useCallback(
    async (ticketId: string) => {
      await startEventStream(`/api/tickets/${ticketId}/events`, {
        onState: (data) => {
          const nextTicket = data.ticket as TicketDetail | undefined
          const nextRun = (data.run as TicketRunDetail | null | undefined) ?? null
          if (!nextTicket) return

          const followActive = shouldFollowActiveRun(ticketRef.current, selectedRunIdRef.current)
          const nextSelectedRunId = followActive ? nextTicket.activeRunId : selectedRunIdRef.current
          const nextSelectedRun = followActive
            ? nextRun
            : nextRun && nextRun.id === selectedRunIdRef.current
              ? nextRun
              : runRef.current

          applyTicketState(nextTicket, nextSelectedRun ?? null, nextSelectedRunId ?? null)
        },
        onStep: (data) => {
          if (data.runId && data.runId !== selectedRunIdRef.current) {
            return
          }

          if (data.stepId) {
            setCurrentStep(data.stepId)
          }
        },
        onDelta: (data) => {
          if (data.runId && data.runId !== selectedRunIdRef.current) {
            return
          }

          const eventStepId = data.stepId
          if (!eventStepId) return
          setStreamingOutputs((prev) => ({
            ...prev,
            [eventStepId]: (prev[eventStepId] || '') + (data.text || ''),
          }))
        },
        onDone: (data) => {
          if (data.runId && data.runId !== selectedRunIdRef.current) {
            return
          }

          resetStreaming()
        },
        onError: (data) => {
          console.error('Ticket stream error:', data.message)
        },
      })
    },
    [applyTicketState, resetStreaming, startEventStream]
  )

  const merge = useCallback(
    async (ticketId: string) => {
      const result = await apiMergeTicket(ticketId)
      if (result.ok || result.needsDecision) {
        await loadTicket(ticketId)
      }
      return result
    },
    [loadTicket]
  )

  const resolveMerge = useCallback(
    async (ticketId: string, optionId: string) => {
      const result = await apiResolveTicketMerge(ticketId, optionId)
      if (result.ok || result.needsDecision) {
        await loadTicket(ticketId)
      }
      return result
    },
    [loadTicket]
  )

  const discard = useCallback(
    async (ticketId: string) => {
      const result = await apiDiscardTicket(ticketId)
      if (result.ok) {
        await loadTicket(ticketId)
      }
      return result
    },
    [loadTicket]
  )

  const retry = useCallback(
    async (
      ticketId: string,
      options?: {
        optionId?: string
        clarification?: string
      }
    ) => {
      const result = await apiRetryTicket(ticketId, options)
      if (result.ok) {
        await loadTicket(ticketId)
      }
      return result
    },
    [loadTicket]
  )

  const stop = useCallback(
    async (ticketId: string) => {
      const result = await apiStopTicket(ticketId)
      if (result.ok) {
        await loadTicket(ticketId, selectedRunIdRef.current)
      }
      return result
    },
    [loadTicket]
  )

  const remove = useCallback(
    async (ticketId: string) => {
      const result = await apiDeleteTicket(ticketId)
      if (result.ok) {
        cancelPendingLoad()
        clearTicketState()
      }
      return result
    },
    [cancelPendingLoad, clearTicketState]
  )

  const abort = useCallback(() => {
    cancelPendingLoad()
    clearTicketState()
    abortStream()
  }, [abortStream, cancelPendingLoad, clearTicketState])

  const isStreaming =
    Boolean(ticket && ACTIVE_RUN_STATES.has(ticket.runState) && selectedRunId && selectedRunId === ticket.activeRunId)

  return {
    ticket,
    run,
    selectedRunId,
    selectRun,
    currentStep,
    streamingOutputs,
    isStreaming,
    loadTicket,
    connectToTicketStream,
    merge,
    resolveMerge,
    discard,
    remove,
    retry,
    stop,
    abort,
  }
}
