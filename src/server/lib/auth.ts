import type { Context, MiddlewareHandler } from 'hono'
import {
  authenticateAccessToken,
  authenticateAccountSession,
  hasManagedAccessTokens,
  hasManagedAccountLogins,
} from './access-control.js'
import {
  createOpenAuthSession,
  hasPermission,
  hasProjectAccess,
  allAccessPermissions,
  type AccessPermission,
  type AuthSession,
} from './access-policy.js'

const SHARED_TOKEN_ENV = 'APP_SHARED_TOKEN'
const AUTH_CONTEXT_KEY = 'auth'

function getSharedToken() {
  return process.env[SHARED_TOKEN_ENV]?.trim() || ''
}

function parseBearerToken(header: string | undefined) {
  if (!header) {
    return null
  }

  const match = header.match(/^Bearer\s+(.+)$/i)
  return match?.[1]?.trim() || null
}

export function isSharedBearerAuthEnabled(): boolean {
  return Boolean(getSharedToken())
}

export function isApiAuthEnabled(): boolean {
  return isSharedBearerAuthEnabled() || hasManagedAccessTokens() || hasManagedAccountLogins()
}

function createSharedAdminSession(): AuthSession {
  return {
    kind: 'shared_admin',
    label: 'Shared admin',
    isAdmin: true,
    permissions: allAccessPermissions(),
    projectIds: null,
    mustChangePassword: false,
  }
}

function isPasswordChangeExemptPath(path: string) {
  return (
    path === '/api/health' ||
    path === '/api/config' ||
    path === '/api/access/login' ||
    path === '/api/access/logout' ||
    path === '/api/access/me/password'
  )
}

function authenticateBearerToken(token: string | null): AuthSession | null {
  if (!token) {
    return null
  }

  const sharedToken = getSharedToken()
  if (sharedToken && token === sharedToken) {
    return createSharedAdminSession()
  }

  return authenticateAccessToken(token) ?? authenticateAccountSession(token)
}

export function setAuthSession(c: Context, session: AuthSession) {
  c.set(AUTH_CONTEXT_KEY, session)
}

export function getAuthSession(c: Context): AuthSession {
  const session = c.get(AUTH_CONTEXT_KEY) as AuthSession | undefined
  return session ?? createOpenAuthSession()
}

export function requireSharedBearerAuth(): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.path === '/api/health' || c.req.path === '/api/access/login') {
      setAuthSession(c, createOpenAuthSession())
      await next()
      return
    }

    if (!isApiAuthEnabled()) {
      setAuthSession(c, createOpenAuthSession())
      await next()
      return
    }

    const session = authenticateBearerToken(parseBearerToken(c.req.header('authorization')))
    if (!session) {
      return c.json(
        {
          error: 'Unauthorized',
          code: 'UNAUTHORIZED',
        },
        401
      )
    }

    setAuthSession(c, session)

    if (session.mustChangePassword && !isPasswordChangeExemptPath(c.req.path)) {
      return c.json(
        {
          error: 'Password change is required before using this feature',
          code: 'PASSWORD_CHANGE_REQUIRED',
        },
        403
      )
    }

    await next()
  }
}

export function requireAdmin(c: Context) {
  const session = getAuthSession(c)
  if (session.isAdmin) {
    return null
  }

  return c.json(
    {
      error: 'Admin access is required',
      code: 'FORBIDDEN',
    },
    403
  )
}

export function requireProjectPermission(c: Context, projectId: string, permission: AccessPermission) {
  const session = getAuthSession(c)

  if (!hasProjectAccess(session, projectId)) {
    return c.json(
      {
        error: 'This token cannot access the selected project',
        code: 'PROJECT_FORBIDDEN',
      },
      403
    )
  }

  if (!hasPermission(session, permission)) {
    return c.json(
      {
        error: `This token cannot use ${permission} in the selected project`,
        code: 'FEATURE_FORBIDDEN',
      },
      403
    )
  }

  return null
}
