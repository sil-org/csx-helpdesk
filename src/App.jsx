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

      <Route path="/my-tickets" element={<RequireAuth><MyTickets /></RequireAuth>} />
      <Route path="/my-tickets/:ticketNumber" element={<RequireAuth><ReporterTicket /></RequireAuth>} />
    </Routes>
  )
}
