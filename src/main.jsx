import { createElement, lazy, StrictMode, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'

const activeView = lazy(() => import('./App.jsx'));

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <Suspense fallback={<main role="status" aria-live="polite" aria-label="Loading view" className="min-h-screen bg-[#111018] p-4 text-sm text-violet-100">Loading view…</main>}>
      {createElement(activeView)}
    </Suspense>
  </StrictMode>,
)
