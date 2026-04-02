import test from 'node:test'
import assert from 'node:assert/strict'
import {
  getCompletedRepliesStorageKey,
  loadCompletedRepliesState,
  saveCompletedRepliesState,
} from '../../web/lib/completed-replies-state.js'

const originalSessionStorage = globalThis.sessionStorage

function createSessionStorageMock(initialEntries?: Record<string, string>): Storage {
  const store = new Map(Object.entries(initialEntries ?? {}))

  return {
    get length() {
      return store.size
    },
    clear() {
      store.clear()
    },
    getItem(key) {
      return store.get(key) ?? null
    },
    key(index) {
      return [...store.keys()][index] ?? null
    },
    removeItem(key) {
      store.delete(key)
    },
    setItem(key, value) {
      store.set(key, value)
    },
  }
}

test('completed replies state round-trips dismissed ids through session storage', () => {
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    value: createSessionStorageMock(),
  })

  try {
    saveCompletedRepliesState('account:alice', 'intentlane-codex', {
      dismissedRunIds: ['run-1', ' run-2 ', 'run-1', ''],
    })

    assert.deepEqual(loadCompletedRepliesState('account:alice', 'intentlane-codex'), {
      dismissedRunIds: ['run-1', 'run-2'],
    })
  } finally {
    Object.defineProperty(globalThis, 'sessionStorage', {
      configurable: true,
      value: originalSessionStorage,
    })
  }
})

test('completed replies state ignores malformed session storage payloads', () => {
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    value: createSessionStorageMock({
      [getCompletedRepliesStorageKey('account:alice', 'intentlane-codex')]: '{"dismissedRunIds":"nope"}',
    }),
  })

  try {
    assert.deepEqual(loadCompletedRepliesState('account:alice', 'intentlane-codex'), {
      dismissedRunIds: [],
    })
  } finally {
    Object.defineProperty(globalThis, 'sessionStorage', {
      configurable: true,
      value: originalSessionStorage,
    })
  }
})
