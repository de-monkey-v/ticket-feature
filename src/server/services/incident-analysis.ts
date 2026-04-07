import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { loadConfig } from '../lib/config.js'
import { getModelCapability, resolveReasoningEffortForModel } from '../lib/model-capabilities.js'
import { runCodexTurn } from './codex-sdk.js'
import { buildRepoReadMcpConfig } from './repo-read-tool.js'
import {
  getIncident,
  setIncidentAnalysis,
  setIncidentStatus,
  type Incident,
  type IncidentAnalysis,
} from './incidents.js'

const incidentAnalysisSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'summary',
    'likelyRootCause',
    'evidence',
    'impactedAreas',
    'nextActions',
    'missingSignals',
    'confidence',
    'recommendedAction',
    'resolution',
  ],
  properties: {
    summary: { type: 'string' },
    likelyRootCause: { type: 'string' },
    evidence: {
      type: 'array',
      items: { type: 'string' },
    },
    impactedAreas: {
      type: 'array',
      items: { type: 'string' },
    },
    nextActions: {
      type: 'array',
      items: { type: 'string' },
    },
    missingSignals: {
      type: 'array',
      items: { type: 'string' },
    },
    confidence: {
      type: 'string',
      enum: ['low', 'medium', 'high'],
    },
    recommendedAction: {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'rationale', 'startStepId'],
      properties: {
        type: {
          type: 'string',
          enum: ['rerun_from_step', 'manual_intervention'],
        },
        startStepId: {
          type: ['string', 'null'],
          enum: ['analyze', 'plan', 'implement', null],
        },
        rationale: { type: 'string' },
      },
    },
    resolution: {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'rationale', 'startStepId'],
      properties: {
        type: {
          type: 'string',
          enum: ['retry_ticket', 'needs_decision', 'needs_request_clarification', 'manual_intervention'],
        },
        startStepId: {
          type: ['string', 'null'],
          enum: ['analyze', 'plan', 'implement', null],
        },
        rationale: { type: 'string' },
      },
    },
  },
} as const

let runCodexTurnImpl: typeof runCodexTurn = runCodexTurn
const activeIncidentAnalyses = new Set<string>()
const TRIGGER_MESSAGE_LIMIT = 6_000
const STEP_OUTPUT_LIMIT = 1_500
const VERIFICATION_OUTPUT_LIMIT = 1_500
const REVIEW_OUTPUT_LIMIT = 1_200
const TIMELINE_BODY_LIMIT = 500
const DIFF_SUMMARY_LIMIT = 2_000
const PROJECT_SKILLS_DIR = resolve(process.cwd(), '.codex/skills')
const TICKET_INCIDENT_ANALYZE_SKILL = 'ticket-incident-analyze'

function makeExcerpt(text: string | undefined, limit: number) {
  if (!text) {
    return ''
  }

  if (text.length <= limit) {
    return text
  }

  return `${text.slice(0, limit)}\n...[truncated ${text.length - limit} chars]`
}

function getProjectSkillDirectories() {
  if (!existsSync(PROJECT_SKILLS_DIR)) {
    return undefined
  }

  return [PROJECT_SKILLS_DIR]
}

function buildSkillInvocation(skillName: string) {
  return `Use $${skillName} at ${resolve(PROJECT_SKILLS_DIR, skillName)} for this ticket step.`
}

export function setRunCodexTurnForIncidentAnalysisTesting(fn: typeof runCodexTurn) {
  runCodexTurnImpl = fn
}

export function resetRunCodexTurnForIncidentAnalysisTesting() {
  runCodexTurnImpl = runCodexTurn
}

export function isIncidentAnalysisActive(incidentId: string) {
  return activeIncidentAnalyses.has(incidentId)
}

export function buildIncidentAnalysisEvidence(incident: Incident) {
  return {
    ticket: incident.bundle.ticket,
    trigger: {
      ...incident.trigger,
      message: makeExcerpt(incident.trigger.message, TRIGGER_MESSAGE_LIMIT),
    },
    steps: incident.bundle.steps.map((step) => ({
      stepId: step.stepId,
      status: step.status,
      outputExcerpt: makeExcerpt(step.output, STEP_OUTPUT_LIMIT),
    })),
    verificationRuns: incident.bundle.verificationRuns.slice(-2).map((run) => ({
      attempt: run.attempt,
      status: run.status,
      commands: run.commands.map((command) => ({
        id: command.id,
        label: command.label,
        required: command.required,
        status: command.status,
        exitCode: command.exitCode,
        durationMs: command.durationMs,
        outputExcerpt: makeExcerpt(command.output, VERIFICATION_OUTPUT_LIMIT),
      })),
    })),
    latestReview: incident.bundle.latestReview
      ? {
          attempt: incident.bundle.latestReview.attempt,
          verdict: incident.bundle.latestReview.verdict,
          summary: incident.bundle.latestReview.summary,
          blockingFindings: incident.bundle.latestReview.blockingFindings,
          residualRisks: incident.bundle.latestReview.residualRisks,
          releaseNotes: incident.bundle.latestReview.releaseNotes,
          outputExcerpt: makeExcerpt(incident.bundle.latestReview.output, REVIEW_OUTPUT_LIMIT),
        }
      : undefined,
    stageReviews: incident.bundle.stageReviews.slice(-4).map((review) => ({
      label: review.label,
      attempt: review.attempt,
      verdict: review.verdict,
      summary: review.summary,
      blockingFindings: review.blockingFindings,
      residualRisks: review.residualRisks,
      outputExcerpt: makeExcerpt(review.output, REVIEW_OUTPUT_LIMIT),
    })),
    timeline: incident.bundle.timeline.slice(-10).map((event) => ({
      type: event.type,
      title: event.title,
      stepId: event.stepId,
      attempt: event.attempt,
      status: event.status,
      createdAt: event.createdAt,
      bodyExcerpt: makeExcerpt(event.body, TIMELINE_BODY_LIMIT),
    })),
    worktree: incident.bundle.worktree
      ? {
          branchName: incident.bundle.worktree.branchName,
          baseBranch: incident.bundle.worktree.baseBranch,
          baseCommit: incident.bundle.worktree.baseCommit,
          headCommit: incident.bundle.worktree.headCommit,
          mergeCommit: incident.bundle.worktree.mergeCommit,
          status: incident.bundle.worktree.status,
          createdAt: incident.bundle.worktree.createdAt,
          updatedAt: incident.bundle.worktree.updatedAt,
          diffSummaryExcerpt: makeExcerpt(incident.bundle.worktree.diffSummary, DIFF_SUMMARY_LIMIT),
        }
      : undefined,
  }
}

function buildIncidentAnalysisPrompt(incident: Incident) {
  return [
    buildSkillInvocation(TICKET_INCIDENT_ANALYZE_SKILL),
    '',
    `Incident ID: ${incident.id}`,
    `Project ID: ${incident.projectId}`,
    `Ticket ID: ${incident.sourceId}`,
    `Trigger: ${incident.trigger.kind}`,
    `Failure Message: ${incident.trigger.message}`,
    '',
    'Analyze this ticket incident.',
    'Use the stored bundle as the primary evidence source.',
    'Use repo read tools only if the bundle suggests code/context you need to verify.',
    'Be concrete about likely root cause, evidence, and the shortest next actions.',
    '',
    'Compact incident evidence JSON:',
    JSON.stringify(buildIncidentAnalysisEvidence(incident), null, 2),
  ].join('\n')
}

export async function analyzeIncident(incidentId: string): Promise<Incident> {
  const incident = getIncident(incidentId)
  if (!incident) {
    throw new Error('Incident not found')
  }

  if (activeIncidentAnalyses.has(incidentId)) {
    throw new Error('Incident analysis is already running')
  }

  const config = loadConfig()
  const project = config.projects.find((entry) => entry.id === incident.projectId)
  if (!project) {
    throw new Error(`Unknown project "${incident.projectId}"`)
  }

  activeIncidentAnalyses.add(incidentId)
  setIncidentStatus(incidentId, 'analyzing')

  try {
    const model = getModelCapability(config.flows.explain.model).id
    const reasoningEffort = resolveReasoningEffortForModel(model, config.flows.explain.reasoningEffort)
    const codexConfig = buildRepoReadMcpConfig(project.path)

    const result = await runCodexTurnImpl<IncidentAnalysis>({
      prompt: buildIncidentAnalysisPrompt(incident),
      promptFile: 'prompts/ticket-incident-analyze.txt',
      cwd: project.path,
      additionalDirectories: getProjectSkillDirectories(),
      model,
      reasoningEffort,
      serviceTier: config.flows.explain.serviceTier,
      sandboxMode: 'read-only',
      approvalPolicy: 'never',
      networkAccessEnabled: false,
      codexConfig,
      outputSchema: incidentAnalysisSchema,
    })

    const updated = setIncidentAnalysis(incidentId, result.parsedOutput as IncidentAnalysis)
    if (!updated) {
      throw new Error('Incident not found')
    }

    return updated
  } catch (error: any) {
    setIncidentStatus(incidentId, 'analysis_failed', error?.message || 'Incident analysis failed')
    throw error
  } finally {
    activeIncidentAnalyses.delete(incidentId)
  }
}
