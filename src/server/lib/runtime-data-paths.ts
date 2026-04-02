import { resolve } from 'node:path'
import { loadAppEnvFile } from './env.js'

export const RUNTIME_DATA_DIR_ENV = 'INTENTLANE_CODEX_DATA_DIR'

export function resolveRuntimeDataRoot(value = process.env[RUNTIME_DATA_DIR_ENV]) {
  loadAppEnvFile()
  const trimmed = value?.trim()
  return trimmed ? resolve(process.cwd(), trimmed) : process.cwd()
}

export function resolveRuntimeDataPath(...segments: string[]) {
  return resolve(resolveRuntimeDataRoot(), ...segments)
}
