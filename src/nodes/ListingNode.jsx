import React, { useState, useEffect, useRef } from 'react';
import { Handle, Position, useReactFlow } from '@xyflow/react';
import { ContextMenu } from '../components/ContextMenu';
import { Dialog } from '../components/Dialog';
import { FontSizeDialog } from '../components/FontSizeDialog';
import { useContextMenu } from '../hooks/useContextMenu';

/**
 * Platform color map — maps platform ID to its brand color.
 */
const PLATFORM_COLORS = {
  ebay: '#e53238',
  amazon: '#ff9900',
  craigslist: '#5a1a8a',
  custom: '#10b981',
};

/**
 * Error messages and suggested fixes for each error type.
 */
const ERROR_MESSAGES = {
  'session-expired': { short: '⚠️ Session expired', fix: 'Please log into {platform} in your browser first' },
  'url-not-recognized': { short: '⚠️ URL not recognized', fix: "This doesn't look like a {platform} listing URL" },
  'rate-limited': { short: '⚠️ Rate limited', fix: 'Checking too frequently, slowing down automatically' },
  'site-unreachable': { short: '⚠️ Site unreachable', fix: "Can't reach {platform} right now, will retry" },
};

/**
 * ListingNode — a marketplace listing monitor node.
 *
 * data shape:
 *   platform      — 'ebay' | 'amazon' | 'craigslist' | 'custom'
 *   url           — listing URL
 *   label         — display text (scraped title or user-edited)
 *   monitoring    — boolean, whether actively monitoring
 *   activityCount — number of unread activities
 *   error         — { type, message } | null
 *   fontSize      — number
 *   fontFamily    — string
 */
export function ListingNode({ id, data }) {
  const platform = data.platform || 'custom';
  const color = PLATFORM_COLORS[platform] || PLATFORM_COLORS.custom;
  const monitoring = data.monitoring || false;
  const activityCount = data.activityCount || 0;
  const error = data.error || null;

  const [isEditing, setIsEditing] = useState(false);
  const { contextMenu, onContextMenu, closeContextMenu } = useContextMenu();
  const [showDialog, setShowDialog] = useState(null); // 'font' | 'url' | 'settings' | 'activity'
  const [urlInput, setUrlInput] = useState(data.url || '');
  const [frequency, setFrequency] = useState(data.frequency || 60);

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
      // Auto-remove node when label is fully deleted
      deleteElements({ nodes: [{ id }] });
      return;
    }
    updateNodeData(id, { label: newLabel });
  };

  // --- Monitoring actions (all call dummy IPC) ---

  const startMonitoring = async () => {
    if (window.electronAPI?.startMonitoring) {
      await window.electronAPI.startMonitoring({ id });
    }
    updateNodeData(id, { monitoring: true, error: null });
  };

  const stopMonitoring = async () => {
    if (window.electronAPI?.stopMonitoring) {
      await window.electronAPI.stopMonitoring({ id });
    }
    updateNodeData(id, { monitoring: false, activityCount: 0, error: null });
  };

  const applyUrl = () => {
    updateNodeData(id, { url: urlInput });
    setShowDialog(null);
  };

  const applySettings = async () => {
    if (window.electronAPI?.updateMonitorSettings) {
      await window.electronAPI.updateMonitorSettings({ id, frequency });
    }
    updateNodeData(id, { frequency });
    setShowDialog(null);
  };

  // --- Context menu items ---
  const menuItems = [
    {
      label: 'Edit Link URL',
      onClick: () => setShowDialog('url'),
    },
    {
      label: 'Monitor',
      submenu: [
        {
          label: monitoring ? '⏹ Stop Monitoring' : '▶ Start Monitoring',
          onClick: monitoring ? stopMonitoring : startMonitoring,
        },
        {
          label: '⚙ Monitor Settings',
          onClick: () => setShowDialog('settings'),
        },
        { divider: true },
        {
          label: '📋 View Activity Log',
          onClick: () => setShowDialog('activity'),
        },
      ],
    },
    { divider: true },
    {
      label: 'Font & Size',
      onClick: () => setShowDialog('font'),
    },
  ];

  // --- Error tooltip text ---
  const errorTooltip = error
    ? (ERROR_MESSAGES[error.type]?.fix || error.message || 'Unknown error').replace('{platform}', platform)
    : null;

  return (
    <div className="relative group px-1">
      <Handle type="target" position={Position.Left} className="w-2 h-2 opacity-0 group-hover:opacity-100 transition-opacity" style={{ background: color }} />

      {/* Main label */}
      <div
        ref={labelRef}
        contentEditable={isEditing}
        suppressContentEditableWarning
        onDoubleClick={handleDoubleClick}
        onBlur={handleBlur}
        onKeyDown={(e) => { if (e.key === 'Escape') labelRef.current.blur(); }}
        onPointerDown={(e) => { if (isEditing) e.stopPropagation(); }}
        onContextMenu={onContextMenu}
        className={`whitespace-nowrap outline-none min-w-[10px] select-none ${isEditing ? 'cursor-text' : 'cursor-default'} ${monitoring ? 'monitoring-pulse' : ''}`}
        style={{ fontSize: `${fontSize}px`, fontFamily, color }}
      >
        {data.label || data.url || 'Listing'}
      </div>

      {/* Badge — positioned top-right of text */}
      {monitoring && !error && (
        <div
          className={`absolute -top-2 -right-3 min-w-[18px] h-[18px] rounded-full flex items-center justify-center text-[10px] font-bold text-white leading-none px-1 ${
            activityCount > 0 ? 'bg-red-500' : 'bg-gray-500'
          }`}
        >
          {activityCount}
        </div>
      )}

      {/* Error badge */}
      {error && (
        <div
          className="absolute -top-2 -right-3 min-w-[18px] h-[18px] flex items-center justify-center text-[12px] leading-none cursor-help"
          title={errorTooltip}
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
        <Dialog title="Edit Link URL" onClose={() => setShowDialog(null)}>
          <input
            type="text"
            className="w-full bg-black/40 border border-white/10 rounded px-3 py-2 text-white font-mono text-sm outline-none"
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            placeholder="https://..."
            autoFocus
            onKeyDown={(e) => { if (e.key === 'Enter') applyUrl(); }}
          />
          <button className="bg-blue-500 hover:bg-blue-600 text-white rounded px-4 py-2 mt-2 font-medium transition-colors" onClick={applyUrl}>Done</button>
        </Dialog>
      )}

      {/* Monitor Settings Dialog */}
      {showDialog === 'settings' && (
        <Dialog title="Monitor Settings" onClose={() => setShowDialog(null)} width="w-72">
          <div className="flex justify-between items-center gap-2">
            <label className="text-white/70 text-sm">Check every</label>
            <select
              className="flex-1 bg-black/40 border border-white/10 rounded px-2 py-1 text-white text-sm outline-none"
              value={frequency}
              onChange={(e) => setFrequency(Number(e.target.value))}
            >
              <option value={30}>30 seconds</option>
              <option value={60}>1 minute</option>
              <option value={300}>5 minutes</option>
              <option value={900}>15 minutes</option>
              <option value={1800}>30 minutes</option>
              <option value={3600}>1 hour</option>
            </select>
          </div>
          <button className="bg-blue-500 hover:bg-blue-600 text-white rounded px-4 py-2 mt-2 font-medium transition-colors" onClick={applySettings}>Save</button>
        </Dialog>
      )}

      {/* Activity Log — inline panel rendered via portal */}
      {showDialog === 'activity' && <ActivityLogInline id={id} platform={platform} color={color} onClose={() => setShowDialog(null)} onUpdateCount={(count) => updateNodeData(id, { activityCount: count })} />}
    </div>
  );
}

/**
 * Inline Activity Log panel — fetches and displays activity entries.
 * Rendered as a portal so it floats above everything.
 */
function ActivityLogInline({ id, platform, color, onClose, onUpdateCount }) {
  const [activities, setActivities] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchLog = async () => {
      setLoading(true);
      if (window.electronAPI?.getActivityLog) {
        const result = await window.electronAPI.getActivityLog({ id });
        setActivities(result.activities || []);
      }
      setLoading(false);
    };
    fetchLog();
  }, [id]);

  const markRead = (activityId) => {
    setActivities((prev) => {
      const updated = prev.map((a) =>
        a.id === activityId ? { ...a, read: true } : a
      );
      const unreadCount = updated.filter((a) => !a.read).length;
      onUpdateCount(unreadCount);
      return updated;
    });
  };

  return (
    <Dialog title={`Activity Log — ${platform}`} onClose={onClose} width="w-96">
      {loading ? (
        <div className="text-white/40 text-sm text-center py-4">Loading...</div>
      ) : activities.length === 0 ? (
        <div className="text-white/40 text-sm text-center py-4">No activity yet</div>
      ) : (
        <div className="flex flex-col gap-2 max-h-64 overflow-y-auto custom-scrollbar">
          {activities.map((activity) => (
            <button
              key={activity.id}
              className={`text-left p-3 rounded-lg border transition-colors ${
                activity.read
                  ? 'bg-white/5 border-white/5 opacity-60'
                  : 'bg-white/10 border-white/10 hover:bg-white/15'
              }`}
              onClick={() => {
                if (!activity.read) markRead(activity.id);
              }}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium" style={{ color }}>
                  {activity.type}
                </span>
                <span className="text-white/30 text-[10px]">{activity.timestamp}</span>
              </div>
              <p className="text-white/80 text-sm mt-1">{activity.description}</p>
              {!activity.read && (
                <span className="inline-block mt-1 text-[10px] text-blue-400">● unread</span>
              )}
            </button>
          ))}
        </div>
      )}
    </Dialog>
  );
}
