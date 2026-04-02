let envLoaded = false
const SKIP_ENV_FILE_ENV = 'INTENTLANE_CODEX_SKIP_ENV_FILE'

function isTruthyEnv(value: string | undefined) {
  if (!value) {
    return false
  }

  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())
}

export function loadAppEnvFile() {
  if (envLoaded) {
    return
  }

  envLoaded = true

  if (isTruthyEnv(process.env[SKIP_ENV_FILE_ENV])) {
    return
  }

  if (typeof process.loadEnvFile !== 'function') {
    return
  }

  try {
    process.loadEnvFile()
  } catch (error: any) {
    if (error?.code !== 'ENOENT') {
      throw error
    }
  }
}
