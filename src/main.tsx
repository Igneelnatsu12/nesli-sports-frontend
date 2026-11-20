import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import AdminPortal from './Admin'
import './styles.css'

const isAdminRoute = window.location.pathname.replace(/\/+$/, '') === '/admin'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {isAdminRoute ? <AdminPortal onClose={() => { window.location.href = '/' }} /> : <App />}
  </React.StrictMode>
)
