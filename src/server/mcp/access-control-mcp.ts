import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import * as z from 'zod/v4'
import { ACCESS_PERMISSION_IDS } from '../lib/access-policy.js'
import {
  ACCESS_CONTROL_MCP_SERVER_NAME,
  CREATE_ACCESS_ACCOUNT_TOOL_NAME,
  CREATE_ACCESS_TOKEN_TOOL_NAME,
  DELETE_ACCESS_ACCOUNT_TOOL_NAME,
  DELETE_ACCESS_SESSION_TOOL_NAME,
  DELETE_ACCESS_TOKEN_TOOL_NAME,
  LIST_ACCESS_CONTROL_TOOL_NAME,
  REVOKE_ACCESS_SESSION_TOOL_NAME,
  REVOKE_ACCESS_TOKEN_TOOL_NAME,
  UPDATE_ACCESS_ACCOUNT_TOOL_NAME,
  buildCreateAccessTokenToolResult,
  createToolAccessAccount,
  createToolAccessToken,
  deleteToolAccessAccount,
  deleteToolAccessSession,
  deleteToolAccessToken,
  listToolAccessSummary,
  revokeToolAccessSession,
  revokeToolAccessToken,
  updateToolAccessAccount,
} from '../services/access-tool.js'

const accessPermissionSchema = z.enum(ACCESS_PERMISSION_IDS)
const projectSchema = z.object({
  id: z.string(),
  label: z.string(),
})
const accessTokenSchema = z.object({
  id: z.string(),
  accountId: z.string(),
  accountName: z.string(),
  label: z.string(),
  isAdmin: z.boolean(),
  permissions: z.array(accessPermissionSchema),
  projectIds: z.array(z.string()),
  expiresAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  revokedAt: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
  tokenPreview: z.string(),
  status: z.enum(['active', 'expired', 'revoked', 'disabled']),
})
const accessSessionSchema = z.object({
  id: z.string(),
  accountId: z.string(),
  accountName: z.string(),
  label: z.string(),
  expiresAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  revokedAt: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
  tokenPreview: z.string(),
  status: z.enum(['active', 'expired', 'revoked', 'disabled']),
})
const accessAccountSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  disabled: z.boolean(),
  isAdmin: z.boolean(),
  permissions: z.array(accessPermissionSchema),
  projectIds: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
  tokens: z.array(accessTokenSchema),
  sessions: z.array(accessSessionSchema),
})
const accessSummarySchema = z.object({
  availableProjects: z.array(projectSchema),
  accounts: z.array(accessAccountSchema),
  tokens: z.array(accessTokenSchema),
  sessions: z.array(accessSessionSchema),
})

function buildErrorResult(error: unknown) {
  const message = error instanceof Error ? error.message : 'Unknown access control tool failure'

  return {
    content: [
      {
        type: 'text' as const,
        text: message,
      },
    ],
    structuredContent: {
      ok: false,
      error: message,
    },
  }
}

function asJsonText(value: unknown) {
  return JSON.stringify(value, null, 2)
}

const server = new McpServer({
  name: 'intentlane-codex-access-control',
  version: '1.0.0',
})

server.registerTool(
  LIST_ACCESS_CONTROL_TOOL_NAME,
  {
    title: 'List Access Control',
    description:
      'List access accounts, scoped API tokens, and active sessions. Password and login operations are intentionally excluded.',
    inputSchema: {},
    outputSchema: {
      ok: z.boolean(),
      summary: accessSummarySchema.optional(),
      error: z.string().optional(),
    },
  },
  async () => {
    try {
      const summary = listToolAccessSummary()
      return {
        content: [
          {
            type: 'text',
            text: asJsonText(summary),
          },
        ],
        structuredContent: {
          ok: true,
          summary,
        },
      }
    } catch (error) {
      return buildErrorResult(error)
    }
  }
)

server.registerTool(
  CREATE_ACCESS_ACCOUNT_TOOL_NAME,
  {
    title: 'Create Access Account',
    description: 'Create an access account with scoped permissions and project access. Password setup is intentionally unavailable here.',
    inputSchema: {
      name: z.string().describe('Unique account name'),
      description: z.string().optional().describe('Optional human-readable description'),
      isAdmin: z.boolean().optional().describe('Whether the account should have admin access'),
      permissions: z
        .array(accessPermissionSchema)
        .optional()
        .describe('Scoped permissions when isAdmin is false'),
      projectIds: z.array(z.string()).optional().describe('Scoped project ids when isAdmin is false'),
    },
    outputSchema: {
      ok: z.boolean(),
      account: accessAccountSchema.optional(),
      error: z.string().optional(),
    },
  },
  async ({ name, description, isAdmin, permissions, projectIds }) => {
    try {
      const account = createToolAccessAccount({
        name,
        description,
        isAdmin,
        permissions,
        projectIds,
      })

      return {
        content: [
          {
            type: 'text',
            text: asJsonText(account),
          },
        ],
        structuredContent: {
          ok: true,
          account,
        },
      }
    } catch (error) {
      return buildErrorResult(error)
    }
  }
)

server.registerTool(
  UPDATE_ACCESS_ACCOUNT_TOOL_NAME,
  {
    title: 'Update Access Account',
    description: 'Update account scope, disabled state, and metadata. Password setup is intentionally unavailable here.',
    inputSchema: {
      accountId: z.string().describe('Existing access account id'),
      name: z.string().describe('Updated unique account name'),
      description: z.string().optional().describe('Optional human-readable description'),
      disabled: z.boolean().optional().describe('Whether the account should be disabled'),
      isAdmin: z.boolean().optional().describe('Whether the account should have admin access'),
      permissions: z
        .array(accessPermissionSchema)
        .optional()
        .describe('Scoped permissions when isAdmin is false'),
      projectIds: z.array(z.string()).optional().describe('Scoped project ids when isAdmin is false'),
    },
    outputSchema: {
      ok: z.boolean(),
      account: accessAccountSchema.optional(),
      error: z.string().optional(),
    },
  },
  async ({ accountId, name, description, disabled, isAdmin, permissions, projectIds }) => {
    try {
      const account = updateToolAccessAccount({
        accountId,
        name,
        description,
        disabled,
        isAdmin,
        permissions,
        projectIds,
      })

      return {
        content: [
          {
            type: 'text',
            text: asJsonText(account),
          },
        ],
        structuredContent: {
          ok: true,
          account,
        },
      }
    } catch (error) {
      return buildErrorResult(error)
    }
  }
)

server.registerTool(
  DELETE_ACCESS_ACCOUNT_TOOL_NAME,
  {
    title: 'Delete Access Account',
    description: 'Delete an access account after all of its tokens and sessions are removed.',
    inputSchema: {
      accountId: z.string().describe('Existing access account id'),
    },
    outputSchema: {
      ok: z.boolean(),
      deletedAccountId: z.string().optional(),
      error: z.string().optional(),
    },
  },
  async ({ accountId }) => {
    try {
      deleteToolAccessAccount(accountId)
      return {
        content: [
          {
            type: 'text',
            text: `Deleted access account ${accountId}.`,
          },
        ],
        structuredContent: {
          ok: true,
          deletedAccountId: accountId,
        },
      }
    } catch (error) {
      return buildErrorResult(error)
    }
  }
)

server.registerTool(
  CREATE_ACCESS_TOKEN_TOOL_NAME,
  {
    title: 'Create Access Token',
    description:
      'Create a scoped API token for an existing account. The raw token secret is returned only in text content, not structured output.',
    inputSchema: {
      accountId: z.string().describe('Existing access account id'),
      label: z.string().describe('Human-readable token label'),
      isAdmin: z.boolean().optional().describe('Whether the token should have admin access'),
      permissions: z
        .array(accessPermissionSchema)
        .optional()
        .describe('Scoped permissions when isAdmin is false'),
      projectIds: z.array(z.string()).optional().describe('Scoped project ids when isAdmin is false'),
      expiresAt: z.string().nullable().optional().describe('Optional ISO datetime expiration'),
    },
    outputSchema: {
      ok: z.boolean(),
      tokenIssued: z.boolean().optional(),
      record: accessTokenSchema.optional(),
      error: z.string().optional(),
    },
  },
  async ({ accountId, label, isAdmin, permissions, projectIds, expiresAt }) => {
    try {
      return buildCreateAccessTokenToolResult(
        createToolAccessToken({
          accountId,
          label,
          isAdmin,
          permissions,
          projectIds,
          expiresAt,
        })
      )
    } catch (error) {
      return buildErrorResult(error)
    }
  }
)

server.registerTool(
  REVOKE_ACCESS_TOKEN_TOOL_NAME,
  {
    title: 'Revoke Access Token',
    description: 'Revoke an existing API token without deleting its record.',
    inputSchema: {
      tokenId: z.string().describe('Existing access token id'),
    },
    outputSchema: {
      ok: z.boolean(),
      token: accessTokenSchema.optional(),
      error: z.string().optional(),
    },
  },
  async ({ tokenId }) => {
    try {
      const token = revokeToolAccessToken(tokenId)
      return {
        content: [
          {
            type: 'text',
            text: asJsonText(token),
          },
        ],
        structuredContent: {
          ok: true,
          token,
        },
      }
    } catch (error) {
      return buildErrorResult(error)
    }
  }
)

server.registerTool(
  DELETE_ACCESS_TOKEN_TOOL_NAME,
  {
    title: 'Delete Access Token',
    description: 'Delete an access token record permanently.',
    inputSchema: {
      tokenId: z.string().describe('Existing access token id'),
    },
    outputSchema: {
      ok: z.boolean(),
      deletedTokenId: z.string().optional(),
      error: z.string().optional(),
    },
  },
  async ({ tokenId }) => {
    try {
      deleteToolAccessToken(tokenId)
      return {
        content: [
          {
            type: 'text',
            text: `Deleted access token ${tokenId}.`,
          },
        ],
        structuredContent: {
          ok: true,
          deletedTokenId: tokenId,
        },
      }
    } catch (error) {
      return buildErrorResult(error)
    }
  }
)

server.registerTool(
  REVOKE_ACCESS_SESSION_TOOL_NAME,
  {
    title: 'Revoke Access Session',
    description: 'Revoke an active access session without deleting its record.',
    inputSchema: {
      sessionId: z.string().describe('Existing access session id'),
    },
    outputSchema: {
      ok: z.boolean(),
      session: accessSessionSchema.optional(),
      error: z.string().optional(),
    },
  },
  async ({ sessionId }) => {
    try {
      const session = revokeToolAccessSession(sessionId)
      return {
        content: [
          {
            type: 'text',
            text: asJsonText(session),
          },
        ],
        structuredContent: {
          ok: true,
          session,
        },
      }
    } catch (error) {
      return buildErrorResult(error)
    }
  }
)

server.registerTool(
  DELETE_ACCESS_SESSION_TOOL_NAME,
  {
    title: 'Delete Access Session',
    description: 'Delete an access session record permanently.',
    inputSchema: {
      sessionId: z.string().describe('Existing access session id'),
    },
    outputSchema: {
      ok: z.boolean(),
      deletedSessionId: z.string().optional(),
      error: z.string().optional(),
    },
  },
  async ({ sessionId }) => {
    try {
      deleteToolAccessSession(sessionId)
      return {
        content: [
          {
            type: 'text',
            text: `Deleted access session ${sessionId}.`,
          },
        ],
        structuredContent: {
          ok: true,
          deletedSessionId: sessionId,
        },
      }
    } catch (error) {
      return buildErrorResult(error)
    }
  }
)

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch((error) => {
  console.error(`${ACCESS_CONTROL_MCP_SERVER_NAME} MCP server failed:`, error)
  process.exit(1)
})
