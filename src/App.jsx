import { lazy, Suspense } from 'react'
import { Routes, Route } from 'react-router-dom'
import Home from './pages/Home'
import AuthCallback from './pages/AuthCallback'
import Dashboard from './pages/Dashboard'
import AccountSettings from './pages/AccountSettings'
import AdminDashboard from './pages/admin/Dashboard'
import Queue from './pages/desk/Queue'
import Ticket from './pages/desk/Ticket'
import MyTickets from './pages/MyTickets'
import ReporterTicket from './pages/ReporterTicket'
import RequireAuth from './components/RequireAuth'
// Loaded on demand so the markdown renderer stays out of the agents' bundle.
const HelpCenter = lazy(() => import('./pages/help/HelpCenter'))
const HelpArticle = lazy(() => import('./pages/help/Article'))
const helpFallback = <div className="min-h-screen flex items-center justify-center text-gray-400">Loading…</div>

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/auth/callback" element={<AuthCallback />} />

      <Route path="/dashboard" element={
        <RequireAuth><Dashboard /></RequireAuth>
      } />

      <Route path="/account" element={
        <RequireAuth><AccountSettings /></RequireAuth>
      } />

      {/* Desk admin / super admin only — gated inside AdminDashboard itself,
          since helpdesk admin is helpdesk.super_admins / agent_desks.role,
          not the shared public.profiles.role (see docs/HELPDESK_SPEC.md section 3). */}
      <Route path="/admin/*" element={
        <RequireAuth><AdminDashboard /></RequireAuth>
      } />

      <Route path="/d/:slug" element={<RequireAuth><Queue /></RequireAuth>} />
      <Route path="/d/:slug/t/:ticketNumber" element={<RequireAuth><Ticket /></RequireAuth>} />

      {/* Help center: deliberately NOT behind RequireAuth. Signed-out visitors
          read public articles (sign-in help has to be readable by people who
          cannot sign in); row-level security decides what each person sees. */}
      <Route path="/help" element={<Suspense fallback={helpFallback}><HelpCenter /></Suspense>} />
      <Route path="/help/:deskSlug/:articleSlug" element={<Suspense fallback={helpFallback}><HelpArticle /></Suspense>} />

      <Route path="/my-tickets" element={<RequireAuth><MyTickets /></RequireAuth>} />
      <Route path="/my-tickets/:ticketNumber" element={<RequireAuth><ReporterTicket /></RequireAuth>} />
    </Routes>
  )
}
