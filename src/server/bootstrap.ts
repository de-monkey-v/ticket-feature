import { reloadClientRequestsFromDisk } from './services/client-requests.js'
import { markRecoverableBackgroundRunsFromStartup, reloadBackgroundRunsFromDisk } from './services/background-runs.js'
import { resumePendingIncidentAutoResolutions } from './services/incident-resolution.js'
import { reloadIncidentsFromDisk } from './services/incidents.js'
import { markRecoverableTicketsFromStartup, reloadTicketsFromDisk } from './services/tickets.js'

let storesBootstrapped = false

export function bootstrapStores() {
  reloadBackgroundRunsFromDisk()
  reloadClientRequestsFromDisk()
  reloadTicketsFromDisk()
  reloadIncidentsFromDisk()
  storesBootstrapped = true
}

export function bootstrapApiProcess() {
  bootstrapStores()
  markRecoverableBackgroundRunsFromStartup()
  resumePendingIncidentAutoResolutions()
}

export function bootstrapWorkerProcess() {
  bootstrapStores()
  markRecoverableTicketsFromStartup()
  resumePendingIncidentAutoResolutions()
}

export function ensureStoresBootstrapped() {
  if (!storesBootstrapped) {
    bootstrapStores()
  }
}
