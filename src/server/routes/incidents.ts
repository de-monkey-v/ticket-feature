import { Hono } from 'hono'
import { getAuthSession, requireProjectPermission } from '../lib/auth.js'
import { hasPermission } from '../lib/access-policy.js'
import { loadConfig } from '../lib/config.js'
import { requireAccessibleProjectById } from '../lib/projects.js'
import { analyzeIncident, isIncidentAnalysisActive } from '../services/incident-analysis.js'
import {
  deleteIncident,
  getIncident,
  listIncidents,
  reloadIncidentsFromDisk,
  toPublicIncidentDetail,
  toPublicIncidentSummary,
} from '../services/incidents.js'

export const incidentRoutes = new Hono()

incidentRoutes.get('/incidents', (c) => {
  reloadIncidentsFromDisk()
  const config = loadConfig()
  const auth = getAuthSession(c)
  const projectId = c.req.query('projectId')
  const ticketId = c.req.query('ticketId')

  if (!hasPermission(auth, 'tickets')) {
    return c.json({ error: 'This token cannot access incidents', code: 'FEATURE_FORBIDDEN' }, 403)
  }

  if (projectId) {
    try {
      requireAccessibleProjectById(config, auth, projectId)
      const permissionError = requireProjectPermission(c, projectId, 'tickets')
      if (permissionError) {
        return permissionError
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown project'
      return c.json(
        { error: message, code: message === 'Project access denied' ? 'PROJECT_FORBIDDEN' : 'UNKNOWN_PROJECT' },
        message === 'Project access denied' ? 403 : 400
      )
    }
  }

  const allowedProjectIds = new Set(
    auth.projectIds === null ? config.projects.map((project) => project.id) : auth.projectIds
  )
  return c.json(
    listIncidents(projectId, ticketId)
      .filter((incident) => allowedProjectIds.has(incident.projectId))
      .map(toPublicIncidentSummary)
  )
})

incidentRoutes.get('/incidents/:id', (c) => {
  reloadIncidentsFromDisk()
  const incident = getIncident(c.req.param('id'))
  if (!incident) {
    return c.json({ error: 'Incident not found', code: 'UNKNOWN_INCIDENT' }, 404)
  }

  const permissionError = requireProjectPermission(c, incident.projectId, 'tickets')
  if (permissionError) {
    return permissionError
  }

  return c.json(toPublicIncidentDetail(incident))
})

incidentRoutes.post('/incidents/:id/analyze', async (c) => {
  const incidentId = c.req.param('id')
  reloadIncidentsFromDisk()
  const incident = getIncident(incidentId)
  if (!incident) {
    return c.json({ error: 'Incident not found', code: 'UNKNOWN_INCIDENT' }, 404)
  }

  const permissionError = requireProjectPermission(c, incident.projectId, 'tickets')
  if (permissionError) {
    return permissionError
  }

  if (isIncidentAnalysisActive(incidentId)) {
    return c.json({ error: 'Incident analysis is already running', code: 'INCIDENT_ANALYSIS_ACTIVE' }, 409)
  }

  try {
    const updated = await analyzeIncident(incidentId)
    return c.json(toPublicIncidentDetail(updated))
  } catch (error: any) {
    return c.json(
      {
        error: error?.message === 'Incident not found' ? error.message : 'Incident analysis failed',
        code: 'INCIDENT_ANALYSIS_FAILED',
      },
      error?.message === 'Incident not found' ? 404 : 502
    )
  }
})

incidentRoutes.delete('/incidents/:id', (c) => {
  const incidentId = c.req.param('id')
  reloadIncidentsFromDisk()
  const incident = getIncident(incidentId)
  if (!incident) {
    return c.json({ error: 'Incident not found', code: 'UNKNOWN_INCIDENT' }, 404)
  }

  const permissionError = requireProjectPermission(c, incident.projectId, 'tickets')
  if (permissionError) {
    return permissionError
  }

  if (isIncidentAnalysisActive(incidentId)) {
    return c.json({ error: 'Incident analysis is already running', code: 'INCIDENT_ANALYSIS_ACTIVE' }, 409)
  }

  const ok = deleteIncident(incidentId)
  if (!ok) {
    return c.json({ error: 'Incident not found', code: 'UNKNOWN_INCIDENT' }, 404)
  }

  return c.json({ ok: true })
})
