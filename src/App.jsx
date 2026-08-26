import React from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Canvas } from './Canvas';
import { ToastProvider } from './components/ToastProvider';
import { SessionStatusProvider } from './contexts/SessionStatusContext';
import { ModuleRunQueueProvider } from './contexts/ModuleRunQueueContext';
import './index.css';

import { ErrorBoundary } from './components/ErrorBoundary';
import { NonApiAiDialog } from './components/NonApiAiDialog';

export default function App() {
  return (
    <>
      <ErrorBoundary>
        <SessionStatusProvider>
          <ToastProvider>
            <ModuleRunQueueProvider>
              <ReactFlowProvider>
                <Canvas />
              </ReactFlowProvider>
            </ModuleRunQueueProvider>
          </ToastProvider>
        </SessionStatusProvider>
      </ErrorBoundary>
      {/* Keep an already-issued manual handoff usable if Canvas hits its error
          boundary. The dialog needs no canvas/provider context, and it still
          gives the user an explicit cancel route instead of orphaning a main
          process promise behind the fallback screen. */}
      <NonApiAiDialog />
    </>
  );
}
