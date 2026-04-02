import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { nanoid } from 'nanoid'
import {
  ACCESS_PERMISSION_IDS,
  allAccessPermissions,
  type AccessPermission,
  type AuthSession,
} from './access-policy.js'
import { loadAppEnvFile } from './env.js'
import { resolveRuntimeDataPath } from './runtime-data-paths.js'

const ACCESS_CONTROL_PATH_ENV = 'INTENTLANE_CODEX_ACCESS_CONTROL_PATH'
const SHARED_TOKEN_ENV = 'APP_SHARED_TOKEN'
const BOOTSTRAP_ROOT_ENABLED_ENV = 'INTENTLANE_CODEX_BOOTSTRAP_ROOT_ENABLED'
const BOOTSTRAP_ROOT_NAME_ENV = 'INTENTLANE_CODEX_BOOTSTRAP_ROOT_NAME'
const BOOTSTRAP_ROOT_PASSWORD_ENV = 'INTENTLANE_CODEX_BOOTSTRAP_ROOT_PASSWORD'
const ACCOUNT_SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7
const LAST_USED_WRITE_INTERVAL_MS = 1000 * 60

export interface AccessAccount {
  id: string
  name: string
  description?: string
  disabled: boolean
  isAdmin: boolean
  permissions: AccessPermission[]
  projectIds: string[]
  mustChangePassword: boolean
  passwordHash?: string
  passwordSalt?: string
  passwordUpdatedAt: string | null
  lastLoginAt: string | null
  createdAt: string
  updatedAt: string
}

export interface AccessTokenRecord {
  id: string
  accountId: string
  label: string
  isAdmin: boolean
  permissions: AccessPermission[]
  projectIds: string[]
  expiresAt: string | null
  createdAt: string
  updatedAt: string
  revokedAt: string | null
  lastUsedAt: string | null
  tokenHash: string
  tokenPreview: string
}

export interface AccessSessionRecord {
  id: string
  accountId: string
  label: string
  expiresAt: string | null
  createdAt: string
  updatedAt: string
  revokedAt: string | null
  lastUsedAt: string | null
  tokenHash: string
  tokenPreview: string
}

interface AccessControlFile {
  accounts: AccessAccount[]
  tokens: AccessTokenRecord[]
  sessions: AccessSessionRecord[]
}

export interface PublicAccessToken {
  id: string
  accountId: string
  accountName: string
  label: string
  isAdmin: boolean
  permissions: AccessPermission[]
  projectIds: string[]
  expiresAt: string | null
  createdAt: string
  updatedAt: string
  revokedAt: string | null
  lastUsedAt: string | null
  tokenPreview: string
  status: 'active' | 'expired' | 'revoked' | 'disabled'
}

export interface PublicAccessSession {
  id: string
  accountId: string
  accountName: string
  label: string
  expiresAt: string | null
  createdAt: string
  updatedAt: string
  revokedAt: string | null
  lastUsedAt: string | null
  tokenPreview: string
  status: 'active' | 'expired' | 'revoked' | 'disabled'
}

export interface PublicAccessAccount {
  id: string
  name: string
  description?: string
  disabled: boolean
  isAdmin: boolean
  permissions: AccessPermission[]
  projectIds: string[]
  mustChangePassword: boolean
  hasPassword: boolean
  passwordUpdatedAt: string | null
  lastLoginAt: string | null
  createdAt: string
  updatedAt: string
  tokens: PublicAccessToken[]
  sessions: PublicAccessSession[]
}

export interface AccessControlSummary {
  accounts: PublicAccessAccount[]
  tokens: PublicAccessToken[]
  sessions: PublicAccessSession[]
}

function getAccessControlPath() {
  loadAppEnvFile()
  return process.env[ACCESS_CONTROL_PATH_ENV]?.trim() || resolveRuntimeDataPath('access-control.json')
}

function defaultAccessControl(): AccessControlFile {
  return {
    accounts: [],
    tokens: [],
    sessions: [],
  }
}

function nowIso() {
  return new Date().toISOString()
}

function isBootstrapRootEnabled() {
  const value = process.env[BOOTSTRAP_ROOT_ENABLED_ENV]?.trim().toLowerCase()
  return value === '1' || value === 'true' || value === 'yes' || value === 'on'
}

function getBootstrapRootName() {
  return process.env[BOOTSTRAP_ROOT_NAME_ENV]?.trim() || 'root'
}

function getBootstrapRootPassword() {
  return process.env[BOOTSTRAP_ROOT_PASSWORD_ENV]?.trim() || process.env[SHARED_TOKEN_ENV]?.trim() || ''
}

function hashToken(token: string) {
  return createHash('sha256').update(token).digest('hex')
}

function hashPassword(password: string, salt: string) {
  return scryptSync(password, salt, 64).toString('hex')
}

function safeHashEquals(left: string, right: string) {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)

  if (leftBuffer.length !== rightBuffer.length) {
    return false
  }

  return timingSafeEqual(leftBuffer, rightBuffer)
}

function normalizePermissions(
  value: unknown,
  isAdmin: boolean,
  options: { allowEmpty?: boolean } = {}
): AccessPermission[] {
  if (isAdmin) {
    return allAccessPermissions()
  }

  if (!Array.isArray(value)) {
    if (options.allowEmpty) {
      return []
    }

    throw new Error('At least one permission is required')
  }

  const permissions = Array.from(
    new Set(
      value.flatMap((entry) =>
        typeof entry === 'string' && ACCESS_PERMISSION_IDS.includes(entry as AccessPermission)
          ? [entry as AccessPermission]
          : []
      )
    )
  )

  if (permissions.length === 0 && !options.allowEmpty) {
    throw new Error('At least one permission is required')
  }

  return permissions
}

function normalizeProjectIds(
  value: unknown,
  isAdmin: boolean,
  options: { allowEmpty?: boolean } = {}
): string[] {
  if (isAdmin) {
    return []
  }

  if (!Array.isArray(value)) {
    if (options.allowEmpty) {
      return []
    }

    throw new Error('At least one project is required')
  }

  const projectIds = Array.from(
    new Set(value.flatMap((entry) => (typeof entry === 'string' && entry.trim() ? [entry.trim()] : [])))
  )

  if (projectIds.length === 0 && !options.allowEmpty) {
    throw new Error('At least one project is required')
  }

  return projectIds
}

function normalizeTimestamp(value: unknown, fieldName: string): string | null {
  if (value == null || value === '') {
    return null
  }

  if (typeof value !== 'string') {
    throw new Error(`${fieldName} must be a datetime string`)
  }

  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${fieldName} must be a valid datetime`)
  }

  return parsed.toISOString()
}

function normalizeAccount(account: Partial<AccessAccount>): AccessAccount {
  if (!account.id?.trim() || !account.name?.trim() || !account.createdAt || !account.updatedAt) {
    throw new Error('Access account is malformed')
  }

  const isAdmin = Boolean(account.isAdmin)
  const passwordHash = account.passwordHash?.trim() || undefined
  const passwordSalt = account.passwordSalt?.trim() || undefined

  if (Boolean(passwordHash) !== Boolean(passwordSalt)) {
    throw new Error('Access account password state is malformed')
  }

  return {
    id: account.id.trim(),
    name: account.name.trim(),
    description: account.description?.trim() || undefined,
    disabled: Boolean(account.disabled),
    isAdmin,
    permissions: normalizePermissions(account.permissions ?? [], isAdmin, { allowEmpty: true }),
    projectIds: normalizeProjectIds(account.projectIds ?? [], isAdmin, { allowEmpty: true }),
    mustChangePassword: Boolean(account.mustChangePassword),
    passwordHash,
    passwordSalt,
    passwordUpdatedAt: normalizeTimestamp(account.passwordUpdatedAt, 'Account passwordUpdatedAt'),
    lastLoginAt: normalizeTimestamp(account.lastLoginAt, 'Account lastLoginAt'),
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  }
}

function normalizeToken(token: Partial<AccessTokenRecord>): AccessTokenRecord {
  if (
    !token.id?.trim() ||
    !token.accountId?.trim() ||
    !token.label?.trim() ||
    !token.tokenHash?.trim() ||
    !token.tokenPreview?.trim()
  ) {
    throw new Error('Access token is malformed')
  }

  const isAdmin = Boolean(token.isAdmin)

  return {
    id: token.id.trim(),
    accountId: token.accountId.trim(),
    label: token.label.trim(),
    isAdmin,
    permissions: normalizePermissions(token.permissions ?? [], isAdmin),
    projectIds: normalizeProjectIds(token.projectIds ?? [], isAdmin),
    expiresAt: normalizeTimestamp(token.expiresAt, 'Token expiration'),
    createdAt: token.createdAt || nowIso(),
    updatedAt: token.updatedAt || nowIso(),
    revokedAt: normalizeTimestamp(token.revokedAt, 'Token revokedAt'),
    lastUsedAt: normalizeTimestamp(token.lastUsedAt, 'Token lastUsedAt'),
    tokenHash: token.tokenHash.trim(),
    tokenPreview: token.tokenPreview.trim(),
  }
}

function normalizeSession(session: Partial<AccessSessionRecord>): AccessSessionRecord {
  if (
    !session.id?.trim() ||
    !session.accountId?.trim() ||
    !session.label?.trim() ||
    !session.tokenHash?.trim() ||
    !session.tokenPreview?.trim()
  ) {
    throw new Error('Access session is malformed')
  }

  return {
    id: session.id.trim(),
    accountId: session.accountId.trim(),
    label: session.label.trim(),
    expiresAt: normalizeTimestamp(session.expiresAt, 'Session expiration'),
    createdAt: session.createdAt || nowIso(),
    updatedAt: session.updatedAt || nowIso(),
    revokedAt: normalizeTimestamp(session.revokedAt, 'Session revokedAt'),
    lastUsedAt: normalizeTimestamp(session.lastUsedAt, 'Session lastUsedAt'),
    tokenHash: session.tokenHash.trim(),
    tokenPreview: session.tokenPreview.trim(),
  }
}

export function loadAccessControl(): AccessControlFile {
  const path = getAccessControlPath()

  const data = !existsSync(path)
    ? defaultAccessControl()
    : (() => {
        const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<AccessControlFile>
        return {
          accounts: (parsed.accounts ?? []).map((account) => normalizeAccount(account)),
          tokens: (parsed.tokens ?? []).map((token) => normalizeToken(token)),
          sessions: (parsed.sessions ?? []).map((session) => normalizeSession(session)),
        }
      })()

  if (isBootstrapRootEnabled() && data.accounts.length === 0) {
    const password = getBootstrapRootPassword()
    const name = getBootstrapRootName()

    if (password && name) {
      const timestamp = nowIso()
      const credentials = buildAccountPassword(password)
      data.accounts.push({
        id: `acct_${nanoid(10)}`,
        name,
        disabled: false,
        isAdmin: true,
        permissions: allAccessPermissions(),
        projectIds: [],
        mustChangePassword: true,
        passwordHash: credentials.passwordHash,
        passwordSalt: credentials.passwordSalt,
        passwordUpdatedAt: timestamp,
        lastLoginAt: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      saveAccessControl(data)
    }
  }

  return data
}

function saveAccessControl(data: AccessControlFile) {
  const path = getAccessControlPath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(data, null, 2), 'utf-8')
}

function tokenStatus(token: AccessTokenRecord, account: AccessAccount | undefined): PublicAccessToken['status'] {
  if (token.revokedAt) {
    return 'revoked'
  }

  if (account?.disabled) {
    return 'disabled'
  }

  if (token.expiresAt && new Date(token.expiresAt).getTime() <= Date.now()) {
    return 'expired'
  }

  return 'active'
}

function sessionStatus(
  session: AccessSessionRecord,
  account: AccessAccount | undefined
): PublicAccessSession['status'] {
  if (session.revokedAt) {
    return 'revoked'
  }

  if (account?.disabled) {
    return 'disabled'
  }

  if (session.expiresAt && new Date(session.expiresAt).getTime() <= Date.now()) {
    return 'expired'
  }

  return 'active'
}

function toPublicToken(token: AccessTokenRecord, account: AccessAccount | undefined): PublicAccessToken {
  return {
    id: token.id,
    accountId: token.accountId,
    accountName: account?.name || 'Unknown account',
    label: token.label,
    isAdmin: token.isAdmin,
    permissions: token.permissions,
    projectIds: token.projectIds,
    expiresAt: token.expiresAt,
    createdAt: token.createdAt,
    updatedAt: token.updatedAt,
    revokedAt: token.revokedAt,
    lastUsedAt: token.lastUsedAt,
    tokenPreview: token.tokenPreview,
    status: tokenStatus(token, account),
  }
}

function toPublicSession(session: AccessSessionRecord, account: AccessAccount | undefined): PublicAccessSession {
  return {
    id: session.id,
    accountId: session.accountId,
    accountName: account?.name || 'Unknown account',
    label: session.label,
    expiresAt: session.expiresAt,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    revokedAt: session.revokedAt,
    lastUsedAt: session.lastUsedAt,
    tokenPreview: session.tokenPreview,
    status: sessionStatus(session, account),
  }
}

function toPublicAccount(
  account: AccessAccount,
  tokens: PublicAccessToken[],
  sessions: PublicAccessSession[]
): PublicAccessAccount {
  return {
    id: account.id,
    name: account.name,
    description: account.description,
    disabled: account.disabled,
    isAdmin: account.isAdmin,
    permissions: account.permissions,
    projectIds: account.projectIds,
    mustChangePassword: account.mustChangePassword,
    hasPassword: Boolean(account.passwordHash && account.passwordSalt),
    passwordUpdatedAt: account.passwordUpdatedAt,
    lastLoginAt: account.lastLoginAt,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
    tokens,
    sessions,
  }
}

export function listAccessSummary(): AccessControlSummary {
  const data = loadAccessControl()
  const accountMap = new Map(data.accounts.map((account) => [account.id, account]))
  const tokens = data.tokens
    .map((token) => toPublicToken(token, accountMap.get(token.accountId)))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  const sessions = data.sessions
    .map((session) => toPublicSession(session, accountMap.get(session.accountId)))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))

  return {
    accounts: data.accounts
      .map((account) =>
        toPublicAccount(
          account,
          tokens.filter((token) => token.accountId === account.id),
          sessions.filter((session) => session.accountId === account.id)
        )
      )
      .sort((left, right) => left.name.localeCompare(right.name)),
    tokens,
    sessions,
  }
}

function buildTokenSecret(kind: 'access' | 'session' = 'access') {
  const prefix = kind === 'session' ? 'tfs' : 'tf'
  return `${prefix}_${nanoid(12)}.${nanoid(32)}`
}

function buildTokenPreview(token: string) {
  const prefix = token.slice(0, 12)
  const suffix = token.slice(-6)
  return `${prefix}...${suffix}`
}

function buildAccountPassword(password: string) {
  const normalizedPassword = password.trim()
  if (normalizedPassword.length < 8) {
    throw new Error('Password must be at least 8 characters')
  }

  const salt = randomBytes(16).toString('hex')
  return {
    passwordSalt: salt,
    passwordHash: hashPassword(normalizedPassword, salt),
  }
}

function verifyAccountPassword(account: AccessAccount, password: string) {
  if (!account.passwordHash || !account.passwordSalt) {
    return false
  }

  const candidateHash = hashPassword(password, account.passwordSalt)
  return safeHashEquals(account.passwordHash, candidateHash)
}

function shouldUpdateLastUsed(lastUsedAt: string | null) {
  if (!lastUsedAt) {
    return true
  }

  return Date.now() - new Date(lastUsedAt).getTime() >= LAST_USED_WRITE_INTERVAL_MS
}

function buildAccountAuthSession(
  account: AccessAccount,
  options: {
    kind: 'access_token' | 'account_session'
    tokenId: string
    tokenLabel: string
    expiresAt: string | null
  }
): AuthSession {
  return {
    kind: options.kind,
    label: account.name,
    isAdmin: account.isAdmin,
    permissions: account.isAdmin ? allAccessPermissions() : account.permissions,
    projectIds: account.isAdmin ? null : account.projectIds,
    mustChangePassword: account.mustChangePassword,
    accountId: account.id,
    accountName: account.name,
    tokenId: options.tokenId,
    tokenLabel: options.tokenLabel,
    expiresAt: options.expiresAt,
  }
}

export function createAccessAccount(input: {
  name: string
  description?: string
  isAdmin?: boolean
  permissions?: AccessPermission[]
  projectIds?: string[]
}): AccessAccount {
  const name = input.name?.trim()
  if (!name) {
    throw new Error('Account name is required')
  }

  const data = loadAccessControl()
  if (data.accounts.some((account) => account.name.toLowerCase() === name.toLowerCase())) {
    throw new Error('Account name already exists')
  }

  const isAdmin = Boolean(input.isAdmin)
  const timestamp = nowIso()
  const account: AccessAccount = {
    id: `acct_${nanoid(10)}`,
    name,
    description: input.description?.trim() || undefined,
    disabled: false,
    isAdmin,
    permissions: normalizePermissions(input.permissions ?? [], isAdmin, { allowEmpty: true }),
    projectIds: normalizeProjectIds(input.projectIds ?? [], isAdmin, { allowEmpty: true }),
    mustChangePassword: false,
    passwordUpdatedAt: null,
    lastLoginAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  }

  data.accounts.push(account)
  saveAccessControl(data)
  return account
}

export function updateAccessAccount(input: {
  accountId: string
  name: string
  description?: string
  disabled?: boolean
  isAdmin?: boolean
  permissions?: AccessPermission[]
  projectIds?: string[]
}) {
  const data = loadAccessControl()
  const account = data.accounts.find((entry) => entry.id === input.accountId)

  if (!account) {
    throw new Error('Access account not found')
  }

  const name = input.name?.trim()
  if (!name) {
    throw new Error('Account name is required')
  }

  if (
    data.accounts.some(
      (entry) => entry.id !== account.id && entry.name.toLowerCase() === name.toLowerCase()
    )
  ) {
    throw new Error('Account name already exists')
  }

  const isAdmin = Boolean(input.isAdmin)
  account.name = name
  account.description = input.description?.trim() || undefined
  account.disabled = Boolean(input.disabled)
  account.isAdmin = isAdmin
  account.permissions = normalizePermissions(input.permissions ?? [], isAdmin, { allowEmpty: true })
  account.projectIds = normalizeProjectIds(input.projectIds ?? [], isAdmin, { allowEmpty: true })
  account.updatedAt = nowIso()

  saveAccessControl(data)
  return account
}

export function setAccessAccountPassword(
  accountId: string,
  password: string,
  options?: {
    requirePasswordChange?: boolean
  }
) {
  const data = loadAccessControl()
  const account = data.accounts.find((entry) => entry.id === accountId)

  if (!account) {
    throw new Error('Access account not found')
  }

  const timestamp = nowIso()
  const credentials = buildAccountPassword(password)
  account.passwordSalt = credentials.passwordSalt
  account.passwordHash = credentials.passwordHash
  account.mustChangePassword = Boolean(options?.requirePasswordChange)
  account.passwordUpdatedAt = timestamp
  account.updatedAt = timestamp

  saveAccessControl(data)
  return account
}

export function changeAccessAccountPassword(input: {
  accountId: string
  currentPassword: string
  newPassword: string
}) {
  const data = loadAccessControl()
  const account = data.accounts.find((entry) => entry.id === input.accountId)

  if (!account) {
    throw new Error('Access account not found')
  }

  const currentPassword = input.currentPassword.trim()
  if (!currentPassword || !verifyAccountPassword(account, currentPassword)) {
    throw new Error('Current password is incorrect')
  }

  const timestamp = nowIso()
  const credentials = buildAccountPassword(input.newPassword)
  account.passwordSalt = credentials.passwordSalt
  account.passwordHash = credentials.passwordHash
  account.mustChangePassword = false
  account.passwordUpdatedAt = timestamp
  account.updatedAt = timestamp

  saveAccessControl(data)
  return account
}

export function clearAccessAccountPassword(accountId: string) {
  const data = loadAccessControl()
  const account = data.accounts.find((entry) => entry.id === accountId)

  if (!account) {
    throw new Error('Access account not found')
  }

  account.passwordSalt = undefined
  account.passwordHash = undefined
  account.mustChangePassword = false
  account.passwordUpdatedAt = null
  account.updatedAt = nowIso()
  data.sessions = data.sessions.filter((session) => session.accountId !== accountId)

  saveAccessControl(data)
  return account
}

export function deleteAccessAccount(accountId: string) {
  const data = loadAccessControl()
  const tokenCount = data.tokens.filter((token) => token.accountId === accountId).length
  if (tokenCount > 0) {
    throw new Error('Delete account tokens before deleting the account')
  }

  const sessionCount = data.sessions.filter((session) => session.accountId === accountId).length
  if (sessionCount > 0) {
    throw new Error('Delete account sessions before deleting the account')
  }

  const nextAccounts = data.accounts.filter((account) => account.id !== accountId)
  if (nextAccounts.length === data.accounts.length) {
    throw new Error('Access account not found')
  }

  data.accounts = nextAccounts
  saveAccessControl(data)
}

export function createAccessToken(input: {
  accountId: string
  label: string
  isAdmin?: boolean
  permissions?: AccessPermission[]
  projectIds?: string[]
  expiresAt?: string | null
}) {
  const data = loadAccessControl()
  const account = data.accounts.find((entry) => entry.id === input.accountId)

  if (!account) {
    throw new Error('Access account not found')
  }

  if (account.disabled) {
    throw new Error('Disabled accounts cannot receive new tokens')
  }

  const label = input.label?.trim()
  if (!label) {
    throw new Error('Token label is required')
  }

  const isAdmin = Boolean(input.isAdmin)
  const permissions = normalizePermissions(input.permissions ?? [], isAdmin)
  const projectIds = normalizeProjectIds(input.projectIds ?? [], isAdmin)
  const expiresAt = normalizeTimestamp(input.expiresAt, 'Token expiration')
  const timestamp = nowIso()
  const secret = buildTokenSecret('access')
  const record: AccessTokenRecord = {
    id: `tok_${nanoid(10)}`,
    accountId: account.id,
    label,
    isAdmin,
    permissions,
    projectIds,
    expiresAt,
    createdAt: timestamp,
    updatedAt: timestamp,
    revokedAt: null,
    lastUsedAt: null,
    tokenHash: hashToken(secret),
    tokenPreview: buildTokenPreview(secret),
  }

  data.tokens.push(record)
  saveAccessControl(data)

  return {
    token: secret,
    record: toPublicToken(record, account),
  }
}

export function revokeAccessToken(tokenId: string) {
  const data = loadAccessControl()
  const token = data.tokens.find((entry) => entry.id === tokenId)

  if (!token) {
    throw new Error('Access token not found')
  }

  if (!token.revokedAt) {
    token.revokedAt = nowIso()
    token.updatedAt = token.revokedAt
    saveAccessControl(data)
  }

  const account = data.accounts.find((entry) => entry.id === token.accountId)
  return toPublicToken(token, account)
}

export function deleteAccessToken(tokenId: string) {
  const data = loadAccessControl()
  const nextTokens = data.tokens.filter((token) => token.id !== tokenId)

  if (nextTokens.length === data.tokens.length) {
    throw new Error('Access token not found')
  }

  data.tokens = nextTokens
  saveAccessControl(data)
}

export function createAccountSession(input: { name: string; password: string }) {
  const name = input.name?.trim()
  const password = input.password?.trim() || ''

  if (!name || !password) {
    throw new Error('Account name and password are required')
  }

  const data = loadAccessControl()
  const account = data.accounts.find((entry) => entry.name.toLowerCase() === name.toLowerCase())

  if (!account || account.disabled || !verifyAccountPassword(account, password)) {
    throw new Error('Invalid account credentials')
  }

  const timestamp = nowIso()
  const expiresAt = new Date(Date.now() + ACCOUNT_SESSION_TTL_MS).toISOString()
  const secret = buildTokenSecret('session')
  const session: AccessSessionRecord = {
    id: `ses_${nanoid(10)}`,
    accountId: account.id,
    label: 'Web login',
    expiresAt,
    createdAt: timestamp,
    updatedAt: timestamp,
    revokedAt: null,
    lastUsedAt: timestamp,
    tokenHash: hashToken(secret),
    tokenPreview: buildTokenPreview(secret),
  }

  account.lastLoginAt = timestamp
  account.updatedAt = timestamp
  data.sessions.push(session)
  saveAccessControl(data)

  return {
    token: secret,
    session: toPublicSession(session, account),
  }
}

export function revokeAccessSession(sessionId: string) {
  const data = loadAccessControl()
  const session = data.sessions.find((entry) => entry.id === sessionId)

  if (!session) {
    throw new Error('Access session not found')
  }

  if (!session.revokedAt) {
    session.revokedAt = nowIso()
    session.updatedAt = session.revokedAt
    saveAccessControl(data)
  }

  const account = data.accounts.find((entry) => entry.id === session.accountId)
  return toPublicSession(session, account)
}

export function deleteAccessSession(sessionId: string) {
  const data = loadAccessControl()
  const nextSessions = data.sessions.filter((session) => session.id !== sessionId)

  if (nextSessions.length === data.sessions.length) {
    throw new Error('Access session not found')
  }

  data.sessions = nextSessions
  saveAccessControl(data)
}

export function authenticateAccessToken(token: string): AuthSession | null {
  const candidateHash = hashToken(token)
  const data = loadAccessControl()

  for (const record of data.tokens) {
    if (!safeHashEquals(record.tokenHash, candidateHash)) {
      continue
    }

    const account = data.accounts.find((entry) => entry.id === record.accountId)
    const status = tokenStatus(record, account)
    if (status !== 'active' || !account) {
      return null
    }

    if (shouldUpdateLastUsed(record.lastUsedAt)) {
      record.lastUsedAt = nowIso()
      saveAccessControl(data)
    }

    return {
      kind: 'access_token',
      label: account.name,
      isAdmin: record.isAdmin,
      permissions: record.permissions,
      projectIds: record.isAdmin ? null : record.projectIds,
      mustChangePassword: account.mustChangePassword,
      accountId: account.id,
      accountName: account.name,
      tokenId: record.id,
      tokenLabel: record.label,
      expiresAt: record.expiresAt,
    }
  }

  return null
}

export function authenticateAccountSession(token: string): AuthSession | null {
  const candidateHash = hashToken(token)
  const data = loadAccessControl()

  for (const record of data.sessions) {
    if (!safeHashEquals(record.tokenHash, candidateHash)) {
      continue
    }

    const account = data.accounts.find((entry) => entry.id === record.accountId)
    const status = sessionStatus(record, account)
    if (status !== 'active' || !account) {
      return null
    }

    if (shouldUpdateLastUsed(record.lastUsedAt)) {
      record.lastUsedAt = nowIso()
      saveAccessControl(data)
    }

    return buildAccountAuthSession(account, {
      kind: 'account_session',
      tokenId: record.id,
      tokenLabel: record.label,
      expiresAt: record.expiresAt,
    })
  }

  return null
}

export function hasManagedAccessTokens(): boolean {
  return loadAccessControl().tokens.length > 0
}

export function hasManagedAccountLogins(): boolean {
  return loadAccessControl().accounts.some((account) => Boolean(account.passwordHash && account.passwordSalt))
}
