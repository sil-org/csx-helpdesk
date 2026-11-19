import { Link } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { signInWithGoogle, signOut } from '../lib/auth'

// Top bar for the help center, shown to signed-out visitors and signed-in
// requesters alike (so it does not use AppLayout, which is for agents).
export default function HelpHeader({ title = 'Help center', logoUrl, color = '#005CB9' }) {
  const { session, profile } = useAuth()
  const signedIn = !!session && !!profile

  return (
    <header className="flex flex-wrap items-center gap-4 px-6 py-3 bg-white border-b border-gray-200">
      <Link to="/help" className="flex items-center gap-3 text-gray-900 no-underline">
        {logoUrl ? (
          <img src={logoUrl} alt="" className="h-8 w-auto" />
        ) : (
          <span className="w-9 h-9 rounded-lg text-white flex items-center justify-center font-bold text-sm" style={{ background: color }}>
            {title[0]}
          </span>
        )}
        <span className="text-[17px] font-bold">{title}</span>
      </Link>

      <nav className="flex gap-1 sm:ml-4" aria-label="Main">
        {signedIn && (
          <Link to="/my-tickets" className="px-3.5 py-2 rounded-lg text-[15px] font-semibold text-gray-700 hover:bg-gray-100">My tickets</Link>
        )}
        <Link to="/help" className="px-3.5 py-2 rounded-lg text-[15px] font-semibold text-gray-700 hover:bg-gray-100">Help center</Link>
      </nav>

      <div className="flex-1" />
      {signedIn ? (
        <>
          <div className="text-sm text-gray-500">{profile.display_name}</div>
          <button onClick={signOut} className="text-sm font-medium text-gray-500 hover:text-gray-700">Sign out</button>
        </>
      ) : (
        <button
          onClick={signInWithGoogle}
          className="text-sm font-bold text-white rounded-lg px-4 py-2"
          style={{ background: color }}
        >
          Sign in with Google
        </button>
      )}
    </header>
  )
}
