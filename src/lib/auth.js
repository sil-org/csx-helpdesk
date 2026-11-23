import { supabase } from './supabase'
import { hd } from './helpdesk'

export async function signInWithSSO() {
  const { error } = await supabase.auth.signInWithSSO({
    providerId: import.meta.env.VITE_SSO_PROVIDER_ID,
    options: {
      redirectTo: `${window.location.origin}/auth/callback`,
    },
  })
  if (error) throw error
}

export async function signOut() {
  const { error } = await supabase.auth.signOut()
  if (error) throw error
}

// Called after the SSO callback — finds or creates a profile for this SAML
// identity. If a pendingLinkToken is in localStorage, links this identity to
// the existing profile first. Uses the helpdesk-specific resolve_profile_sso
// RPC (schema_helpdesk.sql), not the shared public.resolve_profile() that
// license-manager still uses for Google sign-in on this same Supabase
// project — see that function's comment for why they're kept separate.
export async function resolveProfile(authUser) {
  const pendingToken = localStorage.getItem('pendingLinkToken') || null
  if (pendingToken) localStorage.removeItem('pendingLinkToken')

  const { data: profileId, error: rpcError } = await hd.rpc('resolve_profile_sso', {
    p_token: pendingToken,
    p_supabase_user_id: authUser.id,
    p_email: authUser.email,
    p_display_name: authUser.user_metadata?.full_name || authUser.email,
  })
  if (rpcError) throw rpcError

  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', profileId)
    .single()
  if (profileError) throw profileError
  return profile
}

export async function getLinkedAccounts(profileId) {
  const { data, error } = await supabase
    .from('linked_accounts')
    .select('supabase_user_id, email, linked_at')
    .eq('profile_id', profileId)
    .order('linked_at', { ascending: true })
  if (error) throw error
  return data
}

export async function createLinkToken() {
  const { data, error } = await supabase.rpc('create_link_token')
  if (error) throw error
  return data
}
