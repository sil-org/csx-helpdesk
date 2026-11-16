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

// public.profiles' own RLS only lets a signed-in user read their own row (or
// a license-manager admin read everyone's — a different thing from a
// helpdesk super admin), so resolving OTHER staff's names/emails goes
// through helpdesk.staff_profiles()/find_profile_by_email() instead of a
// plain `public.profiles` lookup, which would silently drop every row but
// the caller's own.
export async function profilesByIds(ids) {
  const uniq = [...new Set(ids.filter(Boolean))]
  if (!uniq.length) return {}
  const { data, error } = await hd.rpc('staff_profiles', { p_ids: uniq })
  if (error) throw error
  return Object.fromEntries(data.map((p) => [p.id, p]))
}

export async function findProfileByEmail(email) {
  const { data, error } = await hd.rpc('find_profile_by_email', { p_email: email.toLowerCase() })
  if (error) throw error
  return data?.[0] ?? null
}
