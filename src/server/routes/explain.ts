import { Hono } from 'hono'
import { getAuthSession, requireProjectPermission } from '../lib/auth.js'
import { loadConfig } from '../lib/config.js'
import { requireAccessibleProjectById } from '../lib/projects.js'
import { loadExplainState, saveExplainState } from '../services/explain-state.js'

export const explainRoutes = new Hono()

explainRoutes.get('/explain/state', (c) => {
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

  const permissionError = requireProjectPermission(c, project.id, 'explain')
  if (permissionError) {
    return permissionError
  }

  return c.json(loadExplainState(auth, project.id))
})

explainRoutes.put('/explain/state', async (c) => {
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

  const permissionError = requireProjectPermission(c, project.id, 'explain')
  if (permissionError) {
    return permissionError
  }

  try {
    return c.json(saveExplainState(auth, project.id, state))
  } catch (error: any) {
    return c.json({ error: error.message || 'Failed to save explain state' }, 400)
  }
})
