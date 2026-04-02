import { useState } from 'react'

interface LoginViewProps {
  error?: string | null
  onAccountSubmit: (name: string, password: string) => Promise<void>
}

export function LoginView({ error, onAccountSubmit }: LoginViewProps) {
  const [accountName, setAccountName] = useState('')
  const [password, setPassword] = useState('')
  const [isSubmittingAccount, setIsSubmittingAccount] = useState(false)

  const submitAccount = async () => {
    const name = accountName.trim()
    const nextPassword = password.trim()
    if (!name || !nextPassword || isSubmittingAccount) {
      return
    }

    setIsSubmittingAccount(true)
    try {
      await onAccountSubmit(name, nextPassword)
    } finally {
      setIsSubmittingAccount(false)
    }
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex items-center justify-center p-6">
      <div className="w-full max-w-4xl rounded-3xl border border-zinc-800 bg-zinc-900 shadow-2xl overflow-hidden">
        <div className="grid gap-px bg-zinc-800 lg:grid-cols-[1.1fr_1fr]">
          <div className="bg-zinc-950/80 p-8">
            <p className="text-xs uppercase tracking-[0.24em] text-zinc-500 mb-3">Intentlane</p>
            <h1 className="text-3xl font-semibold text-zinc-50">Remote Access</h1>
            <p className="mt-3 max-w-md text-sm leading-6 text-zinc-400">
              일반 사용자는 계정으로 로그인합니다. 권한과 프로젝트 범위는 계정에 연결된 설정을 그대로 따릅니다.
            </p>

            <section className="mt-8 rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5">
              <p className="text-sm font-medium text-zinc-100">계정 로그인</p>
              <p className="mt-1 text-xs text-zinc-500">
                로그인하면 계정에 연결된 프로젝트 범위와 기능 권한으로 세션이 발급됩니다.
              </p>

              <div className="mt-4 space-y-3">
                <input
                  type="text"
                  value={accountName}
                  onChange={(event) => setAccountName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      void submitAccount()
                    }
                  }}
                  placeholder="Account name"
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-4 py-3 text-sm focus:border-emerald-500 focus:outline-none"
                />

                <input
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      void submitAccount()
                    }
                  }}
                  placeholder="Password"
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-4 py-3 text-sm focus:border-emerald-500 focus:outline-none"
                />

                <button
                  onClick={() => void submitAccount()}
                  disabled={!accountName.trim() || !password.trim() || isSubmittingAccount}
                  className="w-full rounded-lg bg-emerald-600 px-4 py-3 text-sm font-medium text-white transition-colors hover:bg-emerald-500 disabled:bg-zinc-800 disabled:text-zinc-500"
                >
                  {isSubmittingAccount ? 'Signing in…' : 'Sign In'}
                </button>
              </div>
            </section>
          </div>

          <div className="bg-zinc-900/80 p-8">
            <div className="rounded-2xl border border-zinc-800 bg-zinc-950/70 p-6">
              <p className="text-xs uppercase tracking-[0.22em] text-zinc-500">Access Model</p>
              <div className="mt-5 space-y-4 text-sm leading-6 text-zinc-300">
                <p>계정 로그인은 계정 자체에 지정된 프로젝트 범위와 권한을 그대로 사용합니다.</p>
                <p>권한 변경은 토큰 재배포 대신 계정 설정만 바꾸면 되므로 운영 흐름이 더 단순합니다.</p>
                <p>토큰은 여전히 지원하지만 일반 로그인 화면에는 노출하지 않고, 관리자의 Access 화면 고급 섹션에서만 다룹니다.</p>
              </div>
            </div>

            {error ? (
              <div className="mt-4 rounded-2xl border border-red-900/70 bg-red-950/20 px-4 py-3 text-sm text-red-200">
                {error}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  )
}
