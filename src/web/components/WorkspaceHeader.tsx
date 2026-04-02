import type { ReactNode } from 'react'
import type { AppConfig } from '../lib/api'
import { ProjectControls } from './ProjectControls'

interface WorkspaceHeaderProps {
  authSession: AppConfig['auth']['session']
  projects: AppConfig['allowedProjects']
  projectId: string
  onProjectChange: (projectId: string) => void
  onConfigUpdated: (nextDefaultProjectId?: string) => Promise<void> | void
  title: string
  subtitle: string
  controls?: ReactNode
}

export function WorkspaceHeader({
  authSession,
  projects,
  projectId,
  onProjectChange,
  onConfigUpdated,
  title,
  subtitle,
  controls,
}: WorkspaceHeaderProps) {
  return (
    <div className="border-b border-zinc-800 px-6 py-3">
      <div className="flex w-full flex-col gap-3 lg:flex-row lg:flex-wrap lg:items-end">
        <ProjectControls
          authSession={authSession}
          projects={projects}
          projectId={projectId}
          onProjectChange={onProjectChange}
          onConfigUpdated={onConfigUpdated}
          variant="header"
        />
        <div className="min-w-0 lg:border-l lg:border-zinc-800 lg:pl-4">
          <p className="text-sm font-medium text-zinc-200">{title}</p>
          <p className="text-xs text-zinc-500">{subtitle}</p>
        </div>
        {controls ? <div className="flex flex-wrap items-center gap-2">{controls}</div> : null}
      </div>
    </div>
  )
}
