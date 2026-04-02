import { isValidElement, type ComponentProps } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { MermaidDiagram } from './MermaidDiagram'

interface MarkdownContentProps {
  content: string
}

const markdownClassName =
  'min-w-0 w-full max-w-none break-words text-sm leading-6 text-zinc-200 [&_a]:break-words [&_a]:text-blue-300 [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:border-zinc-700 [&_blockquote]:pl-4 [&_blockquote]:text-zinc-400 [&_code]:break-words [&_code]:text-blue-300 [&_h1]:mb-3 [&_h1]:mt-5 [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:mb-3 [&_h2]:mt-5 [&_h2]:text-base [&_h2]:font-semibold [&_h3]:mb-2 [&_h3]:mt-4 [&_h3]:font-semibold [&_li]:my-1 [&_ol]:my-3 [&_ol]:pl-5 [&_p]:my-3 [&_pre]:my-4 [&_pre]:max-w-full [&_pre]:overflow-hidden [&_pre]:rounded-xl [&_pre]:border [&_pre]:border-zinc-700 [&_pre]:bg-zinc-800 [&_pre]:p-4 [&_pre]:whitespace-pre-wrap [&_pre]:break-words [&_pre_code]:whitespace-pre-wrap [&_pre_code]:break-words [&_table]:my-4 [&_table]:w-full [&_table]:table-fixed [&_table]:border-collapse [&_tbody_tr:nth-child(even)]:bg-zinc-900/60 [&_td]:border [&_td]:border-zinc-800 [&_td]:px-3 [&_td]:py-2 [&_td]:align-top [&_td]:break-words [&_th]:border [&_th]:border-zinc-700 [&_th]:bg-zinc-800/90 [&_th]:px-3 [&_th]:py-2 [&_th]:text-left [&_th]:font-semibold [&_th]:break-words [&_ul]:my-3 [&_ul]:list-disc [&_ul]:pl-5'

function renderCode({
  inline,
  className,
  children,
  ...props
}: ComponentProps<'code'> & { inline?: boolean }) {
  const match = /language-([\w-]+)/.exec(className || '')
  const language = match?.[1]?.toLowerCase()
  const value = String(children).replace(/\n$/, '')

  if (!inline && language === 'mermaid') {
    return <MermaidDiagram chart={value} />
  }

  return (
    <code className={className} {...props}>
      {children}
    </code>
  )
}

function renderPre({ children, ...props }: ComponentProps<'pre'>) {
  if (isValidElement(children) && children.type === MermaidDiagram) {
    return children
  }

  return <pre {...props}>{children}</pre>
}

export function MarkdownContent({ content }: MarkdownContentProps) {
  return (
    <div className={markdownClassName}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code: renderCode,
          pre: renderPre,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}
