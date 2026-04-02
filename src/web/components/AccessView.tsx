import { useEffect, useState, type Dispatch, type SetStateAction } from 'react'
import type { AppConfig, AccessAccountSummary, AccessControlSummary, AccessPermission } from '../lib/api'
import {
  clearAccessAccountPassword,
  createAccessAccount,
  createAccessToken,
  deleteAccessAccount,
  deleteAccessSession,
  deleteAccessToken,
  fetchAccessControl,
  revokeAccessSession,
  revokeAccessToken,
  setAccessAccountPassword,
  updateAccessAccount,
} from '../lib/api'
import { WorkspaceHeader } from './WorkspaceHeader'

interface AccessViewProps {
  config: AppConfig
  projectId: string
  onProjectChange: (projectId: string) => void
  onConfigUpdated: () => Promise<void> | void
}

interface AccountDraft {
  name: string
  description: string
  disabled: boolean
  isAdmin: boolean
  permissions: AccessPermission[]
  projectIds: string[]
}

const ACCESS_PERMISSION_OPTIONS: Array<{ id: AccessPermission; label: string }> = [
  { id: 'explain', label: 'Explain' },
  { id: 'requests', label: 'Requests' },
  { id: 'tickets', label: 'Ticket' },
  { id: 'direct', label: 'Direct Dev' },
]

function formatDate(value: string | null | undefined) {
  if (!value) {
    return '없음'
  }

  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    return value
  }

  return parsed.toLocaleString()
}

function createAccountDraft(account: AccessAccountSummary): AccountDraft {
  return {
    name: account.name,
    description: account.description || '',
    disabled: account.disabled,
    isAdmin: account.isAdmin,
    permissions: account.isAdmin ? ACCESS_PERMISSION_OPTIONS.map((option) => option.id) : account.permissions,
    projectIds: account.isAdmin ? [] : account.projectIds,
  }
}

function formatScope(account: AccessAccountSummary) {
  if (account.isAdmin) {
    return 'admin · all projects'
  }

  const permissionLabel = account.permissions.length ? account.permissions.join(', ') : 'no permissions'
  const projectLabel = account.projectIds.length ? account.projectIds.join(', ') : 'no projects'
  return `${permissionLabel} · ${projectLabel}`
}

export function AccessView({ config, projectId, onProjectChange, onConfigUpdated }: AccessViewProps) {
  const [summary, setSummary] = useState<AccessControlSummary | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showAdvancedTokens, setShowAdvancedTokens] = useState(false)
  const [accountName, setAccountName] = useState('')
  const [accountDescription, setAccountDescription] = useState('')
  const [accountPassword, setAccountPassword] = useState('')
  const [accountIsAdmin, setAccountIsAdmin] = useState(false)
  const [accountPermissions, setAccountPermissions] = useState<AccessPermission[]>(['explain'])
  const [accountProjectIds, setAccountProjectIds] = useState<string[]>(
    config.allowedProjects[0] ? [config.allowedProjects[0].id] : []
  )
  const [selectedAccountId, setSelectedAccountId] = useState('')
  const [tokenLabel, setTokenLabel] = useState('')
  const [tokenExpiresAt, setTokenExpiresAt] = useState('')
  const [isAdminToken, setIsAdminToken] = useState(false)
  const [permissions, setPermissions] = useState<AccessPermission[]>(['explain'])
  const [projectIds, setProjectIds] = useState<string[]>(config.allowedProjects[0] ? [config.allowedProjects[0].id] : [])
  const [generatedToken, setGeneratedToken] = useState<string | null>(null)
  const [generatedTokenPreview, setGeneratedTokenPreview] = useState<string | null>(null)
  const [accountDrafts, setAccountDrafts] = useState<Record<string, AccountDraft>>({})
  const [passwordDrafts, setPasswordDrafts] = useState<Record<string, string>>({})

  const refresh = async () => {
    setIsLoading(true)
    setError(null)

    try {
      const nextSummary = await fetchAccessControl()
      setSummary(nextSummary)
      setSelectedAccountId((current) =>
        current && nextSummary.accounts.some((account) => account.id === current)
          ? current
          : nextSummary.accounts[0]?.id ?? ''
      )
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Access control 정보를 불러오지 못했습니다.')
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  useEffect(() => {
    if (!summary) {
      return
    }

    setAccountDrafts(
      Object.fromEntries(summary.accounts.map((account) => [account.id, createAccountDraft(account)]))
    )
    setPasswordDrafts({})
  }, [summary])

  useEffect(() => {
    if (accountIsAdmin) {
      setAccountPermissions(ACCESS_PERMISSION_OPTIONS.map((option) => option.id))
      setAccountProjectIds([])
      return
    }

    setAccountPermissions((current) => (current.length > 0 ? current : ['explain']))
    setAccountProjectIds((current) =>
      current.length > 0 ? current : config.allowedProjects[0] ? [config.allowedProjects[0].id] : []
    )
  }, [accountIsAdmin, config.allowedProjects])

  useEffect(() => {
    if (isAdminToken) {
      setPermissions(ACCESS_PERMISSION_OPTIONS.map((option) => option.id))
      setProjectIds([])
      return
    }

    setPermissions((current) => (current.length > 0 ? current : ['explain']))
    setProjectIds((current) => (current.length > 0 ? current : config.allowedProjects[0] ? [config.allowedProjects[0].id] : []))
  }, [config.allowedProjects, isAdminToken])

  const togglePermission = (
    setter: Dispatch<SetStateAction<AccessPermission[]>>,
    permission: AccessPermission
  ) => {
    setter((current) =>
      current.includes(permission) ? current.filter((entry) => entry !== permission) : [...current, permission]
    )
  }

  const toggleProject = (setter: Dispatch<SetStateAction<string[]>>, projectId: string) => {
    setter((current) =>
      current.includes(projectId) ? current.filter((entry) => entry !== projectId) : [...current, projectId]
    )
  }

  const updateDraft = (accountId: string, patch: Partial<AccountDraft>) => {
    setAccountDrafts((current) => {
      const next = {
        ...(current[accountId] || {
          name: '',
          description: '',
          disabled: false,
          isAdmin: false,
          permissions: ['explain'] as AccessPermission[],
          projectIds: [],
        }),
        ...patch,
      }

      if (next.isAdmin) {
        next.permissions = ACCESS_PERMISSION_OPTIONS.map((option) => option.id)
        next.projectIds = []
      } else {
        if (next.permissions.length === 0) {
          next.permissions = ['explain']
        }
        if (next.projectIds.length === 0 && config.allowedProjects[0]) {
          next.projectIds = [config.allowedProjects[0].id]
        }
      }

      return {
        ...current,
        [accountId]: next,
      }
    })
  }

  const handleCreateAccount = async () => {
    try {
      await createAccessAccount({
        name: accountName,
        description: accountDescription || undefined,
        password: accountPassword || undefined,
        isAdmin: accountIsAdmin,
        permissions: accountPermissions,
        projectIds: accountProjectIds,
      })

      setAccountName('')
      setAccountDescription('')
      setAccountPassword('')
      setAccountIsAdmin(false)
      setAccountPermissions(['explain'])
      setAccountProjectIds(config.allowedProjects[0] ? [config.allowedProjects[0].id] : [])
      await refresh()
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '계정을 생성하지 못했습니다.')
    }
  }

  const handleCreateToken = async () => {
    try {
      const created = await createAccessToken({
        accountId: selectedAccountId,
        label: tokenLabel,
        isAdmin: isAdminToken,
        permissions,
        projectIds,
        expiresAt: tokenExpiresAt ? new Date(tokenExpiresAt).toISOString() : null,
      })

      setShowAdvancedTokens(true)
      setGeneratedToken(created.token)
      setGeneratedTokenPreview(created.record.tokenPreview)
      setTokenLabel('')
      setTokenExpiresAt('')
      setIsAdminToken(false)
      setPermissions(['explain'])
      setProjectIds(config.allowedProjects[0] ? [config.allowedProjects[0].id] : [])
      await refresh()
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '토큰을 발급하지 못했습니다.')
    }
  }

  const handleSaveAccount = async (accountId: string) => {
    const draft = accountDrafts[accountId]
    if (!draft) {
      return
    }

    try {
      await updateAccessAccount({
        accountId,
        name: draft.name,
        description: draft.description || undefined,
        disabled: draft.disabled,
        isAdmin: draft.isAdmin,
        permissions: draft.permissions,
        projectIds: draft.projectIds,
      })
      await refresh()
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '계정을 수정하지 못했습니다.')
    }
  }

  const handleSetPassword = async (accountId: string) => {
    const nextPassword = passwordDrafts[accountId]?.trim()
    if (!nextPassword) {
      return
    }

    try {
      await setAccessAccountPassword({
        accountId,
        password: nextPassword,
      })
      setPasswordDrafts((current) => ({ ...current, [accountId]: '' }))
      await refresh()
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '비밀번호를 설정하지 못했습니다.')
    }
  }

  const handleClearPassword = async (accountId: string) => {
    try {
      await clearAccessAccountPassword(accountId)
      setPasswordDrafts((current) => ({ ...current, [accountId]: '' }))
      await refresh()
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '비밀번호를 제거하지 못했습니다.')
    }
  }

  const runAndRefresh = async (operation: () => Promise<unknown>) => {
    try {
      await operation()
      await refresh()
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '작업을 완료하지 못했습니다.')
    }
  }

  const renderPermissionPicker = (
    selected: AccessPermission[],
    isAdmin: boolean,
    onToggle: (permission: AccessPermission) => void
  ) => (
    <div className="flex flex-wrap gap-2">
      {ACCESS_PERMISSION_OPTIONS.map((option) => (
        <label
          key={option.id}
          className={`rounded-full border px-3 py-1.5 text-sm transition-colors ${
            selected.includes(option.id)
              ? 'border-blue-700 bg-blue-950/50 text-blue-100'
              : 'border-zinc-700 bg-zinc-950 text-zinc-300'
          } ${isAdmin ? 'opacity-60' : ''}`}
        >
          <input
            type="checkbox"
            checked={selected.includes(option.id)}
            onChange={() => onToggle(option.id)}
            disabled={isAdmin}
            className="sr-only"
          />
          {option.label}
        </label>
      ))}
    </div>
  )

  const renderProjectPicker = (selected: string[], isAdmin: boolean, onToggle: (projectId: string) => void) => (
    <div className="flex flex-wrap gap-2">
      {config.allowedProjects.map((project) => (
        <label
          key={project.id}
          className={`rounded-full border px-3 py-1.5 text-sm transition-colors ${
            selected.includes(project.id)
              ? 'border-emerald-700 bg-emerald-950/40 text-emerald-100'
              : 'border-zinc-700 bg-zinc-950 text-zinc-300'
          } ${isAdmin ? 'opacity-60' : ''}`}
        >
          <input
            type="checkbox"
            checked={selected.includes(project.id)}
            onChange={() => onToggle(project.id)}
            disabled={isAdmin}
            className="sr-only"
          />
          {project.label}
        </label>
      ))}
    </div>
  )

  const accessHeader = (
    <WorkspaceHeader
      authSession={config.auth.session}
      projects={config.allowedProjects}
      projectId={projectId}
      onProjectChange={onProjectChange}
      onConfigUpdated={onConfigUpdated}
      title="Access Control"
      subtitle="계정 로그인과 세션을 기본 흐름으로 관리하고, 토큰은 고급 섹션에서만 다룹니다."
      controls={
        <button
          type="button"
          onClick={() => void refresh()}
          className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-200 transition-colors hover:bg-zinc-800"
        >
          Refresh
        </button>
      }
    />
  )

  if (!config.auth.session.isAdmin) {
    return (
      <div className="flex h-full flex-col overflow-hidden">
        {accessHeader}
        <div className="flex flex-1 items-center justify-center p-6 text-zinc-400">
          <p className="text-sm">관리자 권한이 있어야 access control을 관리할 수 있습니다.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {accessHeader}

      <div className="flex-1 overflow-y-auto px-6 py-5">
        <div className="mx-auto flex max-w-6xl flex-col gap-6">
          {error ? (
            <section className="rounded-2xl border border-red-900/70 bg-red-950/20 p-4 text-sm text-red-200">
              {error}
            </section>
          ) : null}

          <div className="grid gap-6 xl:grid-cols-[1.1fr_1.2fr]">
            <section className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-4">
              <p className="text-sm font-medium text-zinc-100">Create Account</p>
              <div className="mt-4 space-y-3">
                <input
                  value={accountName}
                  onChange={(event) => setAccountName(event.target.value)}
                  placeholder="Account name"
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 focus:border-zinc-500 focus:outline-none"
                />
                <textarea
                  value={accountDescription}
                  onChange={(event) => setAccountDescription(event.target.value)}
                  placeholder="Description (optional)"
                  rows={3}
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 focus:border-zinc-500 focus:outline-none"
                />
                <input
                  type="password"
                  value={accountPassword}
                  onChange={(event) => setAccountPassword(event.target.value)}
                  placeholder="Initial password (optional)"
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 focus:border-zinc-500 focus:outline-none"
                />

                <label className="flex items-center gap-2 text-sm text-zinc-200">
                  <input
                    type="checkbox"
                    checked={accountIsAdmin}
                    onChange={(event) => setAccountIsAdmin(event.target.checked)}
                    className="h-4 w-4 rounded border-zinc-700 bg-zinc-950"
                  />
                  Admin account
                </label>

                <div>
                  <p className="mb-2 text-xs uppercase tracking-[0.18em] text-zinc-500">Default Permissions</p>
                  {renderPermissionPicker(accountPermissions, accountIsAdmin, (permission) =>
                    togglePermission(setAccountPermissions, permission)
                  )}
                </div>

                <div>
                  <p className="mb-2 text-xs uppercase tracking-[0.18em] text-zinc-500">Default Projects</p>
                  {renderProjectPicker(accountProjectIds, accountIsAdmin, (projectId) =>
                    toggleProject(setAccountProjectIds, projectId)
                  )}
                </div>

                <button
                  type="button"
                  onClick={() => void handleCreateAccount()}
                  disabled={!accountName.trim() || (!accountIsAdmin && (accountPermissions.length === 0 || accountProjectIds.length === 0))}
                  className="w-full rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-500 disabled:bg-zinc-800 disabled:text-zinc-500"
                >
                  Create Account
                </button>
              </div>
            </section>

            <section className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-medium text-zinc-100">Advanced Token Controls</p>
                  <p className="mt-1 text-xs text-zinc-500">
                    자동화, 외부 공유, 비대화형 접근이 필요할 때만 토큰을 발급하세요.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setShowAdvancedTokens((current) => !current)}
                  className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-200 transition-colors hover:bg-zinc-800"
                >
                  {showAdvancedTokens ? 'Hide' : 'Show'}
                </button>
              </div>

              {showAdvancedTokens ? (
                <div className="mt-4 space-y-4">
                  {generatedToken ? (
                    <section className="rounded-2xl border border-emerald-900/70 bg-emerald-950/20 p-4 text-emerald-100">
                      <p className="text-sm font-medium">새 토큰이 발급되었습니다</p>
                      <p className="mt-1 text-xs text-emerald-100/80">
                        이 값은 지금만 표시됩니다. 복사해서 필요한 자동화나 외부 사용자에게 전달하세요.
                      </p>
                      <div className="mt-3 rounded-xl border border-emerald-800/80 bg-zinc-950/60 px-4 py-3 font-mono text-sm break-all">
                        {generatedToken}
                      </div>
                      <div className="mt-3 flex gap-2">
                        <button
                          type="button"
                          onClick={() => void navigator.clipboard.writeText(generatedToken)}
                          className="rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-500"
                        >
                          Copy Token
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setGeneratedToken(null)
                            setGeneratedTokenPreview(null)
                          }}
                          className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 transition-colors hover:bg-zinc-800"
                        >
                          Hide
                        </button>
                      </div>
                      {generatedTokenPreview ? (
                        <p className="mt-2 text-xs text-emerald-100/70">Preview: {generatedTokenPreview}</p>
                      ) : null}
                    </section>
                  ) : null}

                  <div className="space-y-4">
                    <select
                      value={selectedAccountId}
                      onChange={(event) => setSelectedAccountId(event.target.value)}
                      disabled={!summary?.accounts.length}
                      className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 focus:border-zinc-500 focus:outline-none disabled:text-zinc-500"
                    >
                      <option value="">Select account</option>
                      {summary?.accounts.map((account) => (
                        <option key={account.id} value={account.id}>
                          {account.name}
                        </option>
                      ))}
                    </select>

                    <input
                      value={tokenLabel}
                      onChange={(event) => setTokenLabel(event.target.value)}
                      placeholder="Token label"
                      className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 focus:border-zinc-500 focus:outline-none"
                    />

                    <label className="flex items-center gap-2 text-sm text-zinc-200">
                      <input
                        type="checkbox"
                        checked={isAdminToken}
                        onChange={(event) => setIsAdminToken(event.target.checked)}
                        className="h-4 w-4 rounded border-zinc-700 bg-zinc-950"
                      />
                      Admin token
                    </label>

                    <div>
                      <p className="mb-2 text-xs uppercase tracking-[0.18em] text-zinc-500">Permissions</p>
                      {renderPermissionPicker(permissions, isAdminToken, (permission) =>
                        togglePermission(setPermissions, permission)
                      )}
                    </div>

                    <div>
                      <p className="mb-2 text-xs uppercase tracking-[0.18em] text-zinc-500">Projects</p>
                      {renderProjectPicker(projectIds, isAdminToken, (projectId) =>
                        toggleProject(setProjectIds, projectId)
                      )}
                    </div>

                    <div>
                      <label className="mb-2 block text-xs uppercase tracking-[0.18em] text-zinc-500">Expires At</label>
                      <input
                        type="datetime-local"
                        value={tokenExpiresAt}
                        onChange={(event) => setTokenExpiresAt(event.target.value)}
                        className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 focus:border-zinc-500 focus:outline-none"
                      />
                    </div>

                    <button
                      type="button"
                      onClick={() => void handleCreateToken()}
                      disabled={
                        !selectedAccountId ||
                        !tokenLabel.trim() ||
                        (!isAdminToken && (permissions.length === 0 || projectIds.length === 0))
                      }
                      className="w-full rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-500 disabled:bg-zinc-800 disabled:text-zinc-500"
                    >
                      Issue Token
                    </button>
                  </div>
                </div>
              ) : (
                <p className="mt-4 text-xs leading-5 text-zinc-500">
                  {summary?.tokens.length ?? 0}개의 발급 토큰이 숨겨져 있습니다. 이 섹션을 열면 토큰 발급, 복사, 폐기, 삭제를 관리할 수 있습니다.
                </p>
              )}
            </section>
          </div>

          <section className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium text-zinc-100">Accounts</p>
                <p className="mt-1 text-xs text-zinc-500">
                  {isLoading
                    ? 'Loading…'
                    : `${summary?.accounts.length ?? 0} accounts / ${summary?.tokens.length ?? 0} tokens / ${summary?.sessions.length ?? 0} sessions`}
                </p>
              </div>
            </div>

            <div className="mt-4 space-y-4">
              {summary?.accounts.length ? (
                summary.accounts.map((account) => {
                  const draft = accountDrafts[account.id] || createAccountDraft(account)
                  const passwordDraft = passwordDrafts[account.id] || ''

                  return (
                    <div key={account.id} className="rounded-2xl border border-zinc-800 bg-zinc-950/60 p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="text-sm font-medium text-zinc-100">{account.name}</p>
                            <span className="rounded-full border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-400">
                              {account.hasPassword ? 'login enabled' : 'no password'}
                            </span>
                            {account.mustChangePassword ? (
                              <span className="rounded-full border border-emerald-800/70 px-2 py-0.5 text-[11px] text-emerald-200">
                                password change required
                              </span>
                            ) : null}
                            {account.disabled ? (
                              <span className="rounded-full border border-amber-800/70 px-2 py-0.5 text-[11px] text-amber-200">
                                disabled
                              </span>
                            ) : null}
                          </div>
                          <p className="mt-1 text-xs text-zinc-500">{account.description || 'No description'}</p>
                          <p className="mt-1 text-[11px] text-zinc-600">
                            {account.id} · {formatScope(account)}
                          </p>
                          <p className="mt-1 text-[11px] text-zinc-600">
                            created {formatDate(account.createdAt)} · last login {formatDate(account.lastLoginAt)} · password{' '}
                            {formatDate(account.passwordUpdatedAt)}
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() => void runAndRefresh(() => deleteAccessAccount(account.id))}
                          className="rounded-lg border border-red-900/70 bg-red-950/20 px-3 py-1.5 text-sm text-red-200 transition-colors hover:bg-red-950/40"
                        >
                          Delete Account
                        </button>
                      </div>

                      <div className="mt-4 grid gap-6 xl:grid-cols-[1.15fr_0.85fr]">
                        <div className="space-y-4">
                          <section className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4">
                            <p className="text-sm font-medium text-zinc-100">Account Access</p>
                            <div className="mt-4 space-y-3">
                              <input
                                value={draft.name}
                                onChange={(event) => updateDraft(account.id, { name: event.target.value })}
                                placeholder="Account name"
                                className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 focus:border-zinc-500 focus:outline-none"
                              />
                              <textarea
                                value={draft.description}
                                onChange={(event) => updateDraft(account.id, { description: event.target.value })}
                                placeholder="Description"
                                rows={2}
                                className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 focus:border-zinc-500 focus:outline-none"
                              />

                              <div className="flex flex-wrap gap-4">
                                <label className="flex items-center gap-2 text-sm text-zinc-200">
                                  <input
                                    type="checkbox"
                                    checked={draft.isAdmin}
                                    onChange={(event) => updateDraft(account.id, { isAdmin: event.target.checked })}
                                    className="h-4 w-4 rounded border-zinc-700 bg-zinc-950"
                                  />
                                  Admin account
                                </label>
                                <label className="flex items-center gap-2 text-sm text-zinc-200">
                                  <input
                                    type="checkbox"
                                    checked={draft.disabled}
                                    onChange={(event) => updateDraft(account.id, { disabled: event.target.checked })}
                                    className="h-4 w-4 rounded border-zinc-700 bg-zinc-950"
                                  />
                                  Disabled
                                </label>
                              </div>

                              <div>
                                <p className="mb-2 text-xs uppercase tracking-[0.18em] text-zinc-500">Default Permissions</p>
                                {renderPermissionPicker(draft.permissions, draft.isAdmin, (permission) =>
                                  updateDraft(account.id, {
                                    permissions: draft.permissions.includes(permission)
                                      ? draft.permissions.filter((entry) => entry !== permission)
                                      : [...draft.permissions, permission],
                                  })
                                )}
                              </div>

                              <div>
                                <p className="mb-2 text-xs uppercase tracking-[0.18em] text-zinc-500">Default Projects</p>
                                {renderProjectPicker(draft.projectIds, draft.isAdmin, (projectId) =>
                                  updateDraft(account.id, {
                                    projectIds: draft.projectIds.includes(projectId)
                                      ? draft.projectIds.filter((entry) => entry !== projectId)
                                      : [...draft.projectIds, projectId],
                                  })
                                )}
                              </div>

                              <button
                                type="button"
                                onClick={() => void handleSaveAccount(account.id)}
                                disabled={!draft.name.trim() || (!draft.isAdmin && (draft.permissions.length === 0 || draft.projectIds.length === 0))}
                                className="w-full rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-500 disabled:bg-zinc-800 disabled:text-zinc-500"
                              >
                                Save Account
                              </button>
                            </div>
                          </section>

                          {showAdvancedTokens ? (
                            <section className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4">
                              <p className="text-sm font-medium text-zinc-100">Shared Tokens</p>
                              <div className="mt-4 space-y-3">
                                {account.tokens.length ? (
                                  account.tokens.map((token) => (
                                    <div key={token.id} className="rounded-xl border border-zinc-800 bg-zinc-950/70 p-3">
                                      <div className="flex items-start justify-between gap-3">
                                        <div className="min-w-0">
                                          <p className="truncate text-sm font-medium text-zinc-100">
                                            {token.label} <span className="text-zinc-500">({token.tokenPreview})</span>
                                          </p>
                                          <p className="mt-1 text-xs text-zinc-500">
                                            {token.isAdmin ? 'admin' : token.permissions.join(', ')} ·{' '}
                                            {token.isAdmin ? 'all projects' : token.projectIds.join(', ')}
                                          </p>
                                          <p className="mt-1 text-[11px] text-zinc-600">
                                            {token.status} · expires {formatDate(token.expiresAt)} · last used {formatDate(token.lastUsedAt)}
                                          </p>
                                        </div>
                                        <div className="flex shrink-0 gap-2">
                                          {token.status === 'active' ? (
                                            <button
                                              type="button"
                                              onClick={() => void runAndRefresh(() => revokeAccessToken(token.id))}
                                              className="rounded-lg border border-amber-900/70 bg-amber-950/20 px-3 py-1.5 text-sm text-amber-200 transition-colors hover:bg-amber-950/40"
                                            >
                                              Revoke
                                            </button>
                                          ) : null}
                                          <button
                                            type="button"
                                            onClick={() => void runAndRefresh(() => deleteAccessToken(token.id))}
                                            className="rounded-lg border border-red-900/70 bg-red-950/20 px-3 py-1.5 text-sm text-red-200 transition-colors hover:bg-red-950/40"
                                          >
                                            Delete
                                          </button>
                                        </div>
                                      </div>
                                    </div>
                                  ))
                                ) : (
                                  <p className="text-xs text-zinc-500">No shared tokens issued for this account.</p>
                                )}
                              </div>
                            </section>
                          ) : null}
                        </div>

                        <div className="space-y-4">
                          <section className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4">
                            <p className="text-sm font-medium text-zinc-100">Password</p>
                            <p className="mt-1 text-xs text-zinc-500">
                              8자 이상 비밀번호를 설정하면 계정 로그인으로 세션 토큰을 발급할 수 있습니다. 새로 설정하거나 재설정한
                              비밀번호는 첫 로그인 후 다시 변경해야 합니다.
                            </p>
                            <div className="mt-4 space-y-3">
                              <input
                                type="password"
                                value={passwordDraft}
                                onChange={(event) =>
                                  setPasswordDrafts((current) => ({ ...current, [account.id]: event.target.value }))
                                }
                                placeholder={account.hasPassword ? 'Reset password' : 'Set password'}
                                className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 focus:border-zinc-500 focus:outline-none"
                              />
                              <div className="flex gap-2">
                                <button
                                  type="button"
                                  onClick={() => void handleSetPassword(account.id)}
                                  disabled={!passwordDraft.trim()}
                                  className="flex-1 rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-500 disabled:bg-zinc-800 disabled:text-zinc-500"
                                >
                                  {account.hasPassword ? 'Reset Password' : 'Set Password'}
                                </button>
                                {account.hasPassword ? (
                                  <button
                                    type="button"
                                    onClick={() => void handleClearPassword(account.id)}
                                    className="rounded-lg border border-red-900/70 bg-red-950/20 px-3 py-2 text-sm text-red-200 transition-colors hover:bg-red-950/40"
                                  >
                                    Remove
                                  </button>
                                ) : null}
                              </div>
                            </div>
                          </section>

                          <section className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4">
                            <p className="text-sm font-medium text-zinc-100">Login Sessions</p>
                            <div className="mt-4 space-y-3">
                              {account.sessions.length ? (
                                account.sessions.map((session) => (
                                  <div key={session.id} className="rounded-xl border border-zinc-800 bg-zinc-950/70 p-3">
                                    <div className="flex items-start justify-between gap-3">
                                      <div className="min-w-0">
                                        <p className="truncate text-sm font-medium text-zinc-100">
                                          {session.label} <span className="text-zinc-500">({session.tokenPreview})</span>
                                        </p>
                                        <p className="mt-1 text-xs text-zinc-500">
                                          {session.status} · expires {formatDate(session.expiresAt)}
                                        </p>
                                        <p className="mt-1 text-[11px] text-zinc-600">
                                          created {formatDate(session.createdAt)} · last used {formatDate(session.lastUsedAt)}
                                        </p>
                                      </div>
                                      <div className="flex shrink-0 gap-2">
                                        {session.status === 'active' ? (
                                          <button
                                            type="button"
                                            onClick={() => void runAndRefresh(() => revokeAccessSession(session.id))}
                                            className="rounded-lg border border-amber-900/70 bg-amber-950/20 px-3 py-1.5 text-sm text-amber-200 transition-colors hover:bg-amber-950/40"
                                          >
                                            Revoke
                                          </button>
                                        ) : null}
                                        <button
                                          type="button"
                                          onClick={() => void runAndRefresh(() => deleteAccessSession(session.id))}
                                          className="rounded-lg border border-red-900/70 bg-red-950/20 px-3 py-1.5 text-sm text-red-200 transition-colors hover:bg-red-950/40"
                                        >
                                          Delete
                                        </button>
                                      </div>
                                    </div>
                                  </div>
                                ))
                              ) : (
                                <p className="text-xs text-zinc-500">No login sessions for this account.</p>
                              )}
                            </div>
                          </section>
                        </div>
                      </div>
                    </div>
                  )
                })
              ) : (
                <p className="text-sm text-zinc-500">Create an account first to enable direct login or issue scoped tokens.</p>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
