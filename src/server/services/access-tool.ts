import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  createAccessAccount,
  createAccessToken,
  deleteAccessAccount,
  deleteAccessSession,
  deleteAccessToken,
  listAccessSummary,
  revokeAccessSession,
  revokeAccessToken,
  updateAccessAccount,
  type AccessControlSummary,
  type PublicAccessAccount,
  type PublicAccessSession,
  type PublicAccessToken,
} from '../lib/access-control.js'
import { type AccessPermission } from '../lib/access-policy.js'
import { loadConfig } from '../lib/config.js'

export const ACCESS_CONTROL_MCP_SERVER_NAME = 'access_control'
export const LIST_ACCESS_CONTROL_TOOL_NAME = 'list_access_control'
export const CREATE_ACCESS_ACCOUNT_TOOL_NAME = 'create_access_account'
export const UPDATE_ACCESS_ACCOUNT_TOOL_NAME = 'update_access_account'
export const DELETE_ACCESS_ACCOUNT_TOOL_NAME = 'delete_access_account'
export const CREATE_ACCESS_TOKEN_TOOL_NAME = 'create_access_token'
export const REVOKE_ACCESS_TOKEN_TOOL_NAME = 'revoke_access_token'
export const DELETE_ACCESS_TOKEN_TOOL_NAME = 'delete_access_token'
export const REVOKE_ACCESS_SESSION_TOOL_NAME = 'revoke_access_session'
export const DELETE_ACCESS_SESSION_TOOL_NAME = 'delete_access_session'

export interface ToolSafeProjectSummary {
  id: string
  label: string
}

export type ToolSafeAccessToken = PublicAccessToken
export type ToolSafeAccessSession = PublicAccessSession
export type ToolSafeAccessAccount = Omit<PublicAccessAccount, 'hasPassword' | 'passwordUpdatedAt' | 'lastLoginAt'>

export interface ToolSafeAccessControlSummary {
  availableProjects: ToolSafeProjectSummary[]
  accounts: ToolSafeAccessAccount[]
  tokens: ToolSafeAccessToken[]
  sessions: ToolSafeAccessSession[]
}

function isTsRuntime() {
  return Boolean(process.argv[1]?.endsWith('.ts') || process.execArgv.some((arg) => arg.includes('tsx')))
}

function listAvailableProjects(): ToolSafeProjectSummary[] {
  return loadConfig().projects.map(({ id, label }) => ({
    id,
    label,
  }))
}

function assertKnownProjectIds(projectIds: string[] | undefined) {
  if (!projectIds?.length) {
    return
  }

  const knownProjectIds = new Set(listAvailableProjects().map((project) => project.id))
  const invalidProjectId = projectIds.find((projectId) => !knownProjectIds.has(projectId))

  if (invalidProjectId) {
    throw new Error(`Unknown project "${invalidProjectId}"`)
  }
}

function toToolSafeAccessAccount(account: PublicAccessAccount): ToolSafeAccessAccount {
  const { hasPassword, passwordUpdatedAt, lastLoginAt, ...safeAccount } = account
  return safeAccount
}

export function toToolSafeAccessSummary(summary: AccessControlSummary): ToolSafeAccessControlSummary {
  return {
    availableProjects: listAvailableProjects(),
    accounts: summary.accounts.map((account) => toToolSafeAccessAccount(account)),
    tokens: summary.tokens,
    sessions: summary.sessions,
  }
}

function requireToolSafeAccessAccount(accountId: string) {
  const account = listToolAccessSummary().accounts.find((entry) => entry.id === accountId)

  if (!account) {
    throw new Error('Access account not found')
  }

  return account
}

export function listToolAccessSummary(): ToolSafeAccessControlSummary {
  return toToolSafeAccessSummary(listAccessSummary())
}

export function createToolAccessAccount(input: {
  name: string
  description?: string
  isAdmin?: boolean
  permissions?: AccessPermission[]
  projectIds?: string[]
}) {
  assertKnownProjectIds(input.projectIds)
  const account = createAccessAccount(input)
  return requireToolSafeAccessAccount(account.id)
}

export function updateToolAccessAccount(input: {
  accountId: string
  name: string
  description?: string
  disabled?: boolean
  isAdmin?: boolean
  permissions?: AccessPermission[]
  projectIds?: string[]
}) {
  assertKnownProjectIds(input.projectIds)
  const account = updateAccessAccount(input)
  return requireToolSafeAccessAccount(account.id)
}

export function deleteToolAccessAccount(accountId: string) {
  deleteAccessAccount(accountId)
}

export function createToolAccessToken(input: {
  accountId: string
  label: string
  isAdmin?: boolean
  permissions?: AccessPermission[]
  projectIds?: string[]
  expiresAt?: string | null
}) {
  assertKnownProjectIds(input.projectIds)
  return createAccessToken(input)
}

export function revokeToolAccessToken(tokenId: string) {
  return revokeAccessToken(tokenId)
}

export function deleteToolAccessToken(tokenId: string) {
  deleteAccessToken(tokenId)
}

export function revokeToolAccessSession(sessionId: string) {
  return revokeAccessSession(sessionId)
}

export function deleteToolAccessSession(sessionId: string) {
  deleteAccessSession(sessionId)
}

export function buildCreateAccessTokenToolResult(created: {
  token: string
  record: ToolSafeAccessToken
}) {
  return {
    content: [
      {
        type: 'text' as const,
        text: [
          `Created access token "${created.record.label}" for ${created.record.accountName}.`,
          `One-time token secret: ${created.token}`,
        ].join('\n'),
      },
    ],
    structuredContent: {
      ok: true,
      tokenIssued: true,
      record: created.record,
    },
  }
}

export function buildAccessControlMcpConfig() {
  const distScriptPath = resolve(process.cwd(), 'dist/server/mcp/access-control-mcp.js')
  const sourceScriptPath = resolve(process.cwd(), 'src/server/mcp/access-control-mcp.ts')

  if (isTsRuntime() || !existsSync(distScriptPath)) {
    return {
      mcp_servers: {
        [ACCESS_CONTROL_MCP_SERVER_NAME]: {
          command: process.execPath,
          args: ['--import', 'tsx', sourceScriptPath],
        },
      },
    }
  }

  return {
    mcp_servers: {
      [ACCESS_CONTROL_MCP_SERVER_NAME]: {
        command: process.execPath,
        args: [distScriptPath],
      },
    },
  }
}

export function buildAccessControlToolContext(availableProjects: ToolSafeProjectSummary[]) {
  const projectLines = availableProjects.length
    ? availableProjects.map((project) => `- ${project.id}: ${project.label}`).join('\n')
    : '- There are no configured projects.'

  return [
    'Access control tool context:',
    'You may have access to admin-only tools for managing access accounts, scoped API tokens, and active sessions.',
    'These tools intentionally do NOT manage passwords, password resets, or sign-in. If the user asks for password-related help, explain that password operations are unavailable through tools.',
    `Prefer ${LIST_ACCESS_CONTROL_TOOL_NAME} before mutating access state unless the user already gave exact identifiers and the intended scope.`,
    `Use ${CREATE_ACCESS_TOKEN_TOOL_NAME} only when the user explicitly asks to create or rotate a token. A raw token secret is available only at creation time.`,
    'Use exact project ids when granting scoped access. Available project ids:',
    projectLines,
  ].join('\n')
}
