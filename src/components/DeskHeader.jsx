import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useHelpdesk } from '../context/HelpdeskContext'

// Top bar on every agent-facing screen: desk badge/name, a switcher when the
// profile works more than one desk, and the signed-in person on the right.
export default function DeskHeader({ desk, backTo }) {
  const { profile } = useAuth()
  const { agentDesks, isSuperAdmin } = useHelpdesk()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const color = desk?.theme_primary || '#005CB9'
  const switchable = isSuperAdmin || agentDesks.length > 1
  const role = agentDesks.find((d) => d.id === desk?.id)?.role

  return (
    <div className="flex flex-wrap items-center gap-4 px-6 py-3 bg-white border-b border-gray-200 relative">
      <div className="flex items-center gap-3">
        <div
          className="w-9 h-9 rounded-lg text-white flex items-center justify-center font-bold text-base"
          style={{ background: color }}
        >
          {(desk?.name || '?')[0]}
        </div>
        <div className="text-[17px] font-bold">{desk?.name}</div>
      </div>

      {backTo && (
        <Link to={backTo} className="text-sm font-semibold text-brand hover:text-brand-dark">
          &larr; Back to queue
        </Link>
      )}

      {switchable && (
        <div className="relative">
          <button
            onClick={() => setOpen((o) => !o)}
            className="inline-flex items-center gap-2 min-h-[44px] px-3.5 border border-gray-300 rounded-lg bg-white text-sm text-gray-700"
          >
            Switch desk
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M6 9l6 6 6-6" />
            </svg>
          </button>
          {open && (
            <div className="absolute z-10 mt-1 w-56 bg-white border border-gray-200 rounded-lg shadow-lg py-1">
              {agentDesks.map((d) => (
                <button
                  key={d.id}
                  onClick={() => { setOpen(false); navigate(`/d/${d.slug}`) }}
                  className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50"
                >
                  {d.name}
                </button>
              ))}
              {isSuperAdmin && (
                <div className="px-3 py-1.5 text-xs text-gray-400 border-t border-gray-100 mt-1">
                  Super admin: any desk is reachable at /d/&lt;slug&gt;
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <div className="flex-1" />
      {(isSuperAdmin || role === 'admin') && (
        <Link to="/admin" className="text-sm font-semibold text-brand hover:text-brand-dark">Admin</Link>
      )}
      <div className="text-sm text-gray-500">
        {profile?.display_name} {role && <>&middot; <b className="text-gray-900">{role === 'admin' ? 'Desk admin' : 'Agent'}</b></>}
      </div>
    </div>
  )
}
