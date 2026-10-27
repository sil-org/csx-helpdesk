import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useState } from 'react'
import { Menu, X, LogOut, ChevronDown } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { useHelpdesk } from '../context/HelpdeskContext'
import { signOut } from '../lib/auth'
import { version as APP_VERSION } from '../../package.json'

// Left sidebar shell, matching the shared SIL app template (see
// license-manager's src/components/AppLayout.jsx). `links` is:
//   [{ to, label, icon: LucideIcon }]
// `desk` is the page's current desk (Queue/Ticket have one; Admin doesn't
// always) — when the signed-in profile works more than one desk (or is a
// super admin), a desk switcher renders under the logo, replacing the desk
// badge/dropdown that used to live in DeskHeader's top bar.
export default function AppLayout({ desk, links, children }) {
  const { profile } = useAuth()
  const { agentDesks, isSuperAdmin } = useHelpdesk()
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const [mobileOpen, setMobileOpen] = useState(false)
  const [deskMenuOpen, setDeskMenuOpen] = useState(false)

  const switchable = isSuperAdmin || agentDesks.length > 1

  function isActive(to) {
    return pathname === to || pathname.startsWith(to + '/')
  }

  return (
    <div className="min-h-screen flex bg-gray-50">
      <button
        onClick={() => setMobileOpen((o) => !o)}
        className="md:hidden fixed top-3 left-3 z-30 bg-white border border-gray-200 shadow-sm rounded-lg p-2 text-brand"
        aria-label="Menu"
      >
        {mobileOpen ? <X size={18} /> : <Menu size={18} />}
      </button>

      {mobileOpen && (
        <div className="md:hidden fixed inset-0 bg-black/30 z-20" onClick={() => setMobileOpen(false)} />
      )}

      <nav
        className={`w-56 flex-shrink-0 bg-white border-r border-gray-200 flex flex-col
          fixed md:sticky top-0 h-screen z-30 transition-transform duration-200
          ${mobileOpen ? 'translate-x-0' : '-translate-x-full'} md:translate-x-0`}
      >
        <div className="px-4 py-4 flex items-center gap-2 border-b border-gray-100">
          <img src="/sil-logo.png" alt="" className="h-6" />
          <span className="font-sans font-bold text-brand text-sm leading-tight">Help Desk</span>
        </div>

        {switchable && (
          <div className="relative border-b border-gray-100">
            <button
              onClick={() => setDeskMenuOpen((o) => !o)}
              className="w-full px-4 py-2.5 flex items-center gap-2 text-left hover:bg-gray-50"
              aria-haspopup="true"
              aria-expanded={deskMenuOpen}
            >
              <span
                className="w-5 h-5 flex-shrink-0 rounded text-white flex items-center justify-center font-bold text-[11px]"
                style={{ background: desk?.theme_primary || '#005CB9' }}
              >
                {(desk?.name || '?')[0]}
              </span>
              <span className="flex-1 min-w-0 text-xs font-semibold text-gray-700 truncate">{desk?.name || 'Switch desk'}</span>
              <ChevronDown size={14} className={`flex-shrink-0 text-gray-400 transition-transform ${deskMenuOpen ? 'rotate-180' : ''}`} />
            </button>

            {deskMenuOpen && (
              <>
                <div className="fixed inset-0 z-30" onClick={() => setDeskMenuOpen(false)} />
                <div className="absolute left-2 right-2 mt-0.5 z-40 bg-white border border-gray-200 rounded-lg shadow-md overflow-hidden">
                  {agentDesks.map((d) => (
                    <button
                      key={d.id}
                      onClick={() => { setDeskMenuOpen(false); setMobileOpen(false); navigate(`/d/${d.slug}`) }}
                      className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
                    >
                      {d.name}
                    </button>
                  ))}
                  {isSuperAdmin && (
                    <div className="px-3 py-1.5 text-[11px] text-gray-400 border-t border-gray-100">
                      Super admin: any desk is reachable at /d/&lt;slug&gt;
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        )}

        <div className="flex-1 py-2 flex flex-col overflow-y-auto">
          {links.map((link) => {
            const Icon = link.icon
            const active = isActive(link.to)
            return (
              <Link
                key={link.to}
                to={link.to}
                onClick={() => setMobileOpen(false)}
                className={`w-full flex items-center gap-2.5 px-4 py-2.5 text-sm border-l-[3px] transition-colors text-left
                  ${active
                    ? 'border-brand text-brand bg-brand/[0.08] font-semibold'
                    : 'border-transparent text-gray-600 hover:bg-gray-50 hover:text-gray-900'}`}
              >
                {Icon && <Icon size={16} className="flex-shrink-0" />}
                <span className="truncate">{link.label}</span>
              </Link>
            )
          })}
        </div>

        <div className="px-4 py-3 border-t border-gray-100 text-xs text-gray-500">
          <p className="truncate mb-1.5">{profile?.primary_email}</p>
          <button onClick={signOut} className="flex items-center gap-1.5 text-brand hover:underline">
            <LogOut size={13} /> Sign out
          </button>
          <p className="text-gray-400 mt-1.5">v{APP_VERSION}</p>
        </div>
      </nav>

      {/* pt-14 clears the fixed mobile hamburger button so page headings
          don't sit underneath it; not needed on desktop, where the button
          doesn't render at all. */}
      <main className="flex-1 min-w-0 pt-14 md:pt-0">{children}</main>
    </div>
  )
}
