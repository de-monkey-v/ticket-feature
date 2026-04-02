import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { VerificationCommandConfig } from './config.js'

interface PackageJsonLike {
  packageManager?: unknown
  scripts?: unknown
}

type ScriptRunner = 'pnpm' | 'npm' | 'yarn'

function hasFile(projectPath: string, filename: string) {
  return existsSync(resolve(projectPath, filename))
}

function readPackageJson(projectPath: string): PackageJsonLike | null {
  const packageJsonPath = resolve(projectPath, 'package.json')
  if (!existsSync(packageJsonPath)) {
    return null
  }

  try {
    return JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as PackageJsonLike
  } catch {
    throw new Error('프로젝트의 package.json을 읽을 수 없습니다.')
  }
}

function inferScriptRunner(projectPath: string, packageManager: string | undefined): ScriptRunner {
  const normalizedPackageManager = packageManager?.trim().toLowerCase() ?? ''

  if (normalizedPackageManager.startsWith('pnpm@') || hasFile(projectPath, 'pnpm-lock.yaml')) {
    return 'pnpm'
  }

  if (normalizedPackageManager.startsWith('yarn@') || hasFile(projectPath, 'yarn.lock')) {
    return 'yarn'
  }

  return 'npm'
}

function buildScriptCommand(runner: ScriptRunner, scriptName: string) {
  if (runner === 'npm') {
    return `npm run ${scriptName}`
  }

  return `${runner} ${scriptName}`
}

function hasGradleProjectFiles(projectPath: string) {
  return (
    hasFile(projectPath, 'build.gradle') ||
    hasFile(projectPath, 'build.gradle.kts') ||
    hasFile(projectPath, 'settings.gradle') ||
    hasFile(projectPath, 'settings.gradle.kts')
  )
}

function normalizeGradleWrapperCommand(command: string) {
  const trimmed = command.trim()
  if (!trimmed) {
    return trimmed
  }

  if (/^sh\s+\.\/gradlew(?:\s|$)/.test(trimmed)) {
    return trimmed
  }

  if (/^\.\/gradlew(?:\s|$)/.test(trimmed)) {
    return `sh ${trimmed}`
  }

  return trimmed
}

export function normalizeVerificationCommandsForProject(
  projectPath: string,
  commands: VerificationCommandConfig[]
): VerificationCommandConfig[] {
  const normalizedProjectPath = resolve(projectPath)
  const isGradleProject = hasGradleProjectFiles(normalizedProjectPath)

  return commands.map((command) => ({
    ...command,
    command: isGradleProject ? normalizeGradleWrapperCommand(command.command) : command.command.trim(),
  }))
}

function inferGradleVerificationCommands(projectPath: string): VerificationCommandConfig[] | null {
  const hasGradleProject = hasGradleProjectFiles(projectPath)

  if (!hasGradleProject) {
    return null
  }

  const runner = hasFile(projectPath, 'gradlew') ? 'sh ./gradlew' : 'gradle'

  return [
    {
      id: 'test',
      label: 'Test',
      command: `${runner} test`,
      timeoutMs: 300000,
      required: true,
    },
    {
      id: 'build',
      label: 'Build',
      command: `${runner} build`,
      timeoutMs: 300000,
      required: true,
    },
  ]
}

function inferNodeVerificationCommands(projectPath: string): VerificationCommandConfig[] | null {
  const packageJson = readPackageJson(projectPath)
  if (!packageJson) {
    return null
  }

  const scripts =
    packageJson.scripts && typeof packageJson.scripts === 'object' && !Array.isArray(packageJson.scripts)
      ? (packageJson.scripts as Record<string, unknown>)
      : ({} as Record<string, unknown>)
  const runner = inferScriptRunner(
    projectPath,
    typeof packageJson.packageManager === 'string' ? packageJson.packageManager : undefined
  )
  const commands: VerificationCommandConfig[] = []

  if (typeof scripts.typecheck === 'string' && scripts.typecheck.trim()) {
    commands.push({
      id: 'typecheck',
      label: 'Typecheck',
      command: buildScriptCommand(runner, 'typecheck'),
      timeoutMs: 120000,
      required: true,
    })
  }

  if (typeof scripts.test === 'string' && scripts.test.trim()) {
    commands.push({
      id: 'test',
      label: 'Test',
      command: buildScriptCommand(runner, 'test'),
      timeoutMs: 120000,
      required: true,
    })
  }

  if (typeof scripts.build === 'string' && scripts.build.trim()) {
    commands.push({
      id: 'build',
      label: 'Build',
      command: buildScriptCommand(runner, 'build'),
      timeoutMs: 180000,
      required: true,
    })
  }

  return commands.length > 0 ? commands : null
}

export function inferVerificationCommandsForProject(projectPath: string): VerificationCommandConfig[] {
  const normalizedPath = resolve(projectPath)

  return (
    inferGradleVerificationCommands(normalizedPath) ??
    inferNodeVerificationCommands(normalizedPath) ??
    (() => {
      throw new Error('프로젝트의 자동 검증 명령을 추론할 수 없습니다. Gradle 또는 package.json 기반 프로젝트만 지원합니다.')
    })()
  )
}
