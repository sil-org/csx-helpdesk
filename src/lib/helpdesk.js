import { supabase } from './supabase'

// Scoped to the `helpdesk` Postgres schema (Settings > API > Exposed schemas).
// Same session/auth as the default client — RLS still applies per-row.
export const hd = supabase.schema('helpdesk')

export const STATUS_LABEL = {
  new: 'New',
  open: 'Open',
  waiting: 'Waiting for response',
  paused: 'Paused',
  resolved: 'Resolved',
  closed: 'Closed',
  deleted: 'Deleted',
}

// Reporters see Paused as "On hold" (spec section 4) and never see Deleted.
export const REPORTER_STATUS_LABEL = { ...STATUS_LABEL, paused: 'On hold' }

export const STATUS_STYLE = {
  new: { bg: '#FFF1D1', fg: '#7A4F00', dot: '#FFB71B' },
  open: { bg: '#E5EEF8', fg: '#034D8A', dot: '#005CB9' },
  waiting: { bg: '#F4EAF3', fg: '#6B2169', dot: '#93358D' },
  paused: { bg: '#EFEFEF', fg: '#4C4C4C', dot: '#666666' },
  resolved: { bg: '#EDF5EA', fg: '#38751C', dot: '#509E2F' },
  closed: { bg: '#191919', fg: '#fff', dot: '#949494' },
  deleted: { bg: '#FBE8E9', fg: '#A6121F', dot: '#D52227' },
}

export const ACTIVE_STATUSES = ['new', 'open', 'waiting', 'paused']

export function relativeTime(iso) {
  const diffMs = Date.now() - new Date(iso).getTime()
  const min = Math.round(diffMs / 60000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min} min ago`
  const hr = Math.round(min / 60)
  if (hr < 24) return `${hr} h ago`
  const day = Math.round(hr / 24)
  if (day === 1) return 'yesterday'
  if (day < 7) return `${day} days ago`
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

// public.profiles lives outside the helpdesk schema, so ticket_messages.profile_id /
// tickets.assignee_profile_id / agent_desks.profile_id are resolved with a
// plain (non-schema-scoped) lookup rather than a cross-schema PostgREST embed.
export async function profilesByIds(ids) {
  const uniq = [...new Set(ids.filter(Boolean))]
  if (!uniq.length) return {}
  const { data, error } = await supabase
    .from('profiles')
    .select('id, display_name, primary_email')
    .in('id', uniq)
  if (error) throw error
  return Object.fromEntries(data.map((p) => [p.id, p]))
}

export async function findProfileByEmail(email) {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, display_name, primary_email')
    .eq('primary_email', email.toLowerCase())
    .maybeSingle()
  if (error) throw error
  return data
}
