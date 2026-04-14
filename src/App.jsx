import React from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Canvas } from './Canvas';
import { ToastProvider } from './components/ToastProvider';
import './index.css';

export default function App() {
  return (
    <ToastProvider>
      <ReactFlowProvider>
        <Canvas />
      </ReactFlowProvider>
    </ToastProvider>
  );
}
