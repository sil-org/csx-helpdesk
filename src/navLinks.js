import { Inbox, Settings } from 'lucide-react'

// Mirrors license-manager's navLinks.js convention (a function, not a static
// array, since the Queue link depends on which desk is current). `desk` is
// the current desk if the page has one (Queue/Ticket); on a page with no
// single current desk (Admin), pass the agent's first desk so "Queue" still
// goes somewhere sensible.
export function getLinks({ desk, isDeskAdmin, isSuperAdmin } = {}) {
  return [
    ...(desk ? [{ to: `/d/${desk.slug}`, label: 'Tickets', icon: Inbox }] : []),
    ...(isDeskAdmin || isSuperAdmin ? [{ to: '/admin', label: 'Admin', icon: Settings }] : []),
  ]
}
