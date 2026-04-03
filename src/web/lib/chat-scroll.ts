import type { ChatInitialScrollTarget } from './api'

export const CHAT_INITIAL_SCROLL_TARGET_OPTIONS: Array<{
  id: ChatInitialScrollTarget
  label: string
}> = [
  {
    id: 'bottom',
    label: '맨 아래',
  },
  {
    id: 'last_user_message',
    label: '마지막 내 메시지',
  },
]

export function getLastUserMessageId(messages: Array<{ id: string; role: 'user' | 'assistant' }>) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') {
      return messages[index]!.id
    }
  }

  return null
}
