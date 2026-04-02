import { useRef, useCallback } from 'react'
import { authorizedFetch } from '../lib/auth'

interface SSEEvent {
  event: string
  data: any
}

interface SSEHandlers {
  onOpen?: () => void
  onInit?: (data: Record<string, any>) => void
  onState?: (data: Record<string, any>) => void
  onStep?: (data: { runId?: string; stepId: string; status?: string; attempt?: number }) => void
  onDelta?: (data: { runId?: string; stepId?: string; text?: string; attempt?: number }) => void
  onToolUse?: (data: { id: string; server: string; tool: string; input: any }) => void
  onToolResult?: (data: { id: string; server: string; tool: string; result?: unknown; error?: string }) => void
  onDone?: (data: Record<string, any> & { runId?: string; stepId?: string; status?: string; attempts?: number }) => void
  onError?: (data: { message: string; code?: string }) => void
  onAbort?: () => void
}

function parseSSEChunk(chunk: string): SSEEvent[] {
  const events: SSEEvent[] = []
  const blocks = chunk.replace(/\r\n/g, '\n').split('\n\n')

  for (const block of blocks) {
    const lines = block.split('\n')
    let currentEvent = 'message'
    const dataLines: string[] = []

    for (const line of lines) {
      if (!line || line.startsWith(':')) {
        continue
      }

      if (line.startsWith('event:')) {
        currentEvent = line.slice(6).trim() || 'message'
        continue
      }

      if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart())
      }
    }

    if (dataLines.length === 0) {
      continue
    }

    const payload = dataLines.join('\n')
    try {
      events.push({ event: currentEvent, data: JSON.parse(payload) })
    } catch {
      events.push({ event: currentEvent, data: payload })
    }
  }

  return events
}

export function useSSE() {
  const abortRef = useRef<AbortController | null>(null)
  const silentAbortRef = useRef(false)

  const readStream = useCallback(async (response: Response, handlers: SSEHandlers) => {
    if (!response.ok || !response.body) {
      const payload = await response.json().catch(() => ({}))
      const message =
        payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string'
          ? payload.error
          : `HTTP ${response.status}`
      const code =
        payload && typeof payload === 'object' && 'code' in payload && typeof payload.code === 'string'
          ? payload.code
          : undefined
      handlers.onError?.({ message, code })
      return
    }

    handlers.onOpen?.()

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        buffer += decoder.decode()
        if (buffer.trim()) {
          const events = parseSSEChunk(buffer)
          for (const evt of events) {
            switch (evt.event) {
              case 'init':
                handlers.onInit?.(evt.data)
                break
              case 'state':
                handlers.onState?.(evt.data)
                break
              case 'step':
                handlers.onStep?.(evt.data)
                break
              case 'delta':
                handlers.onDelta?.(evt.data)
                break
              case 'tool_use':
                handlers.onToolUse?.(evt.data)
                break
              case 'tool_result':
                handlers.onToolResult?.(evt.data)
                break
              case 'done':
                handlers.onDone?.(evt.data)
                break
              case 'error':
                handlers.onError?.(evt.data)
                break
            }
          }
        }
        break
      }

      buffer += decoder.decode(value, { stream: true })

      const parts = buffer.split('\n\n')
      buffer = parts.pop() || ''

      for (const part of parts) {
        const events = parseSSEChunk(part + '\n\n')
        for (const evt of events) {
          switch (evt.event) {
            case 'init':
              handlers.onInit?.(evt.data)
              break
            case 'state':
              handlers.onState?.(evt.data)
              break
            case 'step':
              handlers.onStep?.(evt.data)
              break
            case 'delta':
              handlers.onDelta?.(evt.data)
              break
            case 'tool_use':
              handlers.onToolUse?.(evt.data)
              break
            case 'tool_result':
              handlers.onToolResult?.(evt.data)
              break
            case 'done':
              handlers.onDone?.(evt.data)
              break
            case 'error':
              handlers.onError?.(evt.data)
              break
          }
        }
      }
    }
  }, [])

  const startStream = useCallback(
    async (url: string, body: object, handlers: SSEHandlers) => {
      // Abort previous stream if any
      abortRef.current?.abort()
      silentAbortRef.current = false
      const controller = new AbortController()
      abortRef.current = controller

      try {
        const response = await authorizedFetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal,
        })
        await readStream(response, handlers)
      } catch (err: any) {
        if (err.name === 'AbortError') {
          if (!silentAbortRef.current) {
            handlers.onAbort?.()
          }
        } else {
          handlers.onError?.({ message: err.message, code: err.code })
        }
      } finally {
        silentAbortRef.current = false
        if (abortRef.current === controller) {
          abortRef.current = null
        }
      }
    },
    [readStream]
  )

  const startEventStream = useCallback(
    async (url: string, handlers: SSEHandlers) => {
      abortRef.current?.abort()
      silentAbortRef.current = false
      const controller = new AbortController()
      abortRef.current = controller

      try {
        const response = await authorizedFetch(url, {
          method: 'GET',
          signal: controller.signal,
        })

        await readStream(response, handlers)
      } catch (err: any) {
        if (err.name === 'AbortError') {
          if (!silentAbortRef.current) {
            handlers.onAbort?.()
          }
        } else {
          handlers.onError?.({ message: err.message, code: err.code })
        }
      } finally {
        silentAbortRef.current = false
        if (abortRef.current === controller) {
          abortRef.current = null
        }
      }
    },
    [readStream]
  )

  const abort = useCallback((options?: { silent?: boolean }) => {
    silentAbortRef.current = Boolean(options?.silent)
    abortRef.current?.abort()
    abortRef.current = null
  }, [])

  return { startStream, startEventStream, abort }
}
