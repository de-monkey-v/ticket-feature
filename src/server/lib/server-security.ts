const ALLOWED_ORIGINS_ENV = 'APP_ALLOWED_ORIGINS'
const ALLOW_OPEN_ACCESS_ENV = 'INTENTLANE_CODEX_ALLOW_OPEN_ACCESS'
const DEFAULT_API_HOSTNAME = '0.0.0.0'
const DEFAULT_DEV_CORS_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173']

function isTruthyEnv(value: string | undefined) {
  if (!value) {
    return false
  }

  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())
}

function normalizeOrigin(value: string) {
  const trimmed = value.trim()
  if (!trimmed || trimmed === 'null') {
    return null
  }

  if (trimmed === '*') {
    throw new Error(`${ALLOWED_ORIGINS_ENV} cannot include "*". List explicit origins instead.`)
  }

  try {
    return new URL(trimmed).origin
  } catch {
    throw new Error(`${ALLOWED_ORIGINS_ENV} contains an invalid origin: ${trimmed}`)
  }
}

export function resolveApiHostname(value = process.env.HOST) {
  return value?.trim() || DEFAULT_API_HOSTNAME
}

export function isOpenAccessOverrideEnabled(value = process.env[ALLOW_OPEN_ACCESS_ENV]) {
  return isTruthyEnv(value)
}

export function listAllowedApiCorsOrigins(value = process.env[ALLOWED_ORIGINS_ENV]) {
  const configuredOrigins = (value ?? '')
    .split(/[,\n]/)
    .flatMap((entry) => {
      const normalized = normalizeOrigin(entry)
      return normalized ? [normalized] : []
    })

  return Array.from(new Set([...DEFAULT_DEV_CORS_ORIGINS, ...configuredOrigins]))
}

export function buildApiCorsOptions(value = process.env[ALLOWED_ORIGINS_ENV]) {
  const allowedOrigins = new Set(listAllowedApiCorsOrigins(value))

  return {
    origin(origin: string) {
      const normalizedOrigin = normalizeOrigin(origin)
      return normalizedOrigin && allowedOrigins.has(normalizedOrigin) ? normalizedOrigin : null
    },
  }
}

export function assertApiAuthenticationConfigured(options: {
  apiAuthEnabled: boolean
  allowOpenAccess?: boolean
}) {
  if (options.apiAuthEnabled || options.allowOpenAccess) {
    return
  }

  throw new Error(
    'API authentication is not configured. Set APP_SHARED_TOKEN, bootstrap a root password, or use INTENTLANE_CODEX_ALLOW_OPEN_ACCESS=1 only for local development.'
  )
}
