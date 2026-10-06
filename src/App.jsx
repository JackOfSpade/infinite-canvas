import React from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { ToastProvider } from './components/ToastProvider';
import { SessionStatusProvider } from './contexts/SessionStatusContext';
import { ModuleRunQueueProvider } from './contexts/ModuleRunQueueContext';
import { JobSearchCoordinatorProvider } from './contexts/JobSearchCoordinatorContext';
import './index.css';

import { ErrorBoundary } from './components/ErrorBoundary';
import { NonApiAiDialog } from './components/NonApiAiDialog';
import { HandoffBridgeGuard } from './components/HandoffBridgeBoundary';
import { HandoffBridgePanel } from './components/HandoffBridgePanel';
import { HandoffBridgeSetupDialog } from './components/HandoffBridgeSetupDialog';

// The canvas owns the node implementations and most of the interaction
// surface. Keep it out of the tiny application shell so Electron can paint
// the providers and handoff recovery UI while the canvas chunk is loading.
const Canvas = React.lazy(() => import('./Canvas').then(module => ({ default: module.Canvas })));

export default function App() {
  return (
    <>
      <ErrorBoundary>
        <SessionStatusProvider>
          <ToastProvider>
            <ModuleRunQueueProvider>
              <JobSearchCoordinatorProvider>
                <ReactFlowProvider>
                  <React.Suspense fallback={null}>
                    <Canvas />
                  </React.Suspense>
                </ReactFlowProvider>
              </JobSearchCoordinatorProvider>
            </ModuleRunQueueProvider>
          </ToastProvider>
        </SessionStatusProvider>
      </ErrorBoundary>
      {/* Keep an already-issued manual handoff usable if Canvas hits its error
          boundary. The dialog needs no canvas/provider context, and it still
          gives the user an explicit cancel route instead of orphaning a main
          process promise behind the fallback screen. */}
      <NonApiAiDialog />
      <HandoffBridgeGuard label="panel">
        <HandoffBridgePanel />
      </HandoffBridgeGuard>
      {/* Kept independent from the panel boundary: Settings can still open
          setup if a popover-only render fault was isolated. */}
      <HandoffBridgeGuard label="setup">
        <HandoffBridgeSetupDialog />
      </HandoffBridgeGuard>
    </>
  );
}
