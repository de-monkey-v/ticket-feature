import { Hono } from 'hono'
import { getAuthSession, requireAdmin } from '../lib/auth.js'
import { loadConfig, reloadConfig, type ReasoningEffort } from '../lib/config.js'
import { getModelCapability, resolveReasoningEffortForModel } from '../lib/model-capabilities.js'
import { browseProjectDirectories, inferProjectAliasFromPath } from '../lib/project-browser.js'
import { toPublicConfig } from '../lib/projects.js'
import { pickProjectFolder } from '../lib/native-folder-picker.js'
import {
  deleteRuntimeProject,
  loadRuntimeSettings,
  registerRuntimeProject,
  updateExplainRuntimeSettings,
  updateRequestScreeningRuntimeSettings,
} from '../lib/runtime-settings.js'
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
