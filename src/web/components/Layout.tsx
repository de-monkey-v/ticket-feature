import type { ReactNode } from 'react'

interface LayoutProps {
  sidebar: ReactNode
  secondarySidebar?: ReactNode
  children: ReactNode
}

export function Layout({ sidebar, secondarySidebar, children }: LayoutProps) {
  return (
    <div className="flex h-screen bg-zinc-950 text-zinc-100">
      <aside className="w-72 border-r border-zinc-800 flex flex-col">
        {sidebar}
      </aside>
      <div className="flex min-w-0 flex-1 overflow-hidden">
        <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {children}
        </main>
        {secondarySidebar ? (
          <aside className="shrink-0 border-l border-zinc-800 bg-zinc-950/90">
            {secondarySidebar}
          </aside>
        ) : null}
      </div>
    </div>
  )
}
