import React, { useState, useEffect, useRef } from 'react';
import { Handle, Position, useReactFlow } from '@xyflow/react';
import { ContextMenu } from '../components/ContextMenu';
import { Dialog } from '../components/Dialog';
import { FontSizeDialog } from '../components/FontSizeDialog';
import { SignalResultsDialog } from '../components/SignalResultsDialog';
import { useContextMenu } from '../hooks/useContextMenu';
import { RefreshCw, Loader2, CheckCircle2 } from 'lucide-react';
import { PLATFORM_COLORS } from '../utils/platforms';

/**
 * ListingNode — a marketplace listing monitor node powered by Gemini AI.
 *
 * data shape:
 *   platform      — 'ebay' | 'amazon' | 'craigslist' | 'custom'
 *   url           — listing URL
 *   label         — display text (scraped title or user-edited)
 *   activityCount — number of unread activities
 *   activities    — array of signals from last Gemini check
 *   lastChecked   — timestamp of last check
 *   error         — { type, message } | null
 *   fontSize      — number
 *   fontFamily    — string
 */
export function ListingNode({ id, data }) {
  const platform = data.platform || 'custom';
  const color = PLATFORM_COLORS[platform] || PLATFORM_COLORS.custom;
  const activityCount = data.activityCount || 0;
  const error = data.error || null;
  const activities = data.activities || [];
  const lastChecked = data.lastChecked || null;

  const [isEditing, setIsEditing] = useState(false);
  const [isChecking, setIsChecking] = useState(false);
  const { contextMenu, onContextMenu, closeContextMenu } = useContextMenu();
  const [showDialog, setShowDialog] = useState(null); // 'font' | 'url' | 'activity'
  const [urlInput, setUrlInput] = useState(data.url || '');

  const fontSize = data.fontSize || 14;
  const fontFamily = data.fontFamily || 'sans-serif';

  const { updateNodeData, deleteElements } = useReactFlow();
  const labelRef = useRef(null);

  // Sync label content when data changes externally
  useEffect(() => {
    if (!isEditing && labelRef.current) {
      const expected = data.label || data.url || 'Listing';
      if (labelRef.current.innerText !== expected) {
        labelRef.current.innerText = expected;
      }
    }
  }, [data.label, data.url, isEditing]);

  const handleDoubleClick = (e) => {
    e.stopPropagation();
    setIsEditing(true);
    setTimeout(() => {
      if (labelRef.current) labelRef.current.focus({ preventScroll: true });
    }, 0);
  };

  const handleBlur = () => {
    setIsEditing(false);
    const newLabel = labelRef.current?.innerText?.trim() || '';
    if (newLabel === '') {
      deleteElements({ nodes: [{ id }] });
      return;
    }
    updateNodeData(id, { label: newLabel });
  };

  // ── Gemini-powered check ──────────────────────────────────────────────────
  const checkListing = async () => {
    if (isChecking || !data.url) return;
    setIsChecking(true);
    updateNodeData(id, { error: null });

    try {
      if (!window.electronAPI?.checkListing) {
        throw new Error('Check not available outside Electron');
      }

      const result = await window.electronAPI.checkListing({
        url: data.url,
        platform,
      });

      if (result.success) {
        // Update title if Gemini found one and user hasn't custom-edited
        const updates = {
          activities: result.signals,
          activityCount: result.signals.length,
          lastChecked: result.checkedAt,
          error: null,
        };
        if (result.title && result.title !== 'Not a listing page' && !data.label) {
          updates.label = result.title;
        }
        updateNodeData(id, updates);
      } else {
        updateNodeData(id, {
          error: { type: 'check-failed', message: result.error },
        });
      }
    } catch (err) {
      updateNodeData(id, {
        error: { type: 'check-failed', message: err.message },
      });
    } finally {
      setIsChecking(false);
    }
  };

  const applyUrl = () => {
    updateNodeData(id, { url: urlInput });
    setShowDialog(null);
  };

  const markAllRead = () => {
    updateNodeData(id, {
      activityCount: 0,
      activities: activities.map(a => ({ ...a, read: true })),
    });
  };

  const markRead = (activityId) => {
    const updated = activities.map(a =>
      a.id === activityId ? { ...a, read: true } : a
    );
    const unreadCount = updated.filter(a => !a.read).length;
    updateNodeData(id, { activities: updated, activityCount: unreadCount });
  };

  // ── Context menu ──────────────────────────────────────────────────────────
  const menuItems = [
    {
      label: data.url ? '🔍 Check Listing' : '🔗 Set URL first',
      onClick: data.url ? checkListing : () => setShowDialog('url'),
    },
    {
      label: 'Edit Link URL',
      onClick: () => setShowDialog('url'),
    },
    { divider: true },
    {
      label: `📋 View Signals${activities.length > 0 ? ` (${activities.length})` : ''}`,
      onClick: () => setShowDialog('activity'),
    },
    { divider: true },
    {
      label: 'Font & Size',
      onClick: () => setShowDialog('font'),
    },
  ];

  return (
    <div className="relative group px-1">
      <Handle type="target" position={Position.Left} className="w-2 h-2 opacity-0 group-hover:opacity-100 transition-opacity" style={{ background: color }} />

      {/* Main label row */}
      <div className="flex items-center gap-1.5">
        <div
          ref={labelRef}
          contentEditable={isEditing}
          suppressContentEditableWarning
          onDoubleClick={handleDoubleClick}
          onBlur={handleBlur}
          onKeyDown={(e) => { if (e.key === 'Escape') labelRef.current.blur(); }}
          onPointerDown={(e) => { if (isEditing) e.stopPropagation(); }}
          onContextMenu={onContextMenu}
          className={`whitespace-nowrap outline-none min-w-[10px] select-none ${isEditing ? 'cursor-text' : 'cursor-default'}`}
          style={{ fontSize: `${fontSize}px`, fontFamily, color }}
        >
          {data.label || data.url || 'Listing'}
        </div>

        {/* Check button — visible on hover */}
        {data.url && (
          <button
            onClick={(e) => { e.stopPropagation(); checkListing(); }}
            disabled={isChecking}
            className={`shrink-0 p-0.5 rounded transition-all ${
              isChecking
                ? 'opacity-100'
                : 'opacity-0 group-hover:opacity-70 hover:!opacity-100'
            }`}
            title={isChecking ? 'Analyzing with Gemini AI...' : 'Check listing (Gemini AI)'}
          >
            {isChecking ? (
              <Loader2 size={13} className="animate-spin" style={{ color }} />
            ) : (
              <RefreshCw size={12} style={{ color: color + '99' }} />
            )}
          </button>
        )}
      </div>

      {/* Badge — shows unread signal count */}
      {activityCount > 0 && !error && (
        <button
          className="absolute -top-2 -right-3 min-w-[18px] h-[18px] rounded-full flex items-center justify-center text-[10px] font-bold text-white leading-none px-1 bg-red-500 hover:bg-red-600 transition-colors cursor-pointer"
          onClick={(e) => { e.stopPropagation(); setShowDialog('activity'); }}
          title={`${activityCount} signal${activityCount !== 1 ? 's' : ''} found`}
        >
          {activityCount}
        </button>
      )}

      {/* Checked indicator — subtle green dot when checked with no signals */}
      {lastChecked && activityCount === 0 && !error && (
        <div
          className="absolute -top-1 -right-2 flex items-center"
          title={`Last checked at ${lastChecked}`}
        >
          <CheckCircle2 size={12} className="text-green-500/60" />
        </div>
      )}

      {/* Error indicator */}
      {error && (
        <div
          className="absolute -top-2 -right-3 min-w-[18px] h-[18px] flex items-center justify-center text-[12px] leading-none cursor-help"
          title={error.message || 'Check failed'}
        >
          ⚠️
        </div>
      )}

      <Handle type="source" position={Position.Right} className="w-2 h-2 opacity-0 group-hover:opacity-100 transition-opacity" style={{ background: color }} />

      {/* Context Menu */}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={menuItems}
          onClose={closeContextMenu}
        />
      )}

      {/* Font & Size Dialog */}
      {showDialog === 'font' && (
        <FontSizeDialog
          fontSize={fontSize}
          fontFamily={fontFamily}
          onApply={({ fontSize: fs, fontFamily: ff }) => updateNodeData(id, { fontSize: fs, fontFamily: ff })}
          onClose={() => setShowDialog(null)}
        />
      )}

      {/* Edit URL Dialog */}
      {showDialog === 'url' && (
        <Dialog title="Edit Listing URL" onClose={() => setShowDialog(null)}>
          <p className="text-white/40 text-xs mb-2">Paste the listing URL, then right-click → &quot;Check Listing&quot;</p>
          <input
            type="text"
            className="w-full bg-black/40 border border-white/10 rounded px-3 py-2 text-white font-mono text-sm outline-none"
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            placeholder="https://www.ebay.com/itm/..."
            autoFocus
            onKeyDown={(e) => { if (e.key === 'Enter') applyUrl(); }}
          />
          <button className="bg-blue-500 hover:bg-blue-600 text-white rounded px-4 py-2 mt-2 font-medium transition-colors" onClick={applyUrl}>Done</button>
        </Dialog>
      )}

      {/* Signal Results Dialog */}
      {showDialog === 'activity' && (
        <SignalResultsDialog
          signals={activities}
          lastChecked={lastChecked}
          platform={platform}
          color={color}
          onClose={() => setShowDialog(null)}
          onMarkRead={markRead}
          onMarkAllRead={markAllRead}
          onRecheck={checkListing}
          isChecking={isChecking}
        />
      )}
    </div>
  );
}
