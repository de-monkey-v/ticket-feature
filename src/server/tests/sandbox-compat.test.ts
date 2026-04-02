import test from 'node:test'
import assert from 'node:assert/strict'
import {
  resolveCompatibleSandboxMode,
  supportsBwrapArgv0,
} from '../lib/sandbox-compat.js'

test('supportsBwrapArgv0 detects compatible help text', () => {
  assert.equal(supportsBwrapArgv0('--help\n--argv0 VALUE\n--bind SRC DEST'), true)
  assert.equal(supportsBwrapArgv0('--help\n--bind SRC DEST'), false)
})

test('resolveCompatibleSandboxMode keeps requested mode when system bwrap supports --argv0', () => {
  assert.equal(
    resolveCompatibleSandboxMode({
      requestedMode: 'read-only',
      platform: 'linux',
      systemBwrapExists: true,
      systemBwrapHelpText: '--help\n--argv0 VALUE\n--bind SRC DEST',
    }),
    'read-only'
  )

  assert.equal(
    resolveCompatibleSandboxMode({
      requestedMode: 'workspace-write',
      platform: 'linux',
      systemBwrapExists: true,
      systemBwrapHelpText: '--help\n--argv0 VALUE\n--bind SRC DEST',
    }),
    'workspace-write'
  )
})

test('resolveCompatibleSandboxMode falls back to danger-full-access when linux system bwrap lacks --argv0', () => {
  assert.equal(
    resolveCompatibleSandboxMode({
      requestedMode: 'read-only',
      platform: 'linux',
      systemBwrapExists: true,
      systemBwrapHelpText: '--help\n--bind SRC DEST',
    }),
    'danger-full-access'
  )

  assert.equal(
    resolveCompatibleSandboxMode({
      requestedMode: 'workspace-write',
      platform: 'linux',
      systemBwrapExists: true,
      systemBwrapHelpText: '--help\n--bind SRC DEST',
    }),
    'danger-full-access'
  )
})

test('resolveCompatibleSandboxMode leaves danger-full-access and non-linux modes unchanged', () => {
  assert.equal(
    resolveCompatibleSandboxMode({
      requestedMode: 'danger-full-access',
      platform: 'linux',
      systemBwrapExists: true,
      systemBwrapHelpText: '--help\n--bind SRC DEST',
    }),
    'danger-full-access'
  )

  assert.equal(
    resolveCompatibleSandboxMode({
      requestedMode: 'read-only',
      platform: 'darwin',
      systemBwrapExists: true,
      systemBwrapHelpText: '--help\n--bind SRC DEST',
    }),
    'read-only'
  )
})
