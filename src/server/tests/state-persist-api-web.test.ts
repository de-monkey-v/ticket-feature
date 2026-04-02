import test from 'node:test'
import assert from 'node:assert/strict'
import { createDefaultDirectState } from '../../web/lib/direct-state.js'
import { createDefaultExplainState } from '../../web/lib/explain-state.js'
import { saveDirectState } from '../../web/lib/direct-api.js'
import { saveExplainState } from '../../web/lib/explain-api.js'

const originalFetch = globalThis.fetch
const originalSessionStorage = globalThis.sessionStorage

function createSessionStorageMock(token: string): Storage {
  return {
    length: token ? 1 : 0,
    clear() {},
    getItem(key) {
      return key === 'intentlane-codex.auth-token' ? token : null
    },
    key(index) {
      return index === 0 && token ? 'intentlane-codex.auth-token' : null
    },
    removeItem() {},
    setItem() {},
  }
}

test('saveExplainState forwards keepalive requests with auth headers', async () => {
  const state = createDefaultExplainState('2026-04-01T00:00:00.000Z')
  let requestUrl = ''
  let requestInit: RequestInit | undefined

  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    value: createSessionStorageMock('explain-token'),
  })

  globalThis.fetch = async (input, init) => {
    requestUrl = typeof input === 'string' ? input : input.toString()
    requestInit = init
    return new Response(JSON.stringify(state), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
      },
    })
  }

  try {
    const saved = await saveExplainState('intentlane-codex', state, { keepalive: true })

    assert.equal(saved.selectedThreadId, state.selectedThreadId)
    assert.equal(requestUrl, '/api/explain/state')
    assert.equal(requestInit?.keepalive, true)
    assert.equal(new Headers(requestInit?.headers).get('Authorization'), 'Bearer explain-token')
  } finally {
    globalThis.fetch = originalFetch
    Object.defineProperty(globalThis, 'sessionStorage', {
      configurable: true,
      value: originalSessionStorage,
    })
  }
})

test('saveDirectState forwards keepalive requests with auth headers', async () => {
  const state = createDefaultDirectState('2026-04-01T00:00:00.000Z')
  let requestUrl = ''
  let requestInit: RequestInit | undefined

  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    value: createSessionStorageMock('direct-token'),
  })

  globalThis.fetch = async (input, init) => {
    requestUrl = typeof input === 'string' ? input : input.toString()
    requestInit = init
    return new Response(JSON.stringify(state), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
      },
    })
  }

  try {
    const saved = await saveDirectState('intentlane-codex', state, { keepalive: true })

    assert.equal(saved.selectedSessionId, state.selectedSessionId)
    assert.equal(requestUrl, '/api/direct/state')
    assert.equal(requestInit?.keepalive, true)
    assert.equal(new Headers(requestInit?.headers).get('Authorization'), 'Bearer direct-token')
  } finally {
    globalThis.fetch = originalFetch
    Object.defineProperty(globalThis, 'sessionStorage', {
      configurable: true,
      value: originalSessionStorage,
    })
  }
})
