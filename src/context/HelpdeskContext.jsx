import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { useAuth } from './AuthContext'
import { hd } from '../lib/helpdesk'

const HelpdeskContext = createContext(null)

// What the signed-in profile can do in the help desk: which desks they
// work (and as what role), and whether they're a super admin (a row in
// helpdesk.super_admins — deliberately not public.profiles.role, see
// docs/HELPDESK_SPEC.md section 3).
export function HelpdeskProvider({ children }) {
  const { profile } = useAuth()
  const [state, setState] = useState({ loading: true, agentDesks: [], isSuperAdmin: false, allDesks: [], error: null })
  const cancelledRef = useRef(false)

  const load = useCallback(async () => {
    if (!profile) {
      setState({ loading: false, agentDesks: [], isSuperAdmin: false, allDesks: [], error: null })
      return
    }
    try {
      const [{ data: ad, error: adErr }, { data: sa, error: saErr }] = await Promise.all([
        hd.from('agent_desks')
          .select('role, desks!agent_desks_desk_id_fkey(id, slug, name, theme_primary, theme_accent, logo_url, accepts_transfers)')
          .eq('profile_id', profile.id),
        hd.from('super_admins').select('profile_id').eq('profile_id', profile.id).maybeSingle(),
      ])
      if (adErr) throw adErr
      if (saErr) throw saErr
      const isSuperAdmin = !!sa
      const agentDesks = (ad ?? []).map((r) => ({ ...r.desks, role: r.role }))

      let allDesks = agentDesks
      if (isSuperAdmin) {
        const { data: desks, error } = await hd.from('desks')
          .select('id, slug, name, theme_primary, theme_accent, logo_url, accepts_transfers')
          .order('name')
        if (error) throw error
        allDesks = desks ?? []
      }

      if (!cancelledRef.current) setState({ loading: false, agentDesks, isSuperAdmin, allDesks, error: null })
    } catch (e) {
      console.error('HelpdeskContext load failed:', e)
      if (!cancelledRef.current) setState({ loading: false, agentDesks: [], isSuperAdmin: false, allDesks: [], error: e.message })
    }
  }, [profile])

  useEffect(() => {
    cancelledRef.current = false
    load()
    return () => { cancelledRef.current = true }
  }, [load])

  return <HelpdeskContext.Provider value={{ ...state, refresh: load }}>{children}</HelpdeskContext.Provider>
}

export function useHelpdesk() {
  return useContext(HelpdeskContext)
}
