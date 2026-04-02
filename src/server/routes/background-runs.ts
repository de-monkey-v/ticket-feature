import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { getAuthSession, requireProjectPermission } from '../lib/auth.js'
import {
  getBackgroundRun,
  listBackgroundRuns,
  readBackgroundRunEventJournal,
  stopBackgroundRun,
  subscribeToBackgroundRunEvents,
} from '../services/background-runs.js'

export const backgroundRunRoutes = new Hono()

backgroundRunRoutes.get('/background-runs', (c) => {
  const auth = getAuthSession(c)
  const projectId = c.req.query('projectId')?.trim()

  const runs = listBackgroundRuns(auth, projectId).filter(
    (run) => auth.isAdmin || auth.permissions.includes(run.permission)
  )

  return c.json({ runs })
})

backgroundRunRoutes.get('/background-runs/:id', (c) => {
  const auth = getAuthSession(c)
  const run = getBackgroundRun(auth, c.req.param('id'))
  if (!run) {
    return c.json({ error: 'Background run not found' }, 404)
  }

  const permissionError = requireProjectPermission(c, run.projectId, run.permission)
  if (permissionError) {
    return permissionError
  }

  return c.json(run)
})

backgroundRunRoutes.get('/background-runs/:id/events', (c) => {
  const auth = getAuthSession(c)
  const run = getBackgroundRun(auth, c.req.param('id'))
  if (!run) {
    return c.json({ error: 'Background run not found' }, 404)
  }

  const permissionError = requireProjectPermission(c, run.projectId, run.permission)
  if (permissionError) {
    return permissionError
  }

  return streamSSE(c, async (stream) => {
    let streamAborted = false

    const writeEvent = async (event: string, data: Record<string, unknown>) => {
      if (streamAborted) {
        return
      }

      await stream.writeSSE({
        event,
        data: JSON.stringify(data),
      })
    }

    await writeEvent('init', { run })

    const journal = readBackgroundRunEventJournal(run.id).filter((event) => event.type !== 'init')
    for (const entry of journal) {
      await writeEvent(entry.type, entry.data)
    }

    if (run.status === 'completed' || run.status === 'stopped' || run.status === 'failed') {
      return
    }

    await new Promise<void>((resolve) => {
      const unsubscribe = subscribeToBackgroundRunEvents(run.id, (event) => {
        if (event.type === 'init') {
          return
        }

        void writeEvent(event.type, event.data).finally(() => {
          if (event.type === 'done' || event.type === 'error') {
            unsubscribe()
            resolve()
          }
        })
      })

      stream.onAbort(() => {
        streamAborted = true
        unsubscribe()
        resolve()
      })
    })
  })
})

backgroundRunRoutes.post('/background-runs/:id/stop', (c) => {
  const auth = getAuthSession(c)
  const run = getBackgroundRun(auth, c.req.param('id'))
  if (!run) {
    return c.json({ error: 'Background run not found' }, 404)
  }

  const permissionError = requireProjectPermission(c, run.projectId, run.permission)
  if (permissionError) {
    return permissionError
  }

  try {
    return c.json(stopBackgroundRun(auth, run.id))
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? error.message : 'Failed to stop background run' },
      400
    )
  }
})
