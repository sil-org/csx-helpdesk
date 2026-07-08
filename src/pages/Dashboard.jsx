import { useEffect, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { signOut } from '../lib/auth'
import { supabase } from '../lib/supabase'

// Placeholder — replace with the real ticket queue (Section 4-5 of the brief).
export default function Dashboard() {
  const { profile } = useAuth()
  const [desks, setDesks] = useState(null)

  useEffect(() => {
    if (!profile) return
    supabase
      .from('agent_desks')
      .select('role, desks(id, slug, name)')
      .eq('profile_id', profile.id)
      .then(({ data }) => setDesks(data ?? []))
  }, [profile])

  return (
    <div className="min-h-screen bg-gray-50 p-8">
      <div className="max-w-2xl mx-auto bg-white rounded-2xl shadow-lg p-10">
        <div className="flex items-center justify-between mb-2">
          <h1 className="font-display text-2xl font-bold text-brand">Dashboard</h1>
          <button onClick={signOut} className="text-sm font-medium text-gray-500 hover:text-gray-700">
            Sign out
          </button>
        </div>
        <p className="text-gray-500 mb-6">Signed in as {profile?.display_name} ({profile?.primary_email})</p>

        {desks === null ? (
          <p className="text-gray-400 text-sm">Loading desks…</p>
        ) : desks.length === 0 ? (
          <p className="text-gray-500 text-sm">
            You aren't assigned to any desk yet. Ask an admin to add you in <code>agent_desks</code>.
          </p>
        ) : (
          <ul className="space-y-2">
            {desks.map((d) => (
              <li key={d.desks.id} className="text-gray-700 text-sm">
                {d.desks.name} — role: {d.role}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
