const TOKEN_STORAGE_KEY = 'intentlane-codex.auth-token'
export const UNAUTHORIZED_EVENT = 'intentlane-codex:unauthorized'

export class UnauthorizedError extends Error {
  constructor(message = 'Unauthorized') {
    super(message)
    this.name = 'UnauthorizedError'
  }
}

function dispatchUnauthorized() {
  window.dispatchEvent(new Event(UNAUTHORIZED_EVENT))
}

export function getAuthToken(): string {
  return sessionStorage.getItem(TOKEN_STORAGE_KEY) || ''
}

export function setAuthToken(token: string): void {
  sessionStorage.setItem(TOKEN_STORAGE_KEY, token)
}

export function clearAuthToken(): void {
  sessionStorage.removeItem(TOKEN_STORAGE_KEY)
}

export async function authorizedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers)
  const token = getAuthToken()

  if (token) {
    headers.set('Authorization', `Bearer ${token}`)
  }

  const response = await fetch(input, {
    ...init,
    headers,
  })

  if (response.status === 401) {
    dispatchUnauthorized()
    throw new UnauthorizedError()
  }

  return response
}
