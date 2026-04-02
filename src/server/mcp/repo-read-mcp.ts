import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import * as z from 'zod/v4'
import {
  LIST_REPOSITORY_FILES_TOOL_NAME,
  READ_REPOSITORY_FILE_TOOL_NAME,
  SEARCH_REPOSITORY_TOOL_NAME,
  listRepositoryFiles,
  readRepositoryFile,
  resolveRepositoryRoot,
  searchRepository,
} from '../services/repo-read-tool.js'

function readRootArg() {
  const rootFlagIndex = process.argv.findIndex((value) => value === '--root')
  const rootValue = rootFlagIndex >= 0 ? process.argv[rootFlagIndex + 1] : undefined

  if (!rootValue?.trim()) {
    throw new Error('Missing required --root argument for repo read MCP server')
  }

  return resolveRepositoryRoot(rootValue)
}

function buildErrorResult(error: unknown) {
  const message = error instanceof Error ? error.message : 'Unknown repository tool failure'
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

const repositoryRoot = readRootArg()
const server = new McpServer({
  name: 'intentlane-codex-repo-read',
  version: '1.0.0',
})

server.registerTool(
  SEARCH_REPOSITORY_TOOL_NAME,
  {
    title: 'Search Repository',
    description: 'Search repository text safely in read-only mode. Prefer this before shell commands for code lookup.',
    inputSchema: {
      query: z.string().describe('Plain text to search for in the repository'),
      glob: z.string().optional().describe('Optional ripgrep glob such as src/**/*.ts'),
      caseSensitive: z.boolean().optional().describe('Whether the search should be case sensitive'),
      maxResults: z.number().int().min(1).max(200).optional().describe('Maximum number of matches to return'),
    },
    outputSchema: {
      ok: z.boolean(),
      query: z.string().optional(),
      matches: z
        .array(
          z.object({
            path: z.string(),
            line: z.number(),
            text: z.string(),
          })
        )
        .optional(),
      error: z.string().optional(),
    },
  },
  async ({ query, glob, caseSensitive, maxResults }) => {
    try {
      const matches = await searchRepository(repositoryRoot, query, {
        glob,
        caseSensitive,
        maxResults,
      })

      return {
        content: [
          {
            type: 'text',
            text:
              matches.length === 0
                ? 'No matches found.'
                : matches.map((match) => `${match.path}:${match.line}: ${match.text}`).join('\n'),
          },
        ],
        structuredContent: {
          ok: true,
          query,
          matches,
        },
      }
    } catch (error) {
      return buildErrorResult(error)
    }
  }
)

server.registerTool(
  READ_REPOSITORY_FILE_TOOL_NAME,
  {
    title: 'Read Repository File',
    description: 'Read a repository file safely with line numbers. Paths must stay inside the repository root.',
    inputSchema: {
      path: z.string().describe('Repository-relative file path'),
      startLine: z.number().int().min(1).optional().describe('1-based starting line number'),
      endLine: z.number().int().min(1).optional().describe('1-based ending line number'),
    },
    outputSchema: {
      ok: z.boolean(),
      path: z.string().optional(),
      startLine: z.number().optional(),
      endLine: z.number().optional(),
      totalLines: z.number().optional(),
      excerpt: z.string().optional(),
      error: z.string().optional(),
    },
  },
  async ({ path, startLine, endLine }) => {
    try {
      const result = await readRepositoryFile(repositoryRoot, path, startLine, endLine)
      return {
        content: [
          {
            type: 'text',
            text: `${result.path} (${result.startLine}-${result.endLine}/${result.totalLines})\n\n${result.excerpt}`,
          },
        ],
        structuredContent: {
          ok: true,
          ...result,
        },
      }
    } catch (error) {
      return buildErrorResult(error)
    }
  }
)

server.registerTool(
  LIST_REPOSITORY_FILES_TOOL_NAME,
  {
    title: 'List Repository Files',
    description: 'List repository files safely in read-only mode. Useful for locating controllers, services, tests, and templates.',
    inputSchema: {
      glob: z.string().optional().describe('Optional ripgrep glob such as src/**/*.tsx'),
      maxResults: z.number().int().min(1).max(200).optional().describe('Maximum number of files to return'),
    },
    outputSchema: {
      ok: z.boolean(),
      files: z.array(z.string()).optional(),
      error: z.string().optional(),
    },
  },
  async ({ glob, maxResults }) => {
    try {
      const files = await listRepositoryFiles(repositoryRoot, {
        glob,
        maxResults,
      })

      return {
        content: [
          {
            type: 'text',
            text: files.length === 0 ? 'No files found.' : files.join('\n'),
          },
        ],
        structuredContent: {
          ok: true,
          files,
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
  console.error('Repo read MCP server failed:', error)
  process.exit(1)
})
