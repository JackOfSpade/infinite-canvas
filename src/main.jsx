import { createElement, lazy, StrictMode, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'

// Keep the dedicated interview companion genuinely narrow at startup. A
// static App import would pull the canvas graph (and its renderer-only module
// side effects) into this compact child even though it never renders App.
const isInterviewWindow = new URLSearchParams(window.location.search).get('view') === 'interview'
  && typeof window.interviewAPI?.getBrief === 'function';
const isPracticeCallWindow = new URLSearchParams(window.location.search).get('view') === 'practice-call'
  && typeof window.practiceCallAPI?.getState === 'function';
// One separate lazy() call per view, not one shared lazy with a ternary: the
// bundler then emits each view's own preload list, so the dedicated views'
// stylesheets actually load and the canvas graph stays out of them.
const activeView = isInterviewWindow
  ? lazy(() => import('./interview-window/InterviewWindowApp.jsx'))
  : isPracticeCallWindow
    ? lazy(() => import('./practice-call/PracticeCallApp.jsx'))
    : lazy(() => import('./App.jsx'));

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <Suspense fallback={<main role="status" aria-live="polite" aria-label="Loading view" className="min-h-screen bg-[#111018] p-4 text-sm text-violet-100">Loading view…</main>}>
      {createElement(activeView)}
    </Suspense>
  </StrictMode>,
)
