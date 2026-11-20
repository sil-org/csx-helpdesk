import { Inbox, LifeBuoy, Settings } from 'lucide-react'

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

// Reporter-facing pages (My Tickets, a ticket, Help center, an article,
// Account) use this instead: nobody there has agent_desks access, and Help
// center is public (spec decision 23), so "My tickets" only makes sense once
// signed in.
export function getReporterLinks({ signedIn } = {}) {
  return [
    { to: '/help', label: 'Help center', icon: LifeBuoy },
    ...(signedIn ? [{ to: '/my-tickets', label: 'My tickets', icon: Inbox }] : []),
  ]
}
