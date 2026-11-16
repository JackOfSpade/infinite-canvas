import { createElement, lazy, StrictMode, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import '../index.css'

// Renderer entry of the standalone Interview Helper app. It never imports the
// canvas, so a canvas change cannot break or stale this app's build.
// One separate lazy() call per view: the bundler then emits each view's own
// preload list, so each window loads only its own code and stylesheets.
const view = new URLSearchParams(window.location.search).get('view');
const isInterviewWindow = view === 'interview' && typeof window.interviewAPI?.getBrief === 'function';
const isPracticeCallWindow = view === 'practice-call' && typeof window.practiceCallAPI?.getState === 'function';
const activeView = isInterviewWindow
  ? lazy(() => import('../interview-window/CueCardApp.jsx'))
  : isPracticeCallWindow
    ? lazy(() => import('../practice-call/PracticeCallApp.jsx'))
    : lazy(() => import('./InterviewHelperApp.jsx'));

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <Suspense fallback={isInterviewWindow ? null : <main role="status" aria-live="polite" aria-label="Loading view" className="min-h-screen bg-[#111018] p-4 text-sm text-violet-100">Loading view…</main>}>
      {createElement(activeView)}
    </Suspense>
  </StrictMode>,
)
