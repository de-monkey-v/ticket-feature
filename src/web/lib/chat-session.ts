export type ChatRole = 'user' | 'assistant'

export interface ChatMessageRecord {
  id: string
  role: ChatRole
  content: string
}

type MessageIdFactory = () => string

function defaultMessageIdFactory() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }

  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isChatRole(value: unknown): value is ChatRole {
  return value === 'user' || value === 'assistant'
}

export function createChatMessage(
  role: ChatRole,
  content: string,
  idFactory: MessageIdFactory = defaultMessageIdFactory
): ChatMessageRecord {
  return {
    id: idFactory(),
    role,
    content,
  }
}

export function normalizeStoredMessages(
  messages: unknown,
  idFactory: MessageIdFactory = defaultMessageIdFactory
): ChatMessageRecord[] {
  if (!Array.isArray(messages)) {
    return []
  }

  return messages.flatMap((message) => {
    if (!isRecord(message) || !isChatRole(message.role) || typeof message.content !== 'string') {
      return []
    }

    return [
      {
        id: typeof message.id === 'string' && message.id.trim() ? message.id : idFactory(),
        role: message.role,
        content: message.content,
      },
    ]
  })
}

export function buildNextExplainMessages(
  previousMessages: ChatMessageRecord[],
  userContent: string,
  options?: {
    editMessageId?: string
    idFactory?: MessageIdFactory
  }
) {
  const trimmedContent = userContent.trim()
  if (!trimmedContent) {
    throw new Error('User message is required')
  }

  const idFactory = options?.idFactory ?? defaultMessageIdFactory
  const editIndex = options?.editMessageId
    ? previousMessages.findIndex(
        (message) => message.id === options.editMessageId && message.role === 'user'
      )
    : -1

  const baseMessages = editIndex >= 0 ? previousMessages.slice(0, editIndex) : previousMessages
  const userMessage = createChatMessage('user', trimmedContent, idFactory)
  const assistantMessage = createChatMessage('assistant', '', idFactory)

  return {
    baseMessages,
    userMessage,
    assistantMessage,
    messages: [...baseMessages, userMessage, assistantMessage],
    truncated: editIndex >= 0,
  }
}

export function shouldBypassRequestInterceptForExplain(userContent: string, interceptedContent: string | null) {
  const trimmedContent = userContent.trim()
  const trimmedIntercept = interceptedContent?.trim()

  if (!trimmedContent || !trimmedIntercept || trimmedContent === trimmedIntercept) {
    return false
  }

  const normalized = trimmedContent.toLowerCase()
  const explainOnlyPatterns = [
    /그냥\s*(?:설명|explain)/,
    /(?:설명|explain)\s*(?:만|으로|해|해주세요|해줘|부탁)/,
    /설명부터/,
    /just\s+explain/,
    /explain\s+only/,
    /keep\s+in\s+explain/,
  ]
  const declineRequestPatterns = [
    /(?:request|draft|ticket|요청|request|draft|티켓).*(?:말고|말아|아니|아님|필요\s*없|원치\s*않)/,
    /(?:말고|말아|아니|아님|필요\s*없|원치\s*않).*(?:request|draft|ticket|요청|티켓)/,
  ]

  return (
    explainOnlyPatterns.some((pattern) => pattern.test(normalized)) ||
    declineRequestPatterns.some((pattern) => pattern.test(normalized))
  )
}

export function shouldInterceptImplementationRequestForExplain(
  userContent: string,
  interceptImplementationRequests: boolean
) {
  if (!interceptImplementationRequests) {
    return false
  }

  const normalized = userContent.trim().toLowerCase()
  if (!normalized) {
    return false
  }

  const actionPatterns = [
    /구현/,
    /수정/,
    /변경/,
    /추가/,
    /고쳐/,
    /만들/,
    /리팩토링/,
    /붙여/,
    /연결/,
    /적용/,
    /\bimplement\b/,
    /\bfix\b/,
    /\bbuild\b/,
    /\bcreate\b/,
    /\badd\b/,
    /\bmodify\b/,
    /\bupdate\b/,
    /\brefactor\b/,
  ]
  const contextPatterns = [
    /버튼/,
    /기능/,
    /화면/,
    /ui/,
    /api/,
    /컴포넌트/,
    /페이지/,
    /코드/,
    /파일/,
    /hook/,
    /route/,
    /테스트/,
    /동작/,
  ]

  return actionPatterns.some((pattern) => pattern.test(normalized)) &&
    contextPatterns.some((pattern) => pattern.test(normalized))
}
