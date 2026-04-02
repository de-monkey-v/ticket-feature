import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import * as z from 'zod/v4'
import {
  normalizeRequestDraftPayload,
  REQUEST_DRAFT_TOOL_NAME,
  type RequestDraftPayload,
} from '../services/request-draft-tool.js'

const server = new McpServer({
  name: 'intentlane-codex-request-intake',
  version: '1.0.0',
})

server.registerTool(
  REQUEST_DRAFT_TOOL_NAME,
  {
    title: 'Create Client Request Draft',
    description:
      'Create a structured client request draft from the current conversation. Use only when the user explicitly asks to register or save a request.',
    inputSchema: {
      title: z.string().describe('Short request title'),
      categoryId: z.string().describe('One of the allowed ticket category ids'),
      template: z.object({
        problem: z.string().describe('User-facing problem or background'),
        desiredOutcome: z.string().describe('What the user wants to achieve'),
        userScenarios: z.string().describe('Representative user scenarios or examples'),
        constraints: z.string().optional().describe('Optional user or business constraints'),
        nonGoals: z.string().optional().describe('Optional out-of-scope notes'),
        openQuestions: z.string().optional().describe('Optional unresolved user-facing questions'),
      }),
      rationale: z.string().optional().describe('Optional note explaining the categorization'),
    },
    outputSchema: {
      title: z.string(),
      categoryId: z.string(),
      template: z.object({
        problem: z.string(),
        desiredOutcome: z.string(),
        userScenarios: z.string(),
        constraints: z.string().optional(),
        nonGoals: z.string().optional(),
        openQuestions: z.string().optional(),
      }),
      rationale: z.string().optional(),
    },
  },
  async (payload: RequestDraftPayload) => {
    const draft = normalizeRequestDraftPayload(payload)
      const structuredContent: Record<string, unknown> = {
        title: draft.title,
        categoryId: draft.categoryId,
        template: draft.template,
        ...(draft.rationale ? { rationale: draft.rationale } : {}),
      }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(draft, null, 2),
        },
      ],
      structuredContent,
    }
  }
)

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch((error) => {
  console.error('Request intake MCP server failed:', error)
  process.exit(1)
})
