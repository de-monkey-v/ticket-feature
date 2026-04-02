interface SessionInfo {
  projectPath: string
  mode: 'explain' | 'ticket'
  ticketId?: string
}

const sessions = new Map<string, SessionInfo>()

export function getSession(sessionId: string): SessionInfo | undefined {
  return sessions.get(sessionId)
}

export function setSession(sessionId: string, info: SessionInfo): void {
  sessions.set(sessionId, info)
}

export function deleteSession(sessionId: string): void {
  sessions.delete(sessionId)
}
