import { Hono } from 'hono'
import { getAuthSession, requireAdmin, requireProjectPermission } from '../lib/auth.js'
import { hasPermission } from '../lib/access-policy.js'
import { loadConfig, reloadConfig, type ReasoningEffort } from '../lib/config.js'
import { getModelCapability, resolveReasoningEffortForModel } from '../lib/model-capabilities.js'
import { browseProjectDirectories, inferProjectAliasFromPath } from '../lib/project-browser.js'
import { requireAccessibleProjectById, toPublicConfig } from '../lib/projects.js'
import { pickProjectFolder } from '../lib/native-folder-picker.js'
import {
  deleteRuntimeProject,
  loadRuntimeSettings,
  registerRuntimeProject,
  updateExplainRuntimeSettings,
  updateRequestScreeningRuntimeSettings,
} from '../lib/runtime-settings.js'
import {
  type ChatInitialScrollTarget,
  updateUserChatPreferences,
  updateUserDirectPreferences,
  updateUserExplainPreferences,
} from '../lib/user-preferences.js'
import { listTickets, reloadTicketsFromDisk } from '../services/tickets.js'
import { listClientRequests, reloadClientRequestsFromDisk } from '../services/client-requests.js'

export const configRoutes = new Hono()

configRoutes.get('/config', (c) => {
  const config = loadConfig()
  return c.json(toPublicConfig(config, getAuthSession(c)))
})

configRoutes.post('/config/projects', async (c) => {
  const adminError = requireAdmin(c)
  if (adminError) {
    return adminError
  }

  const { label, path } = await c.req.json<{ label: string; path: string }>()

  if (!label?.trim() || !path?.trim()) {
    return c.json({ error: 'Project name and path are required' }, 400)
  }

  try {
    const baseConfig = loadConfig()
    registerRuntimeProject(baseConfig, label, path)
    const config = reloadConfig()
    return c.json(toPublicConfig(config, getAuthSession(c)))
  } catch (error: any) {
    return c.json({ error: error.message }, 400)
  }
})

configRoutes.delete('/config/projects/:id', async (c) => {
  const adminError = requireAdmin(c)
  if (adminError) {
    return adminError
  }

  const projectId = c.req.param('id')
  const runtimeProjectIds = new Set(loadRuntimeSettings().projects.map((project) => project.id))
  if (!runtimeProjectIds.has(projectId)) {
    return c.json({ error: 'Built-in projects cannot be deleted' }, 400)
  }

  reloadTicketsFromDisk()
  reloadClientRequestsFromDisk()

  const activeTicket = listTickets().find((ticket) => ticket.projectId === projectId)
  if (activeTicket) {
    return c.json({ error: 'Cannot delete a project referenced by existing tickets' }, 400)
  }

  const activeRequest = listClientRequests().find((request) => request.projectId === projectId)
  if (activeRequest) {
    return c.json({ error: 'Cannot delete a project referenced by existing client requests' }, 400)
  }

  try {
    deleteRuntimeProject(projectId)
    const config = reloadConfig()
    return c.json(toPublicConfig(config, getAuthSession(c)))
  } catch (error: any) {
    return c.json({ error: error.message }, 400)
  }
})

configRoutes.get('/config/projects/browse', async (c) => {
  const adminError = requireAdmin(c)
  if (adminError) {
    return adminError
  }

  try {
    const path = c.req.query('path')
    const result = await browseProjectDirectories(path)
    return c.json(result)
  } catch (error: any) {
    return c.json({ error: error.message }, 400)
  }
})

configRoutes.get('/config/projects/infer-name', async (c) => {
  const adminError = requireAdmin(c)
  if (adminError) {
    return adminError
  }

  const path = c.req.query('path')
  if (!path?.trim()) {
    return c.json({ error: 'Project path is required' }, 400)
  }

  try {
    return c.json({ label: inferProjectAliasFromPath(path) })
  } catch (error: any) {
    return c.json({ error: error.message }, 400)
  }
})

configRoutes.post('/config/projects/pick-folder', async (c) => {
  const adminError = requireAdmin(c)
  if (adminError) {
    return adminError
  }

  try {
    const path = await pickProjectFolder()
    return c.json({ path })
  } catch (error: any) {
    return c.json({ error: error.message }, 400)
  }
})

configRoutes.post('/config/explain', async (c) => {
  const adminError = requireAdmin(c)
  if (adminError) {
    return adminError
  }

  const { model, reasoningEffort } = await c.req.json<{
    model: string
    reasoningEffort: ReasoningEffort
  }>()

  if (!model?.trim() || !reasoningEffort) {
    return c.json({ error: 'Explain model and reasoning effort are required' }, 400)
  }

  try {
    const normalizedModel = getModelCapability(model).id
    const normalizedReasoningEffort = resolveReasoningEffortForModel(normalizedModel, reasoningEffort)
    updateExplainRuntimeSettings(normalizedModel, normalizedReasoningEffort)
    const config = reloadConfig()
    return c.json(toPublicConfig(config, getAuthSession(c)))
  } catch (error: any) {
    return c.json({ error: error.message }, 400)
  }
})

configRoutes.post('/config/preferences/chat', async (c) => {
  const auth = getAuthSession(c)
  const config = loadConfig()
  const { projectId, initialScrollTarget } = await c.req.json<{
    projectId?: string
    initialScrollTarget?: ChatInitialScrollTarget
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

  if (!hasPermission(auth, 'explain') && !hasPermission(auth, 'direct')) {
    return c.json({ error: 'This token cannot use chat preferences in the selected project', code: 'FEATURE_FORBIDDEN' }, 403)
  }

  if (initialScrollTarget !== 'bottom' && initialScrollTarget !== 'last_user_message') {
    return c.json({ error: 'A valid chat initial scroll target is required' }, 400)
  }

  updateUserChatPreferences(auth, initialScrollTarget)
  return c.json(toPublicConfig(loadConfig(), auth))
})

configRoutes.post('/config/preferences/explain', async (c) => {
  const auth = getAuthSession(c)
  const config = loadConfig()
  const { projectId, model, reasoningEffort } = await c.req.json<{
    projectId?: string
    model?: string
    reasoningEffort?: ReasoningEffort
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

  if (!model?.trim() || !reasoningEffort) {
    return c.json({ error: 'Explain model and reasoning effort are required' }, 400)
  }

  try {
    const normalizedModel = getModelCapability(model).id
    const normalizedReasoningEffort = resolveReasoningEffortForModel(normalizedModel, reasoningEffort)
    updateUserExplainPreferences(auth, normalizedModel, normalizedReasoningEffort)
    return c.json(toPublicConfig(loadConfig(), auth))
  } catch (error: any) {
    return c.json({ error: error.message || 'Failed to save explain preferences' }, 400)
  }
})

configRoutes.post('/config/preferences/direct', async (c) => {
  const auth = getAuthSession(c)
  const config = loadConfig()
  const { projectId, model, reasoningEffort } = await c.req.json<{
    projectId?: string
    model?: string
    reasoningEffort?: ReasoningEffort
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

  if (!model?.trim() || !reasoningEffort) {
    return c.json({ error: 'Direct model and reasoning effort are required' }, 400)
  }

  try {
    const normalizedModel = getModelCapability(model).id
    const normalizedReasoningEffort = resolveReasoningEffortForModel(normalizedModel, reasoningEffort)
    updateUserDirectPreferences(auth, normalizedModel, normalizedReasoningEffort)
    return c.json(toPublicConfig(loadConfig(), auth))
  } catch (error: any) {
    return c.json({ error: error.message || 'Failed to save direct preferences' }, 400)
  }
})

configRoutes.post('/config/requests/screening', async (c) => {
  const adminError = requireAdmin(c)
  if (adminError) {
    return adminError
  }

  const { model } = await c.req.json<{
    model: string
  }>()

  if (!model?.trim()) {
    return c.json({ error: 'Request screening model is required' }, 400)
  }

  try {
    updateRequestScreeningRuntimeSettings(model)
    const config = reloadConfig()
    return c.json(toPublicConfig(config, getAuthSession(c)))
  } catch (error: any) {
    return c.json({ error: error.message }, 400)
  }
})
