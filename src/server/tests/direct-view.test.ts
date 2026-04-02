import test from 'node:test'
import assert from 'node:assert/strict'
import {
  resolveDirectComposerRoleShortcut,
  resolveDirectModelSelection,
  resolveDirectStateSyncAction,
} from '../../web/components/DirectView.js'
import { getCycledDirectAgentRole } from '../../web/lib/direct-state.js'

test('resolveDirectStateSyncAction resets when no project is selected', () => {
  assert.equal(
    resolveDirectStateSyncAction({
      projectId: '',
      syncedProjectId: undefined,
      hasDirectState: false,
      isStateLoading: false,
    }),
    'reset'
  )
})

test('resolveDirectStateSyncAction resets while a new project state is still loading', () => {
  assert.equal(
    resolveDirectStateSyncAction({
      projectId: 'project-a',
      syncedProjectId: undefined,
      hasDirectState: false,
      isStateLoading: true,
    }),
    'reset'
  )
})

test('resolveDirectStateSyncAction hydrates once a new project state arrives', () => {
  assert.equal(
    resolveDirectStateSyncAction({
      projectId: 'project-a',
      syncedProjectId: undefined,
      hasDirectState: true,
      isStateLoading: false,
    }),
    'hydrate'
  )
})

test('resolveDirectStateSyncAction preserves same-project refreshes', () => {
  assert.equal(
    resolveDirectStateSyncAction({
      projectId: 'project-a',
      syncedProjectId: 'project-a',
      hasDirectState: true,
      isStateLoading: false,
    }),
    'preserve'
  )
})

test('resolveDirectModelSelection preserves reasoning effort when supported by the new model', () => {
  const result = resolveDirectModelSelection({
    availableModels: [
      {
        id: 'model-a',
        label: 'Model A',
        supportedReasoningEfforts: ['low', 'medium'],
        defaultReasoningEffort: 'medium',
      },
      {
        id: 'model-b',
        label: 'Model B',
        supportedReasoningEfforts: ['medium', 'high'],
        defaultReasoningEffort: 'high',
      },
    ],
    currentReasoningEffort: 'medium',
    nextModel: 'model-b',
  })

  assert.deepEqual(result, {
    nextModel: 'model-b',
    nextReasoningEffort: 'medium',
  })
})

test('resolveDirectModelSelection falls back to model default when current effort is unsupported', () => {
  const result = resolveDirectModelSelection({
    availableModels: [
      {
        id: 'model-a',
        label: 'Model A',
        supportedReasoningEfforts: ['low', 'medium'],
        defaultReasoningEffort: 'medium',
      },
      {
        id: 'model-b',
        label: 'Model B',
        supportedReasoningEfforts: ['high'],
        defaultReasoningEffort: 'high',
      },
    ],
    currentReasoningEffort: 'medium',
    nextModel: 'model-b',
  })

  assert.deepEqual(result, {
    nextModel: 'model-b',
    nextReasoningEffort: 'high',
  })
})

test('getCycledDirectAgentRole moves from the last specialist role to plain on Tab', () => {
  assert.equal(getCycledDirectAgentRole('prometheus', 'forward'), 'plain')
})

test('getCycledDirectAgentRole moves from the first specialist role to plain on Shift+Tab', () => {
  assert.equal(getCycledDirectAgentRole('sisyphus', 'backward'), 'plain')
})

test('getCycledDirectAgentRole re-enters the specialist flow from plain', () => {
  assert.equal(getCycledDirectAgentRole('plain', 'forward'), 'sisyphus')
  assert.equal(getCycledDirectAgentRole('plain', 'backward'), 'prometheus')
})

test('resolveDirectComposerRoleShortcut returns the next role on Tab', () => {
  assert.equal(
    resolveDirectComposerRoleShortcut({
      key: 'Tab',
      shiftKey: false,
      isStreaming: false,
      isComposerDisabled: false,
      selectedAgentRole: 'hephaestus',
    }),
    'prometheus'
  )
})

test('resolveDirectComposerRoleShortcut returns plain after the last specialist role on Tab', () => {
  assert.equal(
    resolveDirectComposerRoleShortcut({
      key: 'Tab',
      shiftKey: false,
      isStreaming: false,
      isComposerDisabled: false,
      selectedAgentRole: 'prometheus',
    }),
    'plain'
  )
})

test('resolveDirectComposerRoleShortcut returns the previous role on Shift+Tab', () => {
  assert.equal(
    resolveDirectComposerRoleShortcut({
      key: 'Tab',
      shiftKey: true,
      isStreaming: false,
      isComposerDisabled: false,
      selectedAgentRole: 'hephaestus',
    }),
    'sisyphus'
  )
})

test('resolveDirectComposerRoleShortcut re-enters the specialist flow from plain on Shift+Tab', () => {
  assert.equal(
    resolveDirectComposerRoleShortcut({
      key: 'Tab',
      shiftKey: true,
      isStreaming: false,
      isComposerDisabled: false,
      selectedAgentRole: 'plain',
    }),
    'prometheus'
  )
})

test('resolveDirectComposerRoleShortcut is disabled while streaming', () => {
  assert.equal(
    resolveDirectComposerRoleShortcut({
      key: 'Tab',
      shiftKey: false,
      isStreaming: true,
      isComposerDisabled: false,
      selectedAgentRole: 'hephaestus',
    }),
    null
  )
})

test('resolveDirectComposerRoleShortcut is disabled when the composer is disabled', () => {
  assert.equal(
    resolveDirectComposerRoleShortcut({
      key: 'Tab',
      shiftKey: false,
      isStreaming: false,
      isComposerDisabled: true,
      selectedAgentRole: 'hephaestus',
    }),
    null
  )
})
