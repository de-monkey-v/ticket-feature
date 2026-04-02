import type { FormEvent } from 'react'
import { useState } from 'react'

interface PasswordChangeViewProps {
  accountName?: string
  error?: string | null
  onLogout?: () => Promise<void> | void
  onSubmit: (currentPassword: string, newPassword: string) => Promise<void>
}

export function PasswordChangeView({ accountName, error, onLogout, onSubmit }: PasswordChangeViewProps) {
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [localError, setLocalError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  const submit = async () => {
    if (isSubmitting) {
      return
    }

    const current = currentPassword.trim()
    const next = newPassword.trim()
    const confirm = confirmPassword.trim()

    if (!current || !next || !confirm) {
      setLocalError('현재 비밀번호와 새 비밀번호를 모두 입력하세요.')
      return
    }

    if (next.length < 8) {
      setLocalError('새 비밀번호는 8자 이상이어야 합니다.')
      return
    }

    if (next !== confirm) {
      setLocalError('새 비밀번호 확인이 일치하지 않습니다.')
      return
    }

    setLocalError(null)
    setIsSubmitting(true)
    try {
      await onSubmit(current, next)
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
    } finally {
      setIsSubmitting(false)
    }
  }

  const displayError = localError || error
  const isSubmitDisabled = !currentPassword.trim() || !newPassword.trim() || !confirmPassword.trim() || isSubmitting

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    void submit()
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex items-center justify-center p-6">
      <div className="w-full max-w-xl rounded-3xl border border-zinc-800 bg-zinc-900 shadow-2xl p-8">
        <p className="text-xs uppercase tracking-[0.24em] text-zinc-500 mb-3">Password Update Required</p>
        <h1 className="text-3xl font-semibold text-zinc-50">비밀번호를 먼저 변경해야 합니다</h1>
        <p className="mt-3 text-sm leading-6 text-zinc-400">
          {accountName ? `${accountName} 계정은 첫 로그인 후 비밀번호 변경이 필요합니다.` : '첫 로그인 후 비밀번호 변경이 필요합니다.'}
        </p>

        <form className="mt-8 space-y-3" onSubmit={handleSubmit}>
          <input
            type="password"
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
            placeholder="Current password"
            className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-4 py-3 text-sm focus:border-emerald-500 focus:outline-none"
          />
          <input
            type="password"
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
            placeholder="New password"
            className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-4 py-3 text-sm focus:border-emerald-500 focus:outline-none"
          />
          <input
            type="password"
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
            placeholder="Confirm new password"
            className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-4 py-3 text-sm focus:border-emerald-500 focus:outline-none"
          />
          <div className="flex gap-3">
            <button
              type="submit"
              disabled={isSubmitDisabled}
              className="flex-1 rounded-lg bg-emerald-600 px-4 py-3 text-sm font-medium text-white transition-colors hover:bg-emerald-500 disabled:bg-zinc-800 disabled:text-zinc-500"
            >
              {isSubmitting ? 'Updating…' : 'Update Password'}
            </button>
            {onLogout ? (
              <button
                type="button"
                onClick={() => void onLogout()}
                disabled={isSubmitting}
                className="rounded-lg border border-zinc-700 bg-zinc-950 px-4 py-3 text-sm font-medium text-zinc-200 transition-colors hover:bg-zinc-900 disabled:border-zinc-800 disabled:text-zinc-500"
              >
                Logout
              </button>
            ) : null}
          </div>
        </form>

        {displayError ? (
          <div className="mt-4 rounded-2xl border border-red-900/70 bg-red-950/20 px-4 py-3 text-sm text-red-200">
            {displayError}
          </div>
        ) : null}
      </div>
    </div>
  )
}
