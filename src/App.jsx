import React from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Canvas } from './Canvas';
import { ToastProvider } from './components/ToastProvider';
import { SessionStatusProvider } from './contexts/SessionStatusContext';
import './index.css';

import { ErrorBoundary } from './components/ErrorBoundary';

export default function App() {
  return (
    <ErrorBoundary>
      <SessionStatusProvider>
        <ToastProvider>
          <ReactFlowProvider>
            <Canvas />
          </ReactFlowProvider>
        </ToastProvider>
      </SessionStatusProvider>
    </ErrorBoundary>
  );
}
