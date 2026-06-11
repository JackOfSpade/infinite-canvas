import React, { useState } from 'react';
import { ChevronDown, ChevronRight, AlertTriangle, Info, ExternalLink } from 'lucide-react';

/**
 * AttentionPanels — splits AI-surfaced items into two lanes so the visual
 * weight matches the actual stakes:
 *
 *   - Urgent: items the prompt classified as `urgency: 'high'` (offer
 *     expiring, suspension, dispute response due, payout held, etc.).
 *     Defaults to open — burying these behind a click defeats the point.
 *   - Info: low-urgency FYI items (new watchers, price suggestions,
 *     edit recommendations). Defaults to closed.
 *
 * Each lane renders only if it has items, so a quiet result shows nothing.
 *
 * Shared by the Marketplace Status Module (per-platform hub scan) and formerly
 * the per-listing card check.
 */
export function AttentionPanels({ items }) {
  if (!Array.isArray(items) || items.length === 0) return null;
  const urgent = items.filter(i => i.urgency === 'high');
  const info   = items.filter(i => i.urgency !== 'high');
  return (
    <div className="space-y-1.5">
      {urgent.length > 0 && (
        <AttentionLane
          items={urgent}
          label="Action Needed"
          icon={<AlertTriangle size={10} className="text-red-400" />}
          defaultOpen
          accent={{
            badge: 'bg-red-500/30 text-red-200',
            item:  'bg-red-500/10 border-red-500/30',
            text:  'text-red-200',
          }}
        />
      )}
      {info.length > 0 && (
        <AttentionLane
          items={info}
          label="Info"
          icon={<Info size={10} className="text-sky-400" />}
          accent={{
            badge: 'bg-sky-500/20 text-sky-200',
            item:  'bg-sky-500/[0.07] border-sky-500/20',
            text:  'text-sky-100',
          }}
        />
      )}
    </div>
  );
}

function AttentionLane({ items, label, icon, accent, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <button
        onClick={() => setOpen(v => !v)}
        onPointerDown={(e) => e.stopPropagation()}
        className="nodrag w-full flex items-center gap-1.5 px-2 py-1 rounded-md border bg-white/5 border-white/10 hover:bg-white/10 transition-colors"
        title={label === 'Action Needed' ? 'Items the AI thinks need your action' : 'FYI items — nothing requires action'}
      >
        {open ? <ChevronDown size={10} className="text-white/60" /> : <ChevronRight size={10} className="text-white/60" />}
        {icon}
        <span className="text-[10px] font-medium text-white/80">{label}</span>
        <span className={`ml-auto text-[9px] font-bold leading-none px-1.5 py-0.5 rounded-full ${accent.badge}`}>
          {items.length}
        </span>
      </button>
      {open && (
        // data-collapsible-body: the Marketplace Status grid subtracts this
        // body's height when measuring a card so expanding a lane never
        // re-lays-out the grid (only the collapsed card is fitted to 16:9).
        <ul data-collapsible-body className="mt-1.5 space-y-1.5">
          {items.map((item, i) => (
            <li
              key={`${item.headline}-${i}`}
              className={`px-2 py-1.5 rounded-md border text-[10px] leading-snug ${accent.item}`}
            >
              <div className={`font-medium ${accent.text}`}>{item.headline}</div>
              {item.evidence && (
                <div className="text-white/40 text-[9px] mt-0.5 italic break-words">
                  &ldquo;{item.evidence}&rdquo;
                </div>
              )}
              {item.sourceUrl && (
                <button
                  onClick={() => window.electronAPI?.openExternal?.(item.sourceUrl)}
                  onPointerDown={(e) => e.stopPropagation()}
                  className="nodrag mt-1 flex items-center gap-1 px-1.5 py-0.5 rounded border border-white/15 bg-white/5 hover:bg-white/15 text-white/70 text-[9px] font-medium transition-colors"
                  title={`Open the page this was found on:\n${item.sourceUrl}`}
                >
                  <ExternalLink size={9} /> Open page
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
