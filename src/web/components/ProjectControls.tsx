import { useEffect, useState } from 'react'
import {
  browseProjectDirectories,
  createProject,
  deleteProject,
  inferProjectName,
  type AppConfig,
  type ProjectBrowserResult,
} from '../lib/api'
import { clearLegacyExplainState } from '../lib/explain-state'

interface ProjectControlsProps {
  authSession: AppConfig['auth']['session']
  projects: AppConfig['allowedProjects']
  projectId: string
  onProjectChange: (projectId: string) => void
  onConfigUpdated: (nextDefaultProjectId?: string) => Promise<void> | void
  variant?: 'header' | 'sidebar'
}

export function ProjectControls({
  authSession,
  projects,
  projectId,
  onProjectChange,
  onConfigUpdated,
  variant = 'sidebar',
}: ProjectControlsProps) {
  const [newProjectLabel, setNewProjectLabel] = useState('')
  const [newProjectPath, setNewProjectPath] = useState('')
  const [projectPickerMessage, setProjectPickerMessage] = useState<string | null>(null)
  const [isManageDialogOpen, setIsManageDialogOpen] = useState(false)
  const [isCreatingProject, setIsCreatingProject] = useState(false)
  const [isDeletingProject, setIsDeletingProject] = useState(false)
  const [isProjectBrowserLoading, setIsProjectBrowserLoading] = useState(false)
  const [projectBrowser, setProjectBrowser] = useState<ProjectBrowserResult | null>(null)

  useEffect(() => {
    if (!isManageDialogOpen) {
      return
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsManageDialogOpen(false)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [isManageDialogOpen])

  const selectedProject = projects.find((project) => project.id === projectId)
  const orderedProjects = selectedProject
    ? [selectedProject, ...projects.filter((project) => project.id !== selectedProject.id)]
    : projects

  const handleCloseManageDialog = () => {
    setProjectPickerMessage(null)
    setIsManageDialogOpen(false)
  }

  const loadProjectBrowser = async (path?: string) => {
    setProjectPickerMessage(null)
    setIsProjectBrowserLoading(true)

    try {
      const result = await browseProjectDirectories(path)
      setProjectBrowser(result)
    } catch (error) {
      setProjectBrowser(null)
      const message = error instanceof Error ? error.message : 'Unable to browse folders'
      setProjectPickerMessage(message)
    } finally {
      setIsProjectBrowserLoading(false)
    }
  }

  const handleOpenManageDialog = async () => {
    setProjectPickerMessage(null)
    setIsManageDialogOpen(true)
    await loadProjectBrowser(newProjectPath.trim() || undefined)
  }

  const handleSelectFolder = async (path: string) => {
    setProjectPickerMessage(null)
    setNewProjectPath(path)

    if (!newProjectLabel.trim()) {
      try {
        const result = await inferProjectName(path)
        setNewProjectLabel(result.label)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unable to infer project alias'
        setProjectPickerMessage(message)
      }
    }
  }

  const handleCreateProject = async () => {
    if (!newProjectLabel.trim() || !newProjectPath.trim() || isCreatingProject) {
      return
    }

    setIsCreatingProject(true)
    setProjectPickerMessage(null)

    try {
      const config = await createProject({
        label: newProjectLabel,
        path: newProjectPath,
      })
      const createdProject = config.allowedProjects.find((project) => project.label === newProjectLabel.trim())
      setNewProjectLabel('')
      setNewProjectPath('')
      setProjectPickerMessage(null)
      setProjectBrowser(null)
      handleCloseManageDialog()
      void Promise.resolve(onConfigUpdated(createdProject?.id)).catch((error) => {
        console.error('Failed to refresh config after creating project:', error)
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to add project'
      setProjectPickerMessage(message)
    } finally {
      setIsCreatingProject(false)
    }
  }

  const handleDeleteProject = async () => {
    if (!selectedProject?.deletable || isDeletingProject) {
      return
    }

    setProjectPickerMessage(null)
    setIsDeletingProject(true)

    try {
      await deleteProject(selectedProject.id)
      clearLegacyExplainState(selectedProject.id)
      handleCloseManageDialog()
      await onConfigUpdated()
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to delete project'
      setProjectPickerMessage(message)
    } finally {
      setIsDeletingProject(false)
    }
  }

  const projectSelect = (
    <select
      value={projectId}
      onChange={(event) => onProjectChange(event.target.value)}
      disabled={projects.length === 0}
      className={
        variant === 'header'
          ? 'w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-200 focus:border-zinc-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60'
          : 'w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm focus:border-zinc-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60'
      }
    >
      {projects.length === 0 ? <option value="">No accessible projects</option> : null}
      {orderedProjects.map((project) => (
        <option key={project.id} value={project.id}>
          {project.label}
        </option>
      ))}
    </select>
  )

  return (
    <>
      {variant === 'header' ? (
        <div className="flex w-full flex-col gap-2 sm:flex-row sm:items-end sm:gap-3 lg:w-auto">
          <div className="min-w-0 sm:min-w-[240px]">
            <label className="mb-1 block text-[11px] font-medium uppercase tracking-[0.18em] text-zinc-500">
              Current Project
            </label>
            {projectSelect}
          </div>
          {authSession.isAdmin ? (
            <button
              type="button"
              onClick={() => void handleOpenManageDialog()}
              disabled={isCreatingProject || isDeletingProject}
              className="shrink-0 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-200 transition-colors hover:border-zinc-600 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-60"
            >
              Manage Projects
            </button>
          ) : null}
        </div>
      ) : (
        <>
          <div className="border-b border-zinc-800 p-3">
            <label className="mb-1 block text-xs text-zinc-400">Current Project</label>
            {projectSelect}
          </div>

          {authSession.isAdmin ? (
            <div className="border-b border-zinc-800 p-3">
              <label className="mb-2 block text-xs text-zinc-400">Add &amp; Manage Projects</label>
              <button
                type="button"
                onClick={() => void handleOpenManageDialog()}
                disabled={isCreatingProject || isDeletingProject}
                className="w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-200 transition-colors hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-60"
              >
                Manage Projects
              </button>
            </div>
          ) : null}
        </>
      )}

      {isManageDialogOpen ? (
        <div
          className="fixed inset-0 z-50 overflow-y-auto overflow-x-hidden bg-black/80 p-4 backdrop-blur-sm sm:p-8"
          role="dialog"
          aria-modal="true"
          aria-label="프로젝트 관리"
          onClick={handleCloseManageDialog}
        >
          <div
            className="mx-auto flex min-h-[min(88vh,820px)] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-zinc-700 bg-zinc-950 shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4 border-b border-zinc-800 px-5 py-4">
              <div className="min-w-0">
                <p className="text-sm font-medium text-zinc-100">Manage Projects</p>
                <p className="mt-1 text-xs text-zinc-500">
                  폴더를 고르고 alias를 확인해 새 프로젝트를 추가하거나 현재 프로젝트를 관리합니다.
                </p>
              </div>
              <button
                type="button"
                autoFocus
                className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-200 transition hover:border-zinc-500 hover:bg-zinc-900"
                onClick={handleCloseManageDialog}
              >
                닫기
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-5 py-4">
              <div className="grid gap-4 lg:grid-cols-[minmax(0,1.15fr)_minmax(280px,0.85fr)]">
                <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-zinc-500">
                        Folder Browser
                      </p>
                      <p className="mt-1 break-all text-xs text-zinc-400">
                        {projectBrowser?.currentPath ?? 'Loading folders...'}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => void loadProjectBrowser(projectBrowser?.currentPath)}
                      disabled={isProjectBrowserLoading}
                      className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300 transition-colors hover:bg-zinc-800 disabled:text-zinc-500"
                    >
                      Refresh
                    </button>
                  </div>

                  <div className="mt-3 flex gap-2">
                    <button
                      type="button"
                      onClick={() => projectBrowser?.parentPath && void loadProjectBrowser(projectBrowser.parentPath)}
                      disabled={!projectBrowser?.parentPath || isProjectBrowserLoading}
                      className="flex-1 rounded border border-zinc-700 px-2 py-1.5 text-xs text-zinc-300 transition-colors hover:bg-zinc-800 disabled:text-zinc-500"
                    >
                      Up One Level
                    </button>
                    <button
                      type="button"
                      onClick={() => projectBrowser?.currentPath && void handleSelectFolder(projectBrowser.currentPath)}
                      disabled={!projectBrowser?.currentPath || isProjectBrowserLoading}
                      className="flex-1 rounded bg-zinc-800 px-2 py-1.5 text-xs text-zinc-200 transition-colors hover:bg-zinc-700 disabled:text-zinc-500"
                    >
                      Select This Folder
                    </button>
                  </div>

                  <div className="mt-3 rounded border border-zinc-800 bg-zinc-950/60">
                    {isProjectBrowserLoading ? (
                      <p className="px-2 py-3 text-xs text-zinc-500">Loading folders…</p>
                    ) : projectBrowser && projectBrowser.entries.length > 0 ? (
                      <div className="max-h-[52vh] overflow-y-auto p-1">
                        {projectBrowser.entries.map((entry) => (
                          <button
                            key={entry.path}
                            type="button"
                            onClick={() => void loadProjectBrowser(entry.path)}
                            className="flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-sm text-zinc-200 transition-colors hover:bg-zinc-800"
                          >
                            <span className="truncate">{entry.name}</span>
                            <span className="text-xs text-zinc-500">Open</span>
                          </button>
                        ))}
                      </div>
                    ) : (
                      <p className="px-2 py-3 text-xs text-zinc-500">No folders found here.</p>
                    )}
                  </div>
                </div>

                <div className="space-y-3">
                  <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-3">
                    <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-zinc-500">Project Info</p>
                    <div className="mt-3 space-y-3">
                      <div>
                        <label className="mb-1 block text-xs text-zinc-400">Project alias</label>
                        <input
                          value={newProjectLabel}
                          onChange={(event) => setNewProjectLabel(event.target.value)}
                          placeholder="Project alias"
                          className="w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm focus:border-zinc-500 focus:outline-none"
                        />
                      </div>
                      <div>
                        <label className="mb-1 block text-xs text-zinc-400">Project folder path</label>
                        <input
                          value={newProjectPath}
                          onChange={(event) => setNewProjectPath(event.target.value)}
                          placeholder="Project folder path"
                          className="w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm focus:border-zinc-500 focus:outline-none"
                        />
                      </div>
                    </div>
                  </div>

                  <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-3">
                    <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-zinc-500">Current Project</p>
                    <p className="mt-3 text-sm text-zinc-200">{selectedProject?.label ?? 'No project selected'}</p>
                    <p className="mt-1 break-all text-xs text-zinc-500">{selectedProject?.id ?? '선택된 프로젝트가 없습니다.'}</p>
                    {selectedProject?.deletable ? (
                      <button
                        type="button"
                        onClick={() => void handleDeleteProject()}
                        disabled={isDeletingProject || isCreatingProject}
                        className="mt-3 w-full rounded border border-red-900/60 bg-red-950/20 px-2 py-1.5 text-sm text-red-200 transition-colors hover:bg-red-950/40 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {isDeletingProject ? 'Deleting…' : 'Delete Current Project'}
                      </button>
                    ) : selectedProject ? (
                      <p className="mt-3 text-xs text-zinc-500">현재 프로젝트는 삭제할 수 없습니다.</p>
                    ) : null}
                  </div>

                  <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
                    <p className="text-xs text-zinc-400">
                      폴더를 선택하면 alias가 비어 있을 때 자동으로 이름을 제안합니다.
                    </p>
                    {projectPickerMessage ? <p className="mt-2 text-xs text-zinc-500">{projectPickerMessage}</p> : null}
                  </div>
                </div>
              </div>
            </div>

            <div className="flex items-center justify-between gap-3 border-t border-zinc-800 px-5 py-4">
              <p className="text-xs text-zinc-500">배경을 클릭하거나 Esc 키를 누르면 닫힙니다.</p>
              <div className="flex gap-2">
                <button
                  type="button"
                  className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 transition hover:border-zinc-500 hover:bg-zinc-900"
                  onClick={handleCloseManageDialog}
                >
                  취소
                </button>
                <button
                  type="button"
                  onClick={() => void handleCreateProject()}
                  disabled={!newProjectLabel.trim() || !newProjectPath.trim() || isCreatingProject || isDeletingProject}
                  className="rounded-lg bg-zinc-800 px-3 py-1.5 text-sm text-zinc-100 transition hover:bg-zinc-700 disabled:text-zinc-500"
                >
                  {isCreatingProject ? 'Adding…' : 'Add Project'}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </>
  )
}
