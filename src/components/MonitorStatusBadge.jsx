import React from 'react';
import { CheckCircle2, AlertCircle, Circle, LogIn } from 'lucide-react';
import { MARKETPLACE_STATUS_LABELS } from './monitorStatusLabels';

/**
 * Shared status pill for any node that polls a URL via `check-listing-status`.
 * Both MarketplaceCardNode and JobCardNode render this with their own label
 * vocabulary (sold vs filled, expired vs closed, etc.) but the same six
 * underlying status codes from the AI classifier.
 */

const META = {
  live:          { icon: CheckCircle2, color: 'text-emerald-400', bg: 'bg-emerald-500/15 border-emerald-500/30' },
  sold:          { icon: CheckCircle2, color: 'text-blue-400',    bg: 'bg-blue-500/15 border-blue-500/30' },
  ended:         { icon: AlertCircle,  color: 'text-amber-400',   bg: 'bg-amber-500/15 border-amber-500/30' },
  // back-compat: nodes saved before the `expired` → `ended` rename still render correctly.
  expired:       { icon: AlertCircle,  color: 'text-amber-400',   bg: 'bg-amber-500/15 border-amber-500/30' },
  'needs-login': { icon: LogIn,        color: 'text-yellow-300',  bg: 'bg-yellow-500/15 border-yellow-500/30' },
  error:         { icon: AlertCircle,  color: 'text-red-400',     bg: 'bg-red-500/15 border-red-500/30' },
  unknown:       { icon: Circle,       color: 'text-white/40',    bg: 'bg-white/5 border-white/10' },
};

export function MonitorStatusBadge({
  status,
  lastChecked,
  labels = MARKETPLACE_STATUS_LABELS,
  className = '',
}) {
  const meta = META[status] || META.unknown;
  const Icon = meta.icon;
  const lastDisplay = lastChecked
    ? new Date(lastChecked).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })
    : '';
  const label = labels[status] || labels.unknown || status;

  return (
    <div className={`flex items-center gap-1.5 px-2 py-1 rounded-md border text-[10px] ${meta.bg} ${className}`}>
      <Icon size={11} className={meta.color} />
      <span className={`font-medium ${meta.color}`}>{label}</span>
      {lastDisplay && <span className="text-white/30 ml-auto">{lastDisplay}</span>}
    </div>
  );
}
