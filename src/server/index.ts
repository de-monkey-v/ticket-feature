import { spawn, type ChildProcess } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

function spawnChild(entry: 'api' | 'worker') {
  const child = spawn(process.execPath, [resolve(__dirname, `${entry}.js`)], {
    env: {
      ...process.env,
      INTENTLANE_CODEX_RUNNER_ROLE: entry === 'api' ? 'api' : 'worker',
    },
    stdio: 'inherit',
  })

  child.on('exit', (code, signal) => {
    shutdown(signal ?? 'SIGTERM')
    if (signal) {
      console.error(`${entry} exited with signal ${signal}`)
    } else if (code !== 0) {
      console.error(`${entry} exited with code ${code}`)
      process.exitCode = code ?? 1
    }
  })

  return child
}

const children: ChildProcess[] = [spawnChild('api'), spawnChild('worker')]
let shuttingDown = false

function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) {
    return
  }

  shuttingDown = true
  for (const child of children) {
    if (!child.killed) {
      child.kill(signal)
    }
  }
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
