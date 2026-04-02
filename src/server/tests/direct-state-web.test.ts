import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_DIRECT_AGENT_ROLE,
  createDirectSessionState,
  deleteDirectSessionState,
  getAdjacentDirectAgentRoles,
  normalizeDirectState,
  renameDirectSessionState,
  toDirectSessionOverview,
  updateDirectSessionState,
} from '../../web/lib/direct-state.js'

test('normalizeDirectState migrates legacy single-session payloads into session lists', () => {
  const state = normalizeDirectState({
    threadId: 'thread-1',
    messages: [
      { id: 'msg-1', role: 'user', content: 'fix the regression' },
      { id: 'msg-2', role: 'assistant', content: 'working on it' },
    ],
    updatedAt: '2026-03-31T00:00:00.000Z',
  })

  assert.equal(state.selectedSessionId, 'session-initial')
  assert.equal(state.sessions.length, 1)
  assert.equal(state.sessions[0]?.agentRole, DEFAULT_DIRECT_AGENT_ROLE)
  assert.equal(state.sessions[0]?.threadId, 'thread-1')
  assert.equal(state.sessions[0]?.messages.length, 2)
  assert.equal(state.sessions[0]?.messages[0]?.content, 'fix the regression')
  assert.equal(state.sessions[0]?.continuityMode, 'native')
})

test('normalizeDirectState migrates legacy atlas role in structured direct session payloads', () => {
  const state = normalizeDirectState({
    selectedAgentRole: 'atlas',
    selectedSessionId: 'session-b',
    sessions: [
      {
        id: 'session-a',
        threadId: 'thread-a',
        messages: [{ id: 'msg-a', role: 'user', content: 'first' }],
        createdAt: '2026-03-30T00:00:00.000Z',
        updatedAt: '2026-03-30T00:00:00.000Z',
      },
      {
        id: 'session-b',
        threadId: 'thread-b',
        messages: [{ id: 'msg-b', role: 'user', content: 'second' }],
        createdAt: '2026-03-31T00:00:00.000Z',
        updatedAt: '2026-03-31T00:00:00.000Z',
      },
    ],
  })

  assert.equal(state.selectedSessionId, 'session-b')
  assert.equal(state.sessions[0]?.agentRole, 'plain')
  assert.equal(state.sessions[0]?.id, 'session-b')
  assert.equal(state.sessions[1]?.id, 'session-a')
  assert.equal(state.sessions[1]?.agentRole, 'plain')
})

test('direct session helpers create plain sessions, update, summarize, and delete sessions safely', () => {
  const initialState = normalizeDirectState({
    selectedAgentRole: 'atlas',
    selectedSessionId: 'session-a',
    sessions: [
      {
        id: 'session-a',
        threadId: 'thread-a',
        messages: [{ id: 'msg-a', role: 'user', content: 'fix login form validation' }],
        createdAt: '2026-03-31T00:00:00.000Z',
        updatedAt: '2026-03-31T00:00:00.000Z',
      },
    ],
  })

  const createdState = createDirectSessionState(initialState)
  assert.equal(createdState.sessions.length, 2)
  assert.equal(createdState.selectedSessionId, createdState.sessions[0]?.id)
  assert.equal(createdState.sessions[0]?.agentRole, 'plain')

  const updatedState = updateDirectSessionState(createdState, 'session-a', (session) => ({
    ...session,
    agentRole: 'prometheus',
    messages: [...session.messages, { id: 'msg-b', role: 'assistant', content: 'done' }],
    updatedAt: '2026-04-01T00:00:00.000Z',
  }))
  const renamedState = renameDirectSessionState(updatedState, 'session-a', '  로그인 핫픽스  ')
  const overview = toDirectSessionOverview(renamedState)
  const updatedSession = overview.sessions.find((session) => session.id === 'session-a')
  assert.ok(updatedSession)
  assert.equal(updatedSession.label, '로그인 핫픽스')
  assert.match(updatedSession.preview, /done/)
  assert.equal(updatedSession.agentRole, 'prometheus')
  assert.equal(renamedState.sessions.find((session) => session.id === 'session-a')?.agentRole, 'prometheus')
  assert.equal(renamedState.sessions.find((session) => session.id === 'session-a')?.title, '로그인 핫픽스')

  const deletedState = deleteDirectSessionState(renamedState, 'session-a')
  assert.equal(deletedState.sessions.some((session) => session.id === 'session-a'), false)
  assert.equal(deletedState.sessions[0]?.agentRole, 'plain')
})

test('toDirectSessionOverview preserves rehydrated continuity metadata for sidebar badges', () => {
  const state = normalizeDirectState({
    selectedSessionId: 'session-a',
    sessions: [
      {
        id: 'session-a',
        agentRole: 'plain',
        continuityMode: 'rehydrated',
        lastRecoveryAt: '2026-04-02T12:00:00.000Z',
        lastRecoveryReason: 'Direct thread resume produced no events',
        threadId: 'thread-a',
        messages: [{ id: 'msg-a', role: 'user', content: '이거 이어서 고쳐줘' }],
        createdAt: '2026-04-02T00:00:00.000Z',
        updatedAt: '2026-04-02T12:00:00.000Z',
      },
    ],
  })

  assert.equal(state.sessions[0]?.continuityMode, 'rehydrated')
  assert.equal(toDirectSessionOverview(state).sessions[0]?.continuityMode, 'rehydrated')
})

test('getAdjacentDirectAgentRoles includes plain as the default edge state', () => {
  assert.deepEqual(getAdjacentDirectAgentRoles('plain'), {
    previous: 'prometheus',
    next: 'sisyphus',
  })
  assert.deepEqual(getAdjacentDirectAgentRoles('sisyphus'), {
    previous: 'plain',
    next: 'hephaestus',
  })
  assert.deepEqual(getAdjacentDirectAgentRoles('hephaestus'), {
    previous: 'sisyphus',
    next: 'prometheus',
  })
  assert.deepEqual(getAdjacentDirectAgentRoles('prometheus'), {
    previous: 'hephaestus',
    next: 'plain',
  })
})
