import test from 'node:test'
import assert from 'node:assert/strict'
import {
  clampSelectionIndex,
  getAltNumberSelectionIndex,
  isShortcutsHelpKey,
  moveSelectionIndex,
  orderProjectsForSelection,
} from '../../web/lib/keyboard-shortcuts.js'

test('getAltNumberSelectionIndex maps top-row and numpad shortcuts to the first five items', () => {
  assert.equal(getAltNumberSelectionIndex('Digit1'), 0)
  assert.equal(getAltNumberSelectionIndex('Digit5'), 4)
  assert.equal(getAltNumberSelectionIndex('Numpad1'), 0)
  assert.equal(getAltNumberSelectionIndex('Numpad5'), 4)
  assert.equal(getAltNumberSelectionIndex('Digit6'), null)
  assert.equal(getAltNumberSelectionIndex('KeyP'), null)
})

test('isShortcutsHelpKey recognizes question-mark help shortcuts', () => {
  assert.equal(isShortcutsHelpKey({ key: '?', code: 'Slash', shiftKey: true }), true)
  assert.equal(isShortcutsHelpKey({ key: '/', code: 'Slash', shiftKey: false }), false)
  assert.equal(isShortcutsHelpKey({ key: 'ㅈ', code: 'KeyW', shiftKey: false }), false)
})

test('clampSelectionIndex keeps highlight indices inside the available range', () => {
  assert.equal(clampSelectionIndex(-10, 5), 0)
  assert.equal(clampSelectionIndex(2, 5), 2)
  assert.equal(clampSelectionIndex(999, 5), 4)
  assert.equal(clampSelectionIndex(3, 0), -1)
})

test('moveSelectionIndex clamps project switcher arrow navigation at the first and last item', () => {
  assert.equal(moveSelectionIndex(0, 'previous', 4), 0)
  assert.equal(moveSelectionIndex(0, 'next', 4), 1)
  assert.equal(moveSelectionIndex(3, 'next', 4), 3)
  assert.equal(moveSelectionIndex(1, 'previous', 4), 0)
  assert.equal(moveSelectionIndex(0, 'next', 0), -1)
})

test('orderProjectsForSelection keeps the current project first and preserves the remaining order', () => {
  const ordered = orderProjectsForSelection(
    [
      { id: 'alpha', label: 'Alpha', deletable: false },
      { id: 'beta', label: 'Beta', deletable: false },
      { id: 'gamma', label: 'Gamma', deletable: true },
    ],
    'beta'
  )

  assert.deepEqual(
    ordered.map((project) => project.id),
    ['beta', 'alpha', 'gamma']
  )
})
