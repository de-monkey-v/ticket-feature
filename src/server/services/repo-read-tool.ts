import { execFile } from 'node:child_process'
import { existsSync, promises as fs } from 'node:fs'
import { promisify } from 'node:util'
import { resolve, relative, sep } from 'node:path'

const execFileAsync = promisify(execFile)

export const REPO_READ_MCP_SERVER_NAME = 'repo_read'
export const SEARCH_REPOSITORY_TOOL_NAME = 'search_repository'
export const READ_REPOSITORY_FILE_TOOL_NAME = 'read_repository_file'
export const LIST_REPOSITORY_FILES_TOOL_NAME = 'list_repository_files'

const DEFAULT_MAX_RESULTS = 30
const MAX_RESULTS_LIMIT = 200
const DEFAULT_LINE_WINDOW = 160
const MAX_LINE_WINDOW = 400
const MAX_FILE_BYTES = 200_000
const RG_MAX_BUFFER = 10 * 1024 * 1024

export interface RepositorySearchMatch {
  path: string
  line: number
  text: string
}

export interface RepositoryFileReadResult {
  path: string
  startLine: number
  endLine: number
  totalLines: number
  excerpt: string
}

function normalizeRelativePath(value: string) {
  return value
    .split(sep)
    .join('/')
    .replace(/^\.\//, '')
}

export function resolveRepositoryRoot(rootPath: string) {
  const normalizedRoot = resolve(rootPath.trim())

  if (!rootPath.trim()) {
    throw new Error('Repository root is required')
  }

  if (!existsSync(normalizedRoot)) {
    throw new Error('Repository root does not exist')
  }

  return normalizedRoot
}

function ensurePathWithinRoot(rootPath: string, filePath: string) {
  const trimmedPath = filePath.trim()
  if (!trimmedPath) {
    throw new Error('File path is required')
  }

  const absolutePath = resolve(rootPath, trimmedPath)
  const relativePath = relative(rootPath, absolutePath)

  if (!relativePath || relativePath === '') {
    throw new Error('File path must point to a file inside the repository')
  }

  if (relativePath.startsWith('..') || relativePath.includes(`..${sep}`)) {
    throw new Error('File path must stay inside the repository root')
  }

  return {
    absolutePath,
    relativePath: normalizeRelativePath(relativePath),
  }
}

function clampMaxResults(maxResults?: number) {
  if (!maxResults || Number.isNaN(maxResults)) {
    return DEFAULT_MAX_RESULTS
  }

  return Math.max(1, Math.min(MAX_RESULTS_LIMIT, Math.trunc(maxResults)))
}

function resolveLineRange(startLine?: number, endLine?: number) {
  const normalizedStartLine = Math.max(1, Math.trunc(startLine ?? 1))
  const requestedEndLine = Math.trunc(endLine ?? normalizedStartLine + DEFAULT_LINE_WINDOW - 1)
  const normalizedEndLine = Math.max(normalizedStartLine, requestedEndLine)

  if (normalizedEndLine - normalizedStartLine + 1 > MAX_LINE_WINDOW) {
    throw new Error(`You can read at most ${MAX_LINE_WINDOW} lines at once`)
  }

  return {
    startLine: normalizedStartLine,
    endLine: normalizedEndLine,
  }
}

function isBinaryContent(content: string) {
  return content.includes('\u0000')
}

export async function readRepositoryFile(
  rootPath: string,
  filePath: string,
  startLine?: number,
  endLine?: number
): Promise<RepositoryFileReadResult> {
  const root = resolveRepositoryRoot(rootPath)
  const { absolutePath, relativePath } = ensurePathWithinRoot(root, filePath)
  const range = resolveLineRange(startLine, endLine)
  const stat = await fs.stat(absolutePath).catch(() => null)

  if (!stat) {
    throw new Error('Requested file was not found')
  }

  if (!stat.isFile()) {
    throw new Error('Requested path is not a file')
  }

  if (stat.size > MAX_FILE_BYTES) {
    throw new Error(`Requested file is too large to read safely (${stat.size} bytes)`)
  }

  const content = await fs.readFile(absolutePath, 'utf8')
  if (isBinaryContent(content)) {
    throw new Error('Binary files are not supported')
  }

  const lines = content.replace(/\r\n/g, '\n').split('\n')
  const slice = lines.slice(range.startLine - 1, range.endLine)
  const excerpt = slice
    .map((line, index) => `${range.startLine + index}`.padStart(4, ' ') + ` | ${line}`)
    .join('\n')

  return {
    path: relativePath,
    startLine: range.startLine,
    endLine: Math.min(range.endLine, lines.length),
    totalLines: lines.length,
    excerpt,
  }
}

async function runRg(rootPath: string, args: string[]) {
  try {
    return await execFileAsync('rg', args, {
      cwd: rootPath,
      encoding: 'utf8',
      maxBuffer: RG_MAX_BUFFER,
    })
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      throw new Error('ripgrep (rg) is required on the server host')
    }

    if (error?.code === 1) {
      return {
        stdout: error.stdout ?? '',
        stderr: error.stderr ?? '',
      }
    }

    throw new Error(error?.stderr?.trim() || error?.message || 'Repository search failed')
  }
}

export async function searchRepository(
  rootPath: string,
  query: string,
  options?: {
    glob?: string
    caseSensitive?: boolean
    maxResults?: number
  }
): Promise<RepositorySearchMatch[]> {
  const root = resolveRepositoryRoot(rootPath)
  const normalizedQuery = query.trim()

  if (!normalizedQuery) {
    throw new Error('Search query is required')
  }

  const maxResults = clampMaxResults(options?.maxResults)
  const args = ['--json', '--hidden', '--line-number', '--fixed-strings']

  if (options?.caseSensitive) {
    args.push('--case-sensitive')
  } else {
    args.push('--smart-case')
  }

  if (options?.glob?.trim()) {
    args.push('-g', options.glob.trim())
  }

  args.push(normalizedQuery, '.')

  const { stdout } = await runRg(root, args)
  const matches: RepositorySearchMatch[] = []

  for (const line of stdout.split('\n')) {
    if (!line.trim()) {
      continue
    }

    let event: any
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }

    if (event.type !== 'match') {
      continue
    }

    matches.push({
      path: normalizeRelativePath(event.data.path.text),
      line: event.data.line_number,
      text: String(event.data.lines.text ?? '').trimEnd(),
    })

    if (matches.length >= maxResults) {
      break
    }
  }

  return matches
}

export async function listRepositoryFiles(
  rootPath: string,
  options?: {
    glob?: string
    maxResults?: number
  }
): Promise<string[]> {
  const root = resolveRepositoryRoot(rootPath)
  const maxResults = clampMaxResults(options?.maxResults)
  const args = ['--files', '--hidden']

  if (options?.glob?.trim()) {
    args.push('-g', options.glob.trim())
  }

  const { stdout } = await runRg(root, args)
  return stdout
    .split('\n')
    .map((line: string) => line.trim())
    .filter(Boolean)
    .slice(0, maxResults)
    .map(normalizeRelativePath)
}

function isTsRuntime() {
  return Boolean(process.argv[1]?.endsWith('.ts') || process.execArgv.some((arg) => arg.includes('tsx')))
}

export function buildRepoReadMcpConfig(projectPath: string) {
  const distScriptPath = resolve(process.cwd(), 'dist/server/mcp/repo-read-mcp.js')
  const sourceScriptPath = resolve(process.cwd(), 'src/server/mcp/repo-read-mcp.ts')
  const root = resolve(projectPath)

  if (isTsRuntime() || !existsSync(distScriptPath)) {
    return {
      mcp_servers: {
        [REPO_READ_MCP_SERVER_NAME]: {
          command: process.execPath,
          args: ['--import', 'tsx', sourceScriptPath, '--root', root],
        },
      },
    }
  }

  return {
    mcp_servers: {
      [REPO_READ_MCP_SERVER_NAME]: {
        command: process.execPath,
        args: [distScriptPath, '--root', root],
      },
    },
  }
}
