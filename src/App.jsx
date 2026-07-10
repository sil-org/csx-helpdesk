import { Routes, Route } from 'react-router-dom'
import Home from './pages/Home'
import AuthCallback from './pages/AuthCallback'
import Dashboard from './pages/Dashboard'
import AccountSettings from './pages/AccountSettings'
import AdminDashboard from './pages/admin/Dashboard'
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

      <Route path="/admin/*" element={
        <RequireAuth role="admin"><AdminDashboard /></RequireAuth>
      } />
    </Routes>
  )
}
