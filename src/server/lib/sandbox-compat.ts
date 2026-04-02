import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import type { SandboxMode } from './config.js'

const SYSTEM_BWRAP_PATH = '/usr/bin/bwrap'

interface SandboxResolutionOptions {
  requestedMode?: SandboxMode
  platform?: NodeJS.Platform
  systemBwrapExists?: boolean
  systemBwrapHelpText?: string | null
}

let cachedSystemBwrapHelpText: string | null | undefined

export function supportsBwrapArgv0(helpText: string | null | undefined) {
  return Boolean(helpText?.includes('--argv0'))
}

export function resolveCompatibleSandboxMode({
  requestedMode = 'read-only',
  platform = process.platform,
  systemBwrapExists = existsSync(SYSTEM_BWRAP_PATH),
  systemBwrapHelpText = null,
}: SandboxResolutionOptions = {}): SandboxMode {
  if (requestedMode === 'danger-full-access' || platform !== 'linux') {
    return requestedMode
  }

  if (!systemBwrapExists) {
    return requestedMode
  }

  return supportsBwrapArgv0(systemBwrapHelpText) ? requestedMode : 'danger-full-access'
}

function readSystemBwrapHelpText() {
  if (cachedSystemBwrapHelpText !== undefined) {
    return cachedSystemBwrapHelpText
  }

  if (!existsSync(SYSTEM_BWRAP_PATH)) {
    cachedSystemBwrapHelpText = null
    return cachedSystemBwrapHelpText
  }

  const result = spawnSync(SYSTEM_BWRAP_PATH, ['--help'], {
    encoding: 'utf8',
  })

  cachedSystemBwrapHelpText = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim() || null
  return cachedSystemBwrapHelpText
}

export function detectCompatibleSandboxMode(requestedMode: SandboxMode = 'read-only') {
  return resolveCompatibleSandboxMode({
    requestedMode,
    systemBwrapHelpText: readSystemBwrapHelpText(),
  })
}
