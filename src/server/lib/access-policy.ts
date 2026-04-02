export const ACCESS_PERMISSION_IDS = ['explain', 'requests', 'tickets', 'direct'] as const

export type AccessPermission = (typeof ACCESS_PERMISSION_IDS)[number]

export interface AuthSession {
  kind: 'open' | 'shared_admin' | 'access_token' | 'account_session'
  label: string
  isAdmin: boolean
  permissions: AccessPermission[]
  projectIds: string[] | null
  mustChangePassword: boolean
  accountId?: string
  accountName?: string
  tokenId?: string
  tokenLabel?: string
  expiresAt?: string | null
}

export function allAccessPermissions(): AccessPermission[] {
  return [...ACCESS_PERMISSION_IDS]
}

export function hasPermission(session: AuthSession, permission: AccessPermission): boolean {
  return session.isAdmin || session.permissions.includes(permission)
}

export function hasProjectAccess(session: AuthSession, projectId: string): boolean {
  return session.isAdmin || session.projectIds === null || session.projectIds.includes(projectId)
}

export function createOpenAuthSession(): AuthSession {
  return {
    kind: 'open',
    label: 'Open access',
    isAdmin: true,
    permissions: allAccessPermissions(),
    projectIds: null,
    mustChangePassword: false,
  }
}
