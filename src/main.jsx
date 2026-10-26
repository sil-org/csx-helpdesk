import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { AuthProvider } from './context/AuthContext'
import { HelpdeskProvider } from './context/HelpdeskContext'
import App from './App'
import './index.css'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <HelpdeskProvider>
          <App />
        </HelpdeskProvider>
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>
)
