import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useId, useState } from 'react'

interface MermaidDiagramProps {
  chart: string
}

const MERMAID_ERROR_SVG_PATTERNS = [
  /Syntax error in text/,
  /class="error-text"/,
  /class="error-icon"/,
]

function escapeMermaidLabelText(value: string) {
  return value
    .replace(/"/g, '&quot;')
    .replace(/\{/g, '&#123;')
    .replace(/\}/g, '&#125;')
}

function normalizeMermaidLabel(label: string) {
  const trimmed = label.trim()
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return `"${escapeMermaidLabelText(trimmed.slice(1, -1))}"`
  }

  return `"${escapeMermaidLabelText(label)}"`
}

function sanitizeMermaidSubgraphLine(line: string) {
  const match = /^(\s*subgraph\s+)(.+?)\s*$/.exec(line)
  if (!match) {
    return line
  }

  const prefix = match[1]
  const title = match[2]?.trim() ?? ''
  if (!title) {
    return line
  }

  const labeledSubgraphMatch = /^([A-Za-z0-9_-]+)\s+\[(.+)\]$/.exec(title)
  if (labeledSubgraphMatch) {
    const subgraphId = labeledSubgraphMatch[1]
    const label = labeledSubgraphMatch[2] ?? ''
    return `${prefix}${subgraphId}[${normalizeMermaidLabel(label)}]`
  }

  if (/^[A-Za-z0-9_-]+$/.test(title)) {
    return line
  }

  return `${prefix}${normalizeMermaidLabel(title)}`
}

function sanitizeMermaidFlowchartLine(line: string) {
  if (/^\s*%%/.test(line)) {
    return line
  }

  let sanitized = sanitizeMermaidSubgraphLine(line)

  sanitized = sanitized.replace(/(\b[A-Za-z0-9_-]+)\[\[([^\]\n]*)\]\]/g, (_match, nodeId: string, label: string) => {
    return `${nodeId}[[${normalizeMermaidLabel(label)}]]`
  })

  sanitized = sanitized.replace(/(\b[A-Za-z0-9_-]+)\(\[([^\]\n]*)\]\)/g, (_match, nodeId: string, label: string) => {
    return `${nodeId}([${normalizeMermaidLabel(label)}])`
  })

  sanitized = sanitized.replace(/(\b[A-Za-z0-9_-]+)\(\(([^)\n]*)\)\)/g, (_match, nodeId: string, label: string) => {
    return `${nodeId}((${normalizeMermaidLabel(label)}))`
  })

  sanitized = sanitized.replace(/(\b[A-Za-z0-9_-]+)\[(?!\[)([^\]\n]*)\]/g, (_match, nodeId: string, label: string) => {
    return `${nodeId}[${normalizeMermaidLabel(label)}]`
  })

  sanitized = sanitized.replace(/(\b[A-Za-z0-9_-]+)\((?!\(|\[)([^)\n]*)\)/g, (_match, nodeId: string, label: string) => {
    return `${nodeId}(${normalizeMermaidLabel(label)})`
  })

  sanitized = sanitized.replace(/(\b[A-Za-z0-9_-]+)\{([^}\n]*)\}/g, (_match, nodeId: string, label: string) => {
    return `${nodeId}{${normalizeMermaidLabel(label)}}`
  })

  sanitized = sanitized.replace(/\|([^|\n]+)\|/g, (_match, label: string) => {
    return `|${normalizeMermaidLabel(label)}|`
  })

  return sanitized
}

export function sanitizeMermaidChart(chart: string) {
  if (!/^\s*(flowchart|graph)\b/im.test(chart)) {
    return chart
  }

  return chart
    .split('\n')
    .map((line) => sanitizeMermaidFlowchartLine(line))
    .join('\n')
}

export function isMermaidErrorSvg(svg: string) {
  return MERMAID_ERROR_SVG_PATTERNS.some((pattern) => pattern.test(svg))
}

function cleanupMermaidRenderArtifacts(renderId: string) {
  document.getElementById(`d${renderId}`)?.remove()
  document.getElementById(renderId)?.remove()
}

export function getMermaidRenderCandidates(chart: string) {
  const sanitizedChart = sanitizeMermaidChart(chart)
  return sanitizedChart === chart ? [chart] : [chart, sanitizedChart]
}

export function MermaidDiagram({ chart }: MermaidDiagramProps) {
  const diagramId = useId().replace(/:/g, '-')
  const [svg, setSvg] = useState('')
  const [showFallback, setShowFallback] = useState(false)
  const [isExpanded, setIsExpanded] = useState(false)

  useEffect(() => {
    let cancelled = false

    async function renderDiagram() {
      try {
        const mermaid = (await import('mermaid')).default
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: 'dark',
        })

        let lastError: unknown = null

        for (const [index, candidate] of getMermaidRenderCandidates(chart).entries()) {
          const renderId = `mermaid-${diagramId}-${Date.now()}-${index}`
          try {
            const { svg } = await mermaid.render(renderId, candidate)
            if (isMermaidErrorSvg(svg)) {
              throw new Error('Mermaid returned an error diagram')
            }

            if (!cancelled) {
              setSvg(svg)
              setShowFallback(false)
            }
            return
          } catch (error) {
            lastError = error
          } finally {
            cleanupMermaidRenderArtifacts(renderId)
          }
        }

        throw lastError
      } catch (error) {
        if (!cancelled) {
          setSvg('')
          setShowFallback(true)
          console.warn('Mermaid diagram render failed, falling back to text view.', error)
        }
      }
    }

    void renderDiagram()

    return () => {
      cancelled = true
    }
  }, [chart, diagramId])

  useEffect(() => {
    if (!isExpanded) {
      return
    }

    const previousOverflow = document.body.style.overflow
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsExpanded(false)
      }
    }

    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', handleKeyDown)

    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [isExpanded])

  function openExpanded() {
    setIsExpanded(true)
  }

  function closeExpanded() {
    setIsExpanded(false)
  }

  function handleTriggerKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      openExpanded()
    }
  }

  if (showFallback) {
    return (
      <div className="my-4 rounded-xl border border-amber-800 bg-amber-950/30 p-4">
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-amber-300">
          Mermaid Fallback
        </p>
        <p className="mb-3 text-sm text-amber-200">
          다이어그램 문법을 해석하지 못해 원문을 텍스트로 표시합니다.
        </p>
        <pre className="overflow-hidden rounded-lg border border-zinc-700 bg-zinc-900 p-4 text-xs text-zinc-200 whitespace-pre-wrap break-words">
          <code>{chart}</code>
        </pre>
      </div>
    )
  }

  if (!svg) {
    return (
      <div className="my-4 rounded-xl border border-zinc-800 bg-zinc-900/70 px-4 py-6 text-center text-sm text-zinc-400">
        다이어그램을 렌더링하는 중...
      </div>
    )
  }

  return (
    <>
      <div
        role="button"
        tabIndex={0}
        aria-label="다이어그램 확대해서 보기"
        className="group relative my-4 w-full min-w-0 rounded-xl border border-zinc-800 bg-zinc-950/80 outline-none focus-visible:ring-2 focus-visible:ring-blue-500/70 focus-visible:ring-inset"
        onClick={openExpanded}
        onKeyDown={handleTriggerKeyDown}
      >
        <div className="pointer-events-none absolute right-3 top-3 z-10 rounded-full border border-zinc-700 bg-zinc-900/90 px-2 py-1 text-[11px] font-medium text-zinc-300 opacity-0 transition group-hover:opacity-100 group-focus-within:opacity-100 select-none">
          클릭해서 확대
        </div>
        <div
          className="w-full min-w-0 cursor-zoom-in overflow-auto p-4 [&_svg]:pointer-events-none [&_svg]:block [&_svg]:h-auto [&_svg]:min-w-full [&_svg]:max-w-none [&_svg]:overflow-visible"
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </div>
      {isExpanded ? (
        <div
          className="fixed inset-0 z-50 overflow-y-auto overflow-x-hidden bg-black/80 p-4 backdrop-blur-sm sm:p-8"
          role="dialog"
          aria-modal="true"
          aria-label="확대된 다이어그램"
          onClick={closeExpanded}
        >
          <div
            className="mx-auto flex h-full w-full max-w-[min(96vw,1600px)] flex-col overflow-hidden rounded-2xl border border-zinc-700 bg-zinc-950 shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
              <p className="text-sm font-medium text-zinc-100">다이어그램 확대 보기</p>
              <button
                type="button"
                autoFocus
                className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-200 transition hover:border-zinc-500 hover:bg-zinc-900"
                onClick={closeExpanded}
              >
                닫기
              </button>
            </div>
            <div className="flex-1 overflow-auto p-4 sm:p-6">
              <div className="inline-block min-w-full rounded-xl border border-zinc-800 bg-zinc-950/80 p-4 [&_svg]:block [&_svg]:h-auto [&_svg]:max-w-none [&_svg]:overflow-visible">
                <div dangerouslySetInnerHTML={{ __html: svg }} />
              </div>
            </div>
            <div className="border-t border-zinc-800 px-4 py-2 text-xs text-zinc-400">
              배경을 클릭하거나 Esc 키를 누르면 닫힙니다.
            </div>
          </div>
        </div>
      ) : null}
    </>
  )
}
