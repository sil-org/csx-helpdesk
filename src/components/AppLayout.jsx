import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useState } from 'react'
import { Menu, X, LogOut, LogIn, ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { useHelpdesk } from '../context/HelpdeskContext'
import { signInWithSSO, signOut } from '../lib/auth'
import { version as APP_VERSION } from '../../package.json'

const COLLAPSE_KEY = 'sidebarCollapsed'

// Left sidebar shell, matching the shared SIL app template (see
// license-manager's src/components/AppLayout.jsx). `links` is:
//   [{ to, label, icon: LucideIcon }]
// `desk` is the page's current desk — agent pages (Queue/Ticket/Admin) pass
// their working desk, reporter pages (My Tickets, a ticket, an article) pass
// whichever desk that content belongs to. When the signed-in profile works
// more than one desk (or is a super admin), the badge becomes a switcher;
// otherwise it's a plain static row. This is the one shell for every page in
// the app — agent or reporter, signed in or signed out — so nobody ever
// lands somewhere with no way back to Tickets, Help center or Admin.
export default function AppLayout({ desk, links, children }) {
  const { profile } = useAuth()
  const { agentDesks, isSuperAdmin } = useHelpdesk()
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const [mobileOpen, setMobileOpen] = useState(false)
  const [deskMenuOpen, setDeskMenuOpen] = useState(false)
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSE_KEY) === 'true')

  const switchable = isSuperAdmin || agentDesks.length > 1

  function isActive(to) {
    const path = to.split('?')[0]
    return pathname === path || pathname.startsWith(path + '/')
  }

  function toggleCollapsed() {
    setCollapsed((c) => {
      localStorage.setItem(COLLAPSE_KEY, String(!c))
      return !c
    })
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
        className={`flex-shrink-0 bg-white border-r border-gray-200 flex flex-col
          fixed md:sticky top-0 h-screen z-30 transition-[transform,width] duration-200
          ${mobileOpen ? 'translate-x-0' : '-translate-x-full'} md:translate-x-0
          w-56 ${collapsed ? 'md:w-14' : 'md:w-56'}`}
      >
        <div className={`px-4 py-4 flex items-center gap-2 border-b border-gray-100 ${collapsed ? 'md:justify-center md:px-0' : ''}`}>
          <img src="/sil-logo.png" alt="" className="h-6 flex-shrink-0" />
          <span className={`font-sans font-bold text-brand text-sm leading-tight ${collapsed ? 'md:hidden' : ''}`}>Help Desk</span>
        </div>

        {desk && (
          <div className="relative border-b border-gray-100">
            {switchable ? (
              <button
                onClick={() => setDeskMenuOpen((o) => !o)}
                className={`w-full px-4 py-2.5 flex items-center gap-2 text-left hover:bg-gray-50 ${collapsed ? 'md:justify-center md:px-0' : ''}`}
                aria-haspopup="true"
                aria-expanded={deskMenuOpen}
                title={collapsed ? desk?.name : undefined}
              >
                <DeskBadge desk={desk} />
                <span className={`flex-1 min-w-0 text-xs font-semibold text-gray-700 truncate ${collapsed ? 'md:hidden' : ''}`}>{desk?.name || 'Switch desk'}</span>
                <ChevronDown size={14} className={`flex-shrink-0 text-gray-400 transition-transform ${deskMenuOpen ? 'rotate-180' : ''} ${collapsed ? 'md:hidden' : ''}`} />
              </button>
            ) : (
              <div
                className={`w-full px-4 py-2.5 flex items-center gap-2 ${collapsed ? 'md:justify-center md:px-0' : ''}`}
                title={collapsed ? desk?.name : undefined}
              >
                <DeskBadge desk={desk} />
                <span className={`flex-1 min-w-0 text-xs font-semibold text-gray-700 truncate ${collapsed ? 'md:hidden' : ''}`}>{desk?.name}</span>
              </div>
            )}

            {switchable && deskMenuOpen && (
              <>
                <div className="fixed inset-0 z-30" onClick={() => setDeskMenuOpen(false)} />
                <div className="absolute left-2 w-56 mt-0.5 z-40 bg-white border border-gray-200 rounded-lg shadow-md overflow-hidden">
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
                target={link.newTab ? '_blank' : undefined}
                rel={link.newTab ? 'noopener noreferrer' : undefined}
                onClick={() => setMobileOpen(false)}
                title={link.newTab ? `${link.label} (opens in a new tab)` : link.label}
                className={`w-full flex items-center gap-2.5 px-4 py-2.5 text-sm border-l-[3px] transition-colors text-left
                  ${collapsed ? 'md:justify-center md:px-0' : ''}
                  ${active
                    ? 'border-brand text-brand bg-brand/[0.08] font-semibold'
                    : 'border-transparent text-gray-600 hover:bg-gray-50 hover:text-gray-900'}`}
              >
                {Icon && <Icon size={16} className="flex-shrink-0" />}
                <span className={`truncate ${collapsed ? 'md:hidden' : ''}`}>{link.label}</span>
              </Link>
            )
          })}
        </div>

        <button
          onClick={toggleCollapsed}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className="hidden md:flex items-center gap-2 px-4 py-2.5 text-xs text-gray-500 hover:bg-gray-50 border-t border-gray-100"
        >
          {collapsed ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
          {!collapsed && <span>Collapse</span>}
        </button>

        <div className={`px-4 py-3 border-t border-gray-100 text-xs text-gray-500 ${collapsed ? 'md:px-2' : ''}`}>
          {profile ? (
            <>
              <p className={`truncate mb-1.5 ${collapsed ? 'md:hidden' : ''}`}>{profile.primary_email}</p>
              <button onClick={signOut} title="Sign out" className={`flex items-center gap-1.5 text-brand hover:underline ${collapsed ? 'md:justify-center md:w-full' : ''}`}>
                <LogOut size={13} className="flex-shrink-0" /> <span className={collapsed ? 'md:hidden' : ''}>Sign out</span>
              </button>
            </>
          ) : (
            <button
              onClick={signInWithSSO}
              title="Sign in with SSO"
              className={`w-full flex items-center justify-center gap-2 text-xs font-bold text-white rounded-lg py-2 ${collapsed ? 'md:px-0' : 'px-3'}`}
              style={{ background: '#005CB9' }}
            >
              <LogIn size={14} className="flex-shrink-0" />
              <span className={collapsed ? 'md:hidden' : ''}>Sign in with SSO</span>
            </button>
          )}
          <p className={`text-gray-400 mt-1.5 ${collapsed ? 'md:hidden' : ''}`}>v{APP_VERSION}</p>
        </div>
      </nav>

      {/* pt-14 clears the fixed mobile hamburger button so page headings
          don't sit underneath it; not needed on desktop, where the button
          doesn't render at all. */}
      <main className="flex-1 min-w-0 pt-14 md:pt-0">{children}</main>
    </div>
  )
}

function DeskBadge({ desk }) {
  return (
    <span
      className="w-5 h-5 flex-shrink-0 rounded text-white flex items-center justify-center font-bold text-[11px]"
      style={{ background: desk?.theme_primary || '#005CB9' }}
    >
      {(desk?.name || '?')[0]}
    </span>
  )
}
