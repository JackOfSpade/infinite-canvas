import React from 'react';
import { EventLogger } from '../utils/EventLogger';
import { useHandoffBridgeStatus } from '../hooks/useHandoffBridgeStatus';

export class HandoffBridgeBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { failed: false, resetKey: props.resetKey };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  static getDerivedStateFromProps(props, state) {
    return props.resetKey !== state.resetKey ? { failed: false, resetKey: props.resetKey } : null;
  }

  componentDidCatch(error) {
    // The event ring is useful for a bug report, but error contents can include
    // untrusted data.  The constructor name is the only retained detail.
    const label = typeof this.props.label === 'string' ? this.props.label.slice(0, 40) : 'surface';
    const name = String(error?.name || 'Error').slice(0, 40);
    EventLogger.log(`[HandoffBridge] render failed in ${label}: ${name}`);
  }

  render() {
    if (this.state.failed) return this.props.fallback ?? null;
    return this.props.children;
  }
}

export function HandoffBridgeGuard({ children, fallback = null, label = 'surface' }) {
  const status = useHandoffBridgeStatus();
  return <HandoffBridgeBoundary resetKey={status.seq} label={label} fallback={fallback}>{children}</HandoffBridgeBoundary>;
}
