import { nanoid } from 'nanoid'
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { resolveRuntimeDataPath } from '../lib/runtime-data-paths.js'
import {
  getTicket,
  type ReviewRun,
  type StageReview,
  type StepResult,
  type Ticket,
  type TicketTimelineEvent,
  type TicketWorktree,
  type VerificationRun,
} from './tickets.js'

export type IncidentSource = 'ticket'
export type IncidentStatus = 'captured' | 'analyzing' | 'analyzed' | 'analysis_failed'
export type IncidentResolutionStatus = 'pending' | 'running' | 'completed' | 'skipped' | 'failed'
export type IncidentResolutionActionType =
  | 'retry_ticket'
  | 'needs_decision'
  | 'needs_request_clarification'
  | 'manual_intervention'
export type IncidentTriggerKind =
  | 'analyze_failed'
  | 'verify_failed'
  | 'verification_environment_failed'
  | 'review_failed'
  | 'runner_exception'
  | 'retry_failed'
  | 'merge_failed'
  | 'discard_failed'

export interface IncidentTrigger {
  kind: IncidentTriggerKind
  message: string
  phase?: string | null
  attempt?: number
}

export interface IncidentTicketMetadata {
  id: string
  title: string
  description: string
  projectId: string
  projectPath: string
  categoryId: string
  linkedRequestId?: string
  threadId: string | null
  status: Ticket['status']
  runState: Ticket['runState']
  currentPhase: string | null
  attemptCount: number
}

export interface IncidentStepSnapshot {
  stepId: string
  status: StepResult['status']
  output: string
}

export interface IncidentBundle {
  ticket: IncidentTicketMetadata
  trigger: IncidentTrigger
  steps: IncidentStepSnapshot[]
  verificationRuns: VerificationRun[]
  latestReview?: ReviewRun
  stageReviews: StageReview[]
  timeline: TicketTimelineEvent[]
  worktree?: TicketWorktree
}

export interface IncidentAnalysis {
  summary: string
  likelyRootCause: string
  evidence: string[]
  impactedAreas: string[]
  nextActions: string[]
  missingSignals: string[]
  confidence: 'low' | 'medium' | 'high'
  recommendedAction: {
    type: 'rerun_from_step' | 'manual_intervention'
    startStepId?: 'analyze' | 'plan' | 'implement' | null
    rationale: string
  }
  resolution: {
    type: IncidentResolutionActionType
    startStepId?: 'analyze' | 'plan' | 'implement' | null
    rationale: string
  }
}

export interface IncidentResolutionState {
  status: IncidentResolutionStatus
  actionType?: IncidentResolutionActionType
  startStepId?: 'analyze' | 'plan' | 'implement' | null
  message: string
  updatedAt: string
}

export interface Incident {
  id: string
  source: IncidentSource
  sourceId: string
  projectId: string
  title: string
  status: IncidentStatus
  trigger: IncidentTrigger
  bundle: IncidentBundle
  analysis?: IncidentAnalysis
  analysisError?: string
  resolution?: IncidentResolutionState
  createdAt: string
  updatedAt: string
}

export interface PublicIncidentSummary {
  id: string
  source: IncidentSource
  sourceId: string
  projectId: string
  title: string
  status: IncidentStatus
  trigger: IncidentTrigger
  resolution?: IncidentResolutionState
  createdAt: string
  updatedAt: string
}

export interface PublicIncidentStepSnapshot {
  stepId: string
  status: StepResult['status']
  outputExcerpt: string
  truncated: boolean
}

export interface PublicIncidentVerificationCommand {
  id: string
  label: string
  required: boolean
  status: 'passed' | 'failed' | 'skipped'
  outputExcerpt: string
  truncated: boolean
  exitCode?: number
  durationMs?: number
  startedAt: string
  completedAt: string
}

export interface PublicIncidentVerificationRun {
  attempt: number
  status: 'passed' | 'failed'
  commands: PublicIncidentVerificationCommand[]
  startedAt: string
  completedAt: string
}

export interface PublicIncidentReview {
  id: string
  subjectStepId: string
  label: string
  attempt: number
  verdict: 'pass' | 'fail'
  summary: string
  blockingFindings: string[]
  residualRisks: string[]
  outputExcerpt: string
  truncated: boolean
  startedAt: string
  completedAt: string
}

export interface PublicIncidentTimelineEvent {
  id: string
  type: TicketTimelineEvent['type']
  title: string
  body?: string
  stepId?: string
  attempt?: number
  status?: string
  createdAt: string
}

export interface PublicIncidentWorktree {
  branchName: string
  baseBranch: string
  baseCommit: string
  headCommit?: string
  mergeCommit?: string
  diffSummaryExcerpt?: string
  diffSummaryTruncated?: boolean
  status: TicketWorktree['status']
  createdAt: string
  updatedAt: string
}

export interface PublicIncidentDetail extends PublicIncidentSummary {
  bundle: {
    ticket: Omit<IncidentTicketMetadata, 'threadId' | 'projectPath'>
    steps: PublicIncidentStepSnapshot[]
    verificationRuns: PublicIncidentVerificationRun[]
    latestReview?: {
      attempt: number
      verdict: 'pass' | 'fail'
      summary: string
      blockingFindings: string[]
      residualRisks: string[]
      releaseNotes: string[]
      outputExcerpt: string
      truncated: boolean
      startedAt: string
      completedAt: string
    }
    stageReviews: PublicIncidentReview[]
    timeline: PublicIncidentTimelineEvent[]
    worktree?: PublicIncidentWorktree
  }
  analysis?: IncidentAnalysis
  resolution?: IncidentResolutionState
}

const incidents = new Map<string, Incident>()
const OUTPUT_EXCERPT_LIMIT = 12_000
const VERIFICATION_OUTPUT_EXCERPT_LIMIT = 4_000
const TIMELINE_BODY_LIMIT = 4_000
const DIFF_SUMMARY_LIMIT = 8_000

function getIncidentsDir() {
  return resolveRuntimeDataPath('incidents')
}

function ensureIncidentsDir(projectId?: string) {
  const incidentsDir = getIncidentsDir()

  if (!existsSync(incidentsDir)) {
    mkdirSync(incidentsDir, { recursive: true })
  }

  if (projectId) {
    const projectDir = resolve(incidentsDir, projectId)
    if (!existsSync(projectDir)) {
      mkdirSync(projectDir, { recursive: true })
    }
  }
}

function buildIncidentPath(projectId: string, incidentId: string) {
  return resolve(getIncidentsDir(), projectId, `${incidentId}.json`)
}

function saveIncident(incident: Incident) {
  ensureIncidentsDir(incident.projectId)
  writeFileSync(buildIncidentPath(incident.projectId, incident.id), JSON.stringify(incident, null, 2), 'utf-8')
}

function scrubPathPrefix(text: string, pathValue: string, replacement: string) {
  if (!pathValue) {
    return text
  }

  return text.replaceAll(pathValue, replacement)
}

function sanitizeTextForBrowser(text: string, bundle: IncidentBundle) {
  let sanitized = text
  const replacements = [
    { value: bundle.worktree?.worktreePath, replacement: '[worktree]' },
    { value: bundle.ticket.projectPath, replacement: '[project]' },
  ]
    .filter((entry): entry is { value: string; replacement: string } => Boolean(entry.value))
    .sort((a, b) => b.value.length - a.value.length)

  for (const entry of replacements) {
    sanitized = scrubPathPrefix(sanitized, entry.value, entry.replacement)
  }

  return sanitized
}

function makeExcerpt(text: string, maxLength: number) {
  if (text.length <= maxLength) {
    return { text, truncated: false }
  }

  return {
    text: `${text.slice(0, maxLength)}\n\n[truncated]`,
    truncated: true,
  }
}

function toPublicTrigger(trigger: IncidentTrigger, bundle: IncidentBundle): IncidentTrigger {
  return {
    kind: trigger.kind,
    message: sanitizeTextForBrowser(trigger.message, bundle),
    phase: trigger.phase,
    attempt: trigger.attempt,
  }
}

function buildIncidentTitle(ticket: IncidentTicketMetadata, trigger: IncidentTrigger) {
  return `${ticket.title} · ${trigger.kind}`
}

function buildTicketMetadata(ticket: Ticket): IncidentTicketMetadata {
  return {
    id: ticket.id,
    title: ticket.title,
    description: ticket.description,
    projectId: ticket.projectId,
    projectPath: ticket.projectPath,
    categoryId: ticket.categoryId,
    linkedRequestId: ticket.linkedRequestId,
    threadId: ticket.implementationThreadId ?? ticket.planningThreadId,
    status: ticket.status,
    runState: ticket.runState,
    currentPhase: ticket.currentPhase,
    attemptCount: ticket.attemptCount,
  }
}

function buildIncidentBundle(ticket: Ticket, trigger: IncidentTrigger): IncidentBundle {
  const steps = ticket.flowStepIds
    .map((stepId) => ({
      stepId,
      status: ticket.steps[stepId]?.status ?? 'pending',
      output: ticket.steps[stepId]?.output ?? '',
    }))
    .filter((step) => step.output.trim() || step.status === 'failed')

  const verificationRuns = ticket.verificationRuns.filter(
    (run) => run.status === 'failed' || run.commands.some((command) => command.status === 'failed')
  )

  const latestReview = ticket.reviewRuns.at(-1)
  const stageReviewsBySubject = new Map<string, StageReview>()

  for (const review of [...ticket.stageReviews].reverse()) {
    if (!stageReviewsBySubject.has(review.subjectStepId)) {
      stageReviewsBySubject.set(review.subjectStepId, review)
    }
  }

  const stageReviews = Array.from(stageReviewsBySubject.values()).reverse()
  const timeline = ticket.timeline.slice(-12)

  return {
    ticket: buildTicketMetadata(ticket),
    trigger,
    steps,
    verificationRuns,
    latestReview,
    stageReviews,
    timeline,
    worktree: ticket.worktree,
  }
}

function normalizeIncident(raw: Incident): Incident {
  return {
    ...raw,
    status: raw.status ?? 'captured',
    source: raw.source ?? 'ticket',
    analysis: raw.analysis,
    analysisError: raw.analysisError,
    resolution: raw.resolution,
  }
}

function hydrateIncidentsFromDisk() {
  const incidentsDir = getIncidentsDir()

  ensureIncidentsDir()

  for (const entry of readdirSync(incidentsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue
    }

    const projectDir = resolve(incidentsDir, entry.name)
    for (const filename of readdirSync(projectDir)) {
      if (!filename.endsWith('.json')) {
        continue
      }

      const filepath = resolve(projectDir, filename)
      try {
        const parsed = JSON.parse(readFileSync(filepath, 'utf-8')) as Incident
        const incident = normalizeIncident(parsed)
        incidents.set(incident.id, incident)
      } catch (error: any) {
        if (error?.code === 'ENOENT') {
          continue
        }

        console.warn(`Failed to load persisted incident from ${filepath}:`, error)
      }
    }
  }
}

export function reloadIncidentsFromDisk() {
  incidents.clear()
  hydrateIncidentsFromDisk()
  return listIncidents()
}

export function createTicketIncident(ticketId: string, trigger: IncidentTrigger): Incident {
  const ticket = getTicket(ticketId)
  if (!ticket) {
    throw new Error('Ticket not found')
  }

  const now = new Date().toISOString()
  const bundle = buildIncidentBundle(ticket, trigger)
  const incident: Incident = {
    id: `INC-${nanoid(6)}`,
    source: 'ticket',
    sourceId: ticket.id,
    projectId: ticket.projectId,
    title: buildIncidentTitle(bundle.ticket, trigger),
    status: 'captured',
    trigger,
    bundle,
    resolution: {
      status: 'pending',
      message: '자동 분석 및 후속 조치를 대기 중입니다.',
      updatedAt: now,
    },
    createdAt: now,
    updatedAt: now,
  }

  incidents.set(incident.id, incident)
  saveIncident(incident)
  return incident
}

export function getIncident(incidentId: string) {
  return incidents.get(incidentId)
}

export function listIncidents(projectId?: string, ticketId?: string) {
  const scoped = Array.from(incidents.values()).filter((incident) => {
    if (projectId && incident.projectId !== projectId) {
      return false
    }

    if (ticketId && incident.sourceId !== ticketId) {
      return false
    }

    return true
  })

  return scoped.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
}

export function deleteIncident(incidentId: string) {
  const incident = incidents.get(incidentId)
  if (!incident) {
    return false
  }

  incidents.delete(incidentId)
  const filepath = buildIncidentPath(incident.projectId, incident.id)
  if (existsSync(filepath)) {
    unlinkSync(filepath)
  }
  return true
}

export function setIncidentStatus(incidentId: string, status: IncidentStatus, analysisError?: string) {
  const incident = incidents.get(incidentId)
  if (!incident) {
    return undefined
  }

  incident.status = status
  incident.analysisError = analysisError
  incident.updatedAt = new Date().toISOString()
  saveIncident(incident)
  return incident
}

export function setIncidentAnalysis(incidentId: string, analysis: IncidentAnalysis) {
  const incident = incidents.get(incidentId)
  if (!incident) {
    return undefined
  }

  incident.analysis = analysis
  incident.analysisError = undefined
  incident.status = 'analyzed'
  incident.updatedAt = new Date().toISOString()
  saveIncident(incident)
  return incident
}

export function setIncidentResolutionState(
  incidentId: string,
  resolution: Omit<IncidentResolutionState, 'updatedAt'> & { updatedAt?: string }
) {
  const incident = incidents.get(incidentId)
  if (!incident) {
    return undefined
  }

  const updatedAt = resolution.updatedAt ?? new Date().toISOString()
  incident.resolution = {
    ...resolution,
    updatedAt,
  }
  incident.updatedAt = updatedAt
  saveIncident(incident)
  return incident
}

export function toPublicIncidentSummary(incident: Incident): PublicIncidentSummary {
  return {
    id: incident.id,
    source: incident.source,
    sourceId: incident.sourceId,
    projectId: incident.projectId,
    title: incident.title,
    status: incident.status,
    trigger: toPublicTrigger(incident.trigger, incident.bundle),
    resolution: incident.resolution,
    createdAt: incident.createdAt,
    updatedAt: incident.updatedAt,
  }
}

export function toPublicIncidentDetail(incident: Incident): PublicIncidentDetail {
  const { bundle } = incident

  return {
    ...toPublicIncidentSummary(incident),
    bundle: {
      ticket: {
        id: bundle.ticket.id,
        title: bundle.ticket.title,
        description: sanitizeTextForBrowser(bundle.ticket.description, bundle),
        projectId: bundle.ticket.projectId,
        categoryId: bundle.ticket.categoryId,
        linkedRequestId: bundle.ticket.linkedRequestId,
        status: bundle.ticket.status,
        runState: bundle.ticket.runState,
        currentPhase: bundle.ticket.currentPhase,
        attemptCount: bundle.ticket.attemptCount,
      },
      steps: bundle.steps.map((step) => {
        const excerpt = makeExcerpt(sanitizeTextForBrowser(step.output, bundle), OUTPUT_EXCERPT_LIMIT)

        return {
          stepId: step.stepId,
          status: step.status,
          outputExcerpt: excerpt.text,
          truncated: excerpt.truncated,
        }
      }),
      verificationRuns: bundle.verificationRuns.map((run) => ({
        attempt: run.attempt,
        status: run.status,
        commands: run.commands.map((command) => {
          const excerpt = makeExcerpt(
            sanitizeTextForBrowser(command.output, bundle),
            VERIFICATION_OUTPUT_EXCERPT_LIMIT
          )

          return {
            id: command.id,
            label: command.label,
            required: command.required,
            status: command.status,
            outputExcerpt: excerpt.text,
            truncated: excerpt.truncated,
            exitCode: command.exitCode,
            durationMs: command.durationMs,
            startedAt: command.startedAt,
            completedAt: command.completedAt,
          }
        }),
        startedAt: run.startedAt,
        completedAt: run.completedAt,
      })),
      latestReview: bundle.latestReview
        ? {
            ...(() => {
              const excerpt = makeExcerpt(
                sanitizeTextForBrowser(bundle.latestReview?.output ?? '', bundle),
                OUTPUT_EXCERPT_LIMIT
              )

              return {
                outputExcerpt: excerpt.text,
                truncated: excerpt.truncated,
              }
            })(),
            attempt: bundle.latestReview.attempt,
            verdict: bundle.latestReview.verdict,
            summary: sanitizeTextForBrowser(bundle.latestReview.summary, bundle),
            blockingFindings: bundle.latestReview.blockingFindings.map((finding) =>
              sanitizeTextForBrowser(finding, bundle)
            ),
            residualRisks: bundle.latestReview.residualRisks.map((risk) => sanitizeTextForBrowser(risk, bundle)),
            releaseNotes: bundle.latestReview.releaseNotes.map((note) => sanitizeTextForBrowser(note, bundle)),
            startedAt: bundle.latestReview.startedAt,
            completedAt: bundle.latestReview.completedAt,
          }
        : undefined,
      stageReviews: bundle.stageReviews.map((review) => {
        const excerpt = makeExcerpt(sanitizeTextForBrowser(review.output, bundle), OUTPUT_EXCERPT_LIMIT)

        return {
          id: review.id,
          subjectStepId: review.subjectStepId,
          label: review.label,
          attempt: review.attempt,
          verdict: review.verdict,
          summary: sanitizeTextForBrowser(review.summary, bundle),
          blockingFindings: review.blockingFindings.map((finding) => sanitizeTextForBrowser(finding, bundle)),
          residualRisks: review.residualRisks.map((risk) => sanitizeTextForBrowser(risk, bundle)),
          outputExcerpt: excerpt.text,
          truncated: excerpt.truncated,
          startedAt: review.startedAt,
          completedAt: review.completedAt,
        }
      }),
      timeline: bundle.timeline.map((entry) => {
        const body = entry.body ? makeExcerpt(sanitizeTextForBrowser(entry.body, bundle), TIMELINE_BODY_LIMIT).text : undefined

        return {
          id: entry.id,
          type: entry.type,
          title: sanitizeTextForBrowser(entry.title, bundle),
          body,
          stepId: entry.stepId,
          attempt: entry.attempt,
          status: entry.status,
          createdAt: entry.createdAt,
        }
      }),
      worktree: bundle.worktree
        ? (() => {
            const diffSummary = bundle.worktree.diffSummary
              ? makeExcerpt(sanitizeTextForBrowser(bundle.worktree.diffSummary, bundle), DIFF_SUMMARY_LIMIT)
              : undefined

            return {
              branchName: bundle.worktree.branchName,
              baseBranch: bundle.worktree.baseBranch,
              baseCommit: bundle.worktree.baseCommit,
              headCommit: bundle.worktree.headCommit,
              mergeCommit: bundle.worktree.mergeCommit,
              diffSummaryExcerpt: diffSummary?.text,
              diffSummaryTruncated: diffSummary?.truncated,
              status: bundle.worktree.status,
              createdAt: bundle.worktree.createdAt,
              updatedAt: bundle.worktree.updatedAt,
            }
          })()
        : undefined,
    },
    analysis: incident.analysis,
    resolution: incident.resolution,
  }
}
