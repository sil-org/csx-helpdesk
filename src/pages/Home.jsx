import { useEffect } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { KeyRound, LifeBuoy } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { signInWithSSO } from '../lib/auth'

export default function Home() {
  const { session, profile, loading } = useAuth()
  const navigate = useNavigate()

  useEffect(() => {
    if (session && profile) {
      // Dashboard resolves where to go (queue, admin, my-tickets) from the
      // helpdesk's own roles — not profile.role, shared with license-manager.
      navigate('/dashboard')
    }
  }, [session, profile, navigate])

  if (loading) return <LoadingScreen />

  if (session && profile) {
    return null
  }

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center px-4">
      <div className="max-w-md w-full bg-white rounded-2xl shadow-lg p-10 text-center">
        <img src="/sil-logo.png" alt="SIL" className="h-14 mx-auto mb-6" />
        <h1 className="font-display text-3xl font-bold text-brand mb-2">SIL Help Desk</h1>
        <p className="text-gray-500 mb-8 text-sm">Staff sign-in required</p>

        <button
          onClick={signInWithSSO}
          className="w-full flex items-center justify-center gap-3 bg-white border border-gray-300 rounded-lg px-6 py-3 text-sm font-medium text-gray-700 hover:bg-gray-50 shadow-sm transition"
        >
          <KeyRound size={18} />
          Sign in with SSO
        </button>

        <p className="mt-6 text-xs text-gray-400">
          Restricted to SIL staff.
        </p>

        <Link
          to="/help"
          className="mt-4 flex items-center justify-center gap-1.5 text-sm font-semibold text-brand hover:underline"
        >
          <LifeBuoy size={15} />
          Trouble signing in? Visit the Help Center
        </Link>
      </div>
    </div>
  )
}

function LoadingScreen() {
  return (
    <div className="min-h-screen flex items-center justify-center text-gray-400">
      Loading…
    </div>
  )
}
