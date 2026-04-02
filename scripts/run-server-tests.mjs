import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const testDataDir = mkdtempSync(join(tmpdir(), 'intentlane-codex-test-data-'))
const testDir = resolve(process.cwd(), 'src/server/tests')
const testFiles = readdirSync(testDir)
  .filter((entry) => entry.endsWith('.test.ts'))
  .sort()
  .map((entry) => join('src/server/tests', entry))

const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', ...testFiles], {
  stdio: 'inherit',
  env: {
    ...process.env,
    INTENTLANE_CODEX_DATA_DIR: testDataDir,
    INTENTLANE_CODEX_SKIP_ENV_FILE: '1',
  },
})

rmSync(testDataDir, { recursive: true, force: true })

if (result.error) {
  throw result.error
}

process.exit(result.status ?? 1)
