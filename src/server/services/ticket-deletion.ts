import { unlinkRequestFromTicket } from './client-requests.js'
import { destroyTicketWorktree } from './ticket-orchestrator.js'
import { isTicketRunActive } from './ticket-runner.js'
import { deleteTicket, getTicket } from './tickets.js'

export async function deleteTicketWithCleanup(ticketId: string, signal?: AbortSignal) {
  const ticket = getTicket(ticketId)
  if (!ticket) {
    throw new Error('Ticket not found')
  }

  if (isTicketRunActive(ticketId) || ticket.runState === 'queued' || ticket.runState === 'running') {
    throw new Error('Ticket is already running')
  }

  if (ticket.worktree) {
    await destroyTicketWorktree(ticketId, signal)
  }

  if (ticket.linkedRequestId) {
    unlinkRequestFromTicket(ticket.linkedRequestId)
  }

  if (!deleteTicket(ticketId)) {
    throw new Error('Ticket not found')
  }
}
