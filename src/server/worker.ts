import { bootstrapWorkerProcess } from './bootstrap.js'
import { loadAppEnvFile } from './lib/env.js'
import { startTicketWorkerLoop } from './services/ticket-runner.js'

loadAppEnvFile()

bootstrapWorkerProcess()
startTicketWorkerLoop()

console.log('Ticket worker running')
