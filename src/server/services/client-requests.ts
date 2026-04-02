import { nanoid } from 'nanoid'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { resolveRuntimeDataPath } from '../lib/runtime-data-paths.js'
import { getTicket, reloadTicketsFromDisk } from './tickets.js'

export interface RequestTemplateFields {
  problem: string
  desiredOutcome: string
  userScenarios: string
  constraints?: string
  nonGoals?: string
  openQuestions?: string
}

export type RequestReadinessStatus = 'ready_for_ticket' | 'needs_clarification'

export interface ClientRequest {
  id: string
  requester: string
  title: string
  description: string
  template: RequestTemplateFields
  projectId: string
  categoryId: string
  source: 'manual' | 'chat'
  explainThreadId?: string
  status: 'new' | 'ticket_created'
  readinessStatus: RequestReadinessStatus
  readinessNotes: string[]
  linkedTicketId?: string
  createdAt: string
  updatedAt: string
}

interface PersistedClientRequest extends ClientRequest {
  version: 1
}

const requests = new Map<string, ClientRequest>()

function getRequestsDir() {
  return resolveRuntimeDataPath('client-requests')
}

function getProjectRequestsDir(projectId: string) {
  return resolve(getRequestsDir(), projectId)
}

function buildLegacyRequestPath(requestId: string) {
  return resolve(getRequestsDir(), `${requestId}.md`)
}

function buildLegacyRequestJsonPath(requestId: string) {
  return resolve(getRequestsDir(), `${requestId}.json`)
}

function buildRequestPath(projectId: string, requestId: string) {
  return resolve(getProjectRequestsDir(projectId), `${requestId}.md`)
}

function buildRequestJsonPath(projectId: string, requestId: string) {
  return resolve(getProjectRequestsDir(projectId), `${requestId}.json`)
}

function normalizeSingleLine(text: string | undefined) {
  return (text ?? '').replace(/\s+/g, ' ').trim()
}

function normalizeMultiline(text: string | undefined) {
  return (text ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function normalizeRequestTemplate(template: RequestTemplateFields): RequestTemplateFields {
  const constraints = normalizeMultiline(template.constraints)
  const nonGoals = normalizeMultiline(template.nonGoals)
  const openQuestions = normalizeMultiline(template.openQuestions)

  return {
    problem: normalizeMultiline(template.problem),
    desiredOutcome: normalizeMultiline(template.desiredOutcome),
    userScenarios: normalizeMultiline(template.userScenarios),
    constraints: constraints || undefined,
    nonGoals: nonGoals || undefined,
    openQuestions: openQuestions || undefined,
  }
}

export function formatRequestTemplateDescription(template: RequestTemplateFields) {
  const sections = [
    '## Problem',
    '',
    template.problem,
    '',
    '## Desired Outcome',
    '',
    template.desiredOutcome,
    '',
    '## User Scenarios',
    '',
    template.userScenarios,
  ]

  if (template.constraints) {
    sections.push('', '## Constraints', '', template.constraints)
  }

  if (template.nonGoals) {
    sections.push('', '## Non-Goals', '', template.nonGoals)
  }

  if (template.openQuestions) {
    sections.push('', '## Open Questions', '', template.openQuestions)
  }

  return sections.join('\n')
}

export function formatRequestTemplateForPrompt(template: RequestTemplateFields) {
  const sections = [
    'Problem:',
    template.problem,
    '',
    'Desired outcome:',
    template.desiredOutcome,
    '',
    'User scenarios:',
    template.userScenarios,
  ]

  if (template.constraints) {
    sections.push('', 'Constraints:', template.constraints)
  }

  if (template.nonGoals) {
    sections.push('', 'Non-goals:', template.nonGoals)
  }

  if (template.openQuestions) {
    sections.push('', 'Open questions:', template.openQuestions)
  }

  return sections.join('\n')
}

export function evaluateRequestReadiness(template: RequestTemplateFields): {
  readinessStatus: RequestReadinessStatus
  readinessNotes: string[]
} {
  const notes: string[] = []

  if (!template.problem.trim()) {
    notes.push('문제 배경이 비어 있습니다.')
  }

  if (!template.desiredOutcome.trim()) {
    notes.push('원하는 결과가 비어 있습니다.')
  }

  if (!template.userScenarios.trim()) {
    notes.push('대표 사용자 시나리오가 비어 있습니다.')
  }

  return {
    readinessStatus: notes.length === 0 ? 'ready_for_ticket' : 'needs_clarification',
    readinessNotes: notes,
  }
}

export function buildTicketDraftFromRequest(request: ClientRequest) {
  const lines = [
    formatRequestTemplateDescription(request.template),
    '',
    '## Ticket Planning Notes',
    '',
    `- Request readiness: ${request.readinessStatus}`,
  ]

  if (request.readinessNotes.length > 0) {
    lines.push(...request.readinessNotes.map((note) => `- ${note}`))
  }

  lines.push(
    '',
    'Implement this as a technical plan based on the user-facing request above. Preserve intent, and resolve any remaining technical details during ticket planning.'
  )

  return {
    title: request.title,
    description: lines.join('\n'),
  }
}

function ensureRequestsDir(projectId?: string) {
  const requestsDir = getRequestsDir()

  if (!existsSync(requestsDir)) {
    mkdirSync(requestsDir, { recursive: true })
  }

  if (projectId) {
    const projectDir = getProjectRequestsDir(projectId)
    if (!existsSync(projectDir)) {
      mkdirSync(projectDir, { recursive: true })
    }
  }
}

function toPersistedClientRequest(request: ClientRequest): PersistedClientRequest {
  return {
    version: 1,
    ...request,
    template: {
      ...request.template,
    },
    readinessNotes: [...request.readinessNotes],
  }
}

function writeJsonRequest(request: ClientRequest, filepath: string) {
  writeFileSync(filepath, JSON.stringify(toPersistedClientRequest(request), null, 2), 'utf-8')
}

function saveRequest(request: ClientRequest) {
  ensureRequestsDir(request.projectId)
  const filepath = buildRequestPath(request.projectId, request.id)
  const jsonPath = buildRequestJsonPath(request.projectId, request.id)
  const legacyFilepath = buildLegacyRequestPath(request.id)
  const legacyJsonPath = buildLegacyRequestJsonPath(request.id)
  const content = [
    `# ${request.id}: ${request.title}`,
    '',
    `**Requester**: ${request.requester}`,
    `**Project ID**: ${request.projectId}`,
    `**Category**: ${request.categoryId}`,
    `**Source**: ${request.source}`,
    request.explainThreadId ? `**Explain Thread**: ${request.explainThreadId}` : '',
    `**Status**: ${request.status}`,
    `**Readiness**: ${request.readinessStatus}`,
    request.linkedTicketId ? `**Linked Ticket**: ${request.linkedTicketId}` : '',
    '',
    request.readinessNotes.length > 0 ? '## Readiness Notes' : '',
    request.readinessNotes.length > 0 ? '' : '',
    request.readinessNotes.length > 0 ? request.readinessNotes.map((note) => `- ${note}`).join('\n') : '',
    request.readinessNotes.length > 0 ? '' : '',
    '## Request Template',
    '',
    '### Problem',
    '',
    request.template.problem,
    '',
    '### Desired Outcome',
    '',
    request.template.desiredOutcome,
    '',
    '### User Scenarios',
    '',
    request.template.userScenarios,
    '',
    request.template.constraints ? '### Constraints' : '',
    request.template.constraints ? '' : '',
    request.template.constraints ?? '',
    request.template.constraints ? '' : '',
    request.template.nonGoals ? '### Non-Goals' : '',
    request.template.nonGoals ? '' : '',
    request.template.nonGoals ?? '',
    request.template.nonGoals ? '' : '',
    request.template.openQuestions ? '### Open Questions' : '',
    request.template.openQuestions ? '' : '',
    request.template.openQuestions ?? '',
    request.template.openQuestions ? '' : '',
    '## Description',
    '',
    request.description,
    '',
  ]
    .filter(Boolean)
    .join('\n')

  writeJsonRequest(request, jsonPath)
  writeFileSync(filepath, content, 'utf-8')

  if (legacyFilepath !== filepath && existsSync(legacyFilepath)) {
    unlinkSync(legacyFilepath)
  }
  if (legacyJsonPath !== jsonPath && existsSync(legacyJsonPath)) {
    unlinkSync(legacyJsonPath)
  }
}

function readRequestMetadata(markdown: string, label: string) {
  const normalizedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = markdown.match(new RegExp(`^\\*\\*${normalizedLabel}\\*\\*:\\s*(.*)$`, 'm'))
  return normalizeSingleLine(match?.[1])
}

function readMarkdownSection(markdown: string, heading: string) {
  const normalizedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = markdown.match(new RegExp(`^### ${normalizedHeading}\\s*$([\\s\\S]*?)(?=^### |^## |\\Z)`, 'm'))
  return normalizeMultiline(match?.[1])
}

function readMarkdownBulletList(markdown: string, heading: string) {
  const normalizedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = markdown.match(new RegExp(`^## ${normalizedHeading}\\s*$([\\s\\S]*?)(?=^## |\\Z)`, 'm'))
  if (!match?.[1]) {
    return []
  }

  return match[1]
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2).trim())
    .filter(Boolean)
}

function normalizeLoadedRequest(
  raw: Partial<ClientRequest> &
    Pick<ClientRequest, 'id' | 'requester' | 'title' | 'projectId' | 'categoryId' | 'createdAt' | 'updatedAt'>
): ClientRequest {
  const fallbackTimestamp = new Date().toISOString()
  const template = normalizeRequestTemplate({
    problem: raw.template?.problem ?? '',
    desiredOutcome: raw.template?.desiredOutcome ?? '',
    userScenarios: raw.template?.userScenarios ?? '',
    constraints: raw.template?.constraints,
    nonGoals: raw.template?.nonGoals,
    openQuestions: raw.template?.openQuestions,
  })
  const readiness = evaluateRequestReadiness(template)
  const readinessStatus =
    raw.readinessStatus === 'ready_for_ticket' || raw.readinessStatus === 'needs_clarification'
      ? raw.readinessStatus
      : readiness.readinessStatus
  const readinessNotes =
    Array.isArray(raw.readinessNotes) && raw.readinessNotes.length > 0
      ? raw.readinessNotes.map((note) => normalizeSingleLine(note)).filter(Boolean)
      : readiness.readinessNotes

  return {
    id: normalizeSingleLine(raw.id),
    requester: normalizeSingleLine(raw.requester),
    title: normalizeSingleLine(raw.title),
    description: normalizeMultiline(raw.description) || formatRequestTemplateDescription(template),
    template,
    projectId: normalizeSingleLine(raw.projectId),
    categoryId: normalizeSingleLine(raw.categoryId),
    source: raw.source === 'chat' ? 'chat' : 'manual',
    explainThreadId: normalizeSingleLine(raw.explainThreadId) || undefined,
    status: raw.status === 'ticket_created' ? 'ticket_created' : 'new',
    readinessStatus,
    readinessNotes,
    linkedTicketId: normalizeSingleLine(raw.linkedTicketId) || undefined,
    createdAt: raw.createdAt || fallbackTimestamp,
    updatedAt: raw.updatedAt || raw.createdAt || fallbackTimestamp,
  }
}

function loadClientRequestFromJson(filepath: string) {
  const parsed = JSON.parse(readFileSync(filepath, 'utf-8')) as PersistedClientRequest

  return normalizeLoadedRequest(parsed)
}

function loadClientRequestFromMarkdown(filepath: string) {
  const markdown = readFileSync(filepath, 'utf-8').replace(/\r\n/g, '\n')
  const stats = statSync(filepath)
  const titleMatch = markdown.match(/^#\s+(REQ-[^:]+):\s*(.+)$/m)
  if (!titleMatch) {
    throw new Error('Malformed legacy client request markdown')
  }

  const request = normalizeLoadedRequest({
    id: titleMatch[1]?.trim() || '',
    requester: readRequestMetadata(markdown, 'Requester'),
    title: titleMatch[2]?.trim() || '',
    description: normalizeMultiline(markdown.split(/^## Description\s*$/m)[1] ?? ''),
    template: {
      problem: readMarkdownSection(markdown, 'Problem'),
      desiredOutcome: readMarkdownSection(markdown, 'Desired Outcome'),
      userScenarios: readMarkdownSection(markdown, 'User Scenarios'),
      constraints: readMarkdownSection(markdown, 'Constraints') || undefined,
      nonGoals: readMarkdownSection(markdown, 'Non-Goals') || undefined,
      openQuestions: readMarkdownSection(markdown, 'Open Questions') || undefined,
    },
    projectId: readRequestMetadata(markdown, 'Project ID'),
    categoryId: readRequestMetadata(markdown, 'Category'),
    source: readRequestMetadata(markdown, 'Source') === 'chat' ? 'chat' : 'manual',
    explainThreadId: readRequestMetadata(markdown, 'Explain Thread') || undefined,
    status: readRequestMetadata(markdown, 'Status') === 'ticket_created' ? 'ticket_created' : 'new',
    readinessStatus:
      readRequestMetadata(markdown, 'Readiness') === 'ready_for_ticket' ? 'ready_for_ticket' : 'needs_clarification',
    readinessNotes: readMarkdownBulletList(markdown, 'Readiness Notes'),
    linkedTicketId: readRequestMetadata(markdown, 'Linked Ticket') || undefined,
    createdAt: stats.mtime.toISOString(),
    updatedAt: stats.mtime.toISOString(),
  })

  return request
}

function loadRequestsFromDirectory(dirpath: string, loadedIds: Set<string>) {
  if (!existsSync(dirpath)) {
    return
  }

  const entries = readdirSync(dirpath, { withFileTypes: true })
  const jsonBasenames = new Set(
    entries.filter((entry) => entry.isFile() && entry.name.endsWith('.json')).map((entry) => entry.name.slice(0, -5))
  )

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) {
      continue
    }

    const request = loadClientRequestFromJson(resolve(dirpath, entry.name))
    requests.set(request.id, request)
    loadedIds.add(request.id)
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) {
      continue
    }

    const requestId = entry.name.slice(0, -3)
    if (loadedIds.has(requestId) || jsonBasenames.has(requestId)) {
      continue
    }

    const request = loadClientRequestFromMarkdown(resolve(dirpath, entry.name))
    requests.set(request.id, request)
    loadedIds.add(request.id)
    saveRequest(request)
  }
}

export function reloadClientRequestsFromDisk() {
  const requestsDir = getRequestsDir()

  requests.clear()
  ensureRequestsDir()

  const loadedIds = new Set<string>()

  for (const entry of readdirSync(requestsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue
    }

    loadRequestsFromDirectory(resolve(requestsDir, entry.name), loadedIds)
  }

  loadRequestsFromDirectory(requestsDir, loadedIds)

  return listClientRequests()
}

export function createClientRequest(opts: {
  requester: string
  title: string
  template: RequestTemplateFields
  projectId: string
  categoryId: string
  source?: 'manual' | 'chat'
  explainThreadId?: string
}) {
  const now = new Date().toISOString()
  const template = normalizeRequestTemplate(opts.template)
  const readiness = evaluateRequestReadiness(template)
  const request: ClientRequest = {
    id: `REQ-${nanoid(6)}`,
    requester: normalizeSingleLine(opts.requester),
    title: normalizeSingleLine(opts.title),
    description: formatRequestTemplateDescription(template),
    template,
    projectId: opts.projectId,
    categoryId: opts.categoryId,
    source: opts.source ?? 'manual',
    explainThreadId: opts.explainThreadId,
    status: 'new',
    readinessStatus: readiness.readinessStatus,
    readinessNotes: readiness.readinessNotes,
    createdAt: now,
    updatedAt: now,
  }

  requests.set(request.id, request)
  saveRequest(request)
  return request
}

export function listClientRequests(projectId?: string) {
  const scopedRequests = Array.from(requests.values()).filter(
    (request) => !projectId || request.projectId === projectId
  )

  return scopedRequests.sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  )
}

export function getClientRequest(id: string) {
  return requests.get(id)
}

export function linkRequestToTicket(requestId: string, ticketId: string) {
  const request = requests.get(requestId)
  if (!request) {
    return undefined
  }

  request.status = 'ticket_created'
  request.linkedTicketId = ticketId
  request.updatedAt = new Date().toISOString()
  saveRequest(request)
  return request
}

export function unlinkRequestFromTicket(requestId: string) {
  const request = requests.get(requestId)
  if (!request) {
    return undefined
  }

  request.status = 'new'
  delete request.linkedTicketId
  request.updatedAt = new Date().toISOString()
  saveRequest(request)
  return request
}

export function reconcileClientRequestTicketLink(requestId: string) {
  const request = requests.get(requestId)
  if (!request?.linkedTicketId) {
    return request
  }

  reloadTicketsFromDisk()
  if (getTicket(request.linkedTicketId)) {
    return request
  }

  return unlinkRequestFromTicket(requestId)
}

export function reconcileClientRequestTicketLinks(projectIds?: Iterable<string>) {
  const scopedProjectIds = projectIds ? new Set(projectIds) : null
  reloadTicketsFromDisk()

  for (const request of requests.values()) {
    if (scopedProjectIds && !scopedProjectIds.has(request.projectId)) {
      continue
    }

    if (!request.linkedTicketId || getTicket(request.linkedTicketId)) {
      continue
    }

    unlinkRequestFromTicket(request.id)
  }
}

export function deleteClientRequest(requestId: string) {
  const request = requests.get(requestId)
  if (!request) {
    return false
  }

  requests.delete(requestId)
  const filepath = buildRequestPath(request.projectId, requestId)
  const jsonPath = buildRequestJsonPath(request.projectId, requestId)
  const legacyFilepath = buildLegacyRequestPath(requestId)
  const legacyJsonPath = buildLegacyRequestJsonPath(requestId)
  if (existsSync(filepath)) {
    unlinkSync(filepath)
  }
  if (existsSync(jsonPath)) {
    unlinkSync(jsonPath)
  }
  if (legacyFilepath !== filepath && existsSync(legacyFilepath)) {
    unlinkSync(legacyFilepath)
  }
  if (legacyJsonPath !== jsonPath && existsSync(legacyJsonPath)) {
    unlinkSync(legacyJsonPath)
  }
  return true
}
