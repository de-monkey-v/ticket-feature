import { Hono } from 'hono'
import {
  clearAccessAccountPassword,
  changeAccessAccountPassword,
  createAccessAccount,
  createAccessToken,
  createAccountSession,
  deleteAccessAccount,
  deleteAccessSession,
  deleteAccessToken,
  listAccessSummary,
  revokeAccessSession,
  revokeAccessToken,
  setAccessAccountPassword,
  updateAccessAccount,
} from '../lib/access-control.js'
import { getAuthSession, requireAdmin } from '../lib/auth.js'
import { loadConfig } from '../lib/config.js'

export const accessRoutes = new Hono()

function ensureProjectIdsExist(projectIds: string[] | undefined) {
  if (!projectIds?.length) {
    return null
  }

  const config = loadConfig()
  const knownProjectIds = new Set(config.projects.map((project) => project.id))
  return projectIds.find((projectId) => !knownProjectIds.has(projectId)) ?? null
}

accessRoutes.post('/access/login', async (c) => {
  const { name, password } = await c.req.json<{
    name?: string
    password?: string
  }>()

  try {
    const created = createAccountSession({
      name: name || '',
      password: password || '',
    })
    return c.json(created)
  } catch (error: any) {
    return c.json({ error: error.message || 'Failed to sign in' }, 401)
  }
})

accessRoutes.post('/access/logout', (c) => {
  const session = getAuthSession(c)

  if (session.kind === 'account_session' && session.tokenId) {
    try {
      revokeAccessSession(session.tokenId)
    } catch {
      return c.json({ ok: true })
    }
  }

  return c.json({ ok: true })
})

accessRoutes.get('/access', (c) => {
  const adminError = requireAdmin(c)
  if (adminError) {
    return adminError
  }

  return c.json(listAccessSummary())
})

accessRoutes.post('/access/accounts', async (c) => {
  const adminError = requireAdmin(c)
  if (adminError) {
    return adminError
  }

  const { name, description, isAdmin, permissions, projectIds, password } = await c.req.json<{
    name?: string
    description?: string
    isAdmin?: boolean
    permissions?: string[]
    projectIds?: string[]
    password?: string
  }>()

  const invalidProjectId = ensureProjectIdsExist(projectIds)
  if (invalidProjectId) {
    return c.json({ error: `Unknown project "${invalidProjectId}"` }, 400)
  }

  if (password?.trim() && password.trim().length < 8) {
    return c.json({ error: 'Password must be at least 8 characters' }, 400)
  }

  try {
    const account = createAccessAccount({
      name: name || '',
      description,
      isAdmin,
      permissions: permissions as never,
      projectIds,
    })

    if (password?.trim()) {
      setAccessAccountPassword(account.id, password, { requirePasswordChange: true })
    }

    return c.json(listAccessSummary().accounts.find((entry) => entry.id === account.id) ?? account)
  } catch (error: any) {
    return c.json({ error: error.message || 'Failed to create access account' }, 400)
  }
})

accessRoutes.patch('/access/accounts/:id', async (c) => {
  const adminError = requireAdmin(c)
  if (adminError) {
    return adminError
  }

  const { name, description, disabled, isAdmin, permissions, projectIds } = await c.req.json<{
    name?: string
    description?: string
    disabled?: boolean
    isAdmin?: boolean
    permissions?: string[]
    projectIds?: string[]
  }>()

  const invalidProjectId = ensureProjectIdsExist(projectIds)
  if (invalidProjectId) {
    return c.json({ error: `Unknown project "${invalidProjectId}"` }, 400)
  }

  try {
    const account = updateAccessAccount({
      accountId: c.req.param('id'),
      name: name || '',
      description,
      disabled,
      isAdmin,
      permissions: permissions as never,
      projectIds,
    })
    return c.json(listAccessSummary().accounts.find((entry) => entry.id === account.id) ?? account)
  } catch (error: any) {
    return c.json({ error: error.message || 'Failed to update access account' }, 400)
  }
})

accessRoutes.post('/access/accounts/:id/password', async (c) => {
  const adminError = requireAdmin(c)
  if (adminError) {
    return adminError
  }

  const { password } = await c.req.json<{ password?: string }>()

  try {
    const account = setAccessAccountPassword(c.req.param('id'), password || '', { requirePasswordChange: true })
    return c.json(listAccessSummary().accounts.find((entry) => entry.id === account.id) ?? account)
  } catch (error: any) {
    return c.json({ error: error.message || 'Failed to update password' }, 400)
  }
})

accessRoutes.post('/access/me/password', async (c) => {
  const session = getAuthSession(c)
  if (!session.accountId) {
    return c.json({ error: 'Account session is required', code: 'FORBIDDEN' }, 403)
  }

  const { currentPassword, newPassword } = await c.req.json<{
    currentPassword?: string
    newPassword?: string
  }>()

  try {
    changeAccessAccountPassword({
      accountId: session.accountId,
      currentPassword: currentPassword || '',
      newPassword: newPassword || '',
    })
    return c.json({ ok: true })
  } catch (error: any) {
    return c.json({ error: error.message || 'Failed to update password' }, 400)
  }
})

accessRoutes.delete('/access/accounts/:id/password', (c) => {
  const adminError = requireAdmin(c)
  if (adminError) {
    return adminError
  }

  try {
    const account = clearAccessAccountPassword(c.req.param('id'))
    return c.json(listAccessSummary().accounts.find((entry) => entry.id === account.id) ?? account)
  } catch (error: any) {
    return c.json({ error: error.message || 'Failed to remove password' }, 400)
  }
})

accessRoutes.delete('/access/accounts/:id', (c) => {
  const adminError = requireAdmin(c)
  if (adminError) {
    return adminError
  }

  try {
    deleteAccessAccount(c.req.param('id'))
    return c.json({ ok: true })
  } catch (error: any) {
    return c.json({ error: error.message || 'Failed to delete access account' }, 400)
  }
})

accessRoutes.post('/access/tokens', async (c) => {
  const adminError = requireAdmin(c)
  if (adminError) {
    return adminError
  }

  const { accountId, label, isAdmin, permissions, projectIds, expiresAt } = await c.req.json<{
    accountId?: string
    label?: string
    isAdmin?: boolean
    permissions?: string[]
    projectIds?: string[]
    expiresAt?: string | null
  }>()

  const invalidProjectId = ensureProjectIdsExist(projectIds)
  if (invalidProjectId) {
    return c.json({ error: `Unknown project "${invalidProjectId}"` }, 400)
  }

  try {
    const created = createAccessToken({
      accountId: accountId || '',
      label: label || '',
      isAdmin,
      permissions: permissions as never,
      projectIds,
      expiresAt,
    })

    return c.json(created)
  } catch (error: any) {
    return c.json({ error: error.message || 'Failed to create access token' }, 400)
  }
})

accessRoutes.post('/access/tokens/:id/revoke', (c) => {
  const adminError = requireAdmin(c)
  if (adminError) {
    return adminError
  }

  try {
    const token = revokeAccessToken(c.req.param('id'))
    return c.json(token)
  } catch (error: any) {
    return c.json({ error: error.message || 'Failed to revoke access token' }, 400)
  }
})

accessRoutes.delete('/access/tokens/:id', (c) => {
  const adminError = requireAdmin(c)
  if (adminError) {
    return adminError
  }

  try {
    deleteAccessToken(c.req.param('id'))
    return c.json({ ok: true })
  } catch (error: any) {
    return c.json({ error: error.message || 'Failed to delete access token' }, 400)
  }
})

accessRoutes.post('/access/sessions/:id/revoke', (c) => {
  const adminError = requireAdmin(c)
  if (adminError) {
    return adminError
  }

  try {
    const session = revokeAccessSession(c.req.param('id'))
    return c.json(session)
  } catch (error: any) {
    return c.json({ error: error.message || 'Failed to revoke access session' }, 400)
  }
})

accessRoutes.delete('/access/sessions/:id', (c) => {
  const adminError = requireAdmin(c)
  if (adminError) {
    return adminError
  }

  try {
    deleteAccessSession(c.req.param('id'))
    return c.json({ ok: true })
  } catch (error: any) {
    return c.json({ error: error.message || 'Failed to delete access session' }, 400)
  }
})
