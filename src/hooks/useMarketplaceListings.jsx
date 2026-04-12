import React, { useState, useCallback, useEffect } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { setupDragGhost } from '../utils/dragUtils';
import { Dialog } from '../components/Dialog';

export function useMarketplaceListings(setNodes, takeSnapshot) {
  const [pendingListing, setPendingListing] = useState(null);
  const [listingUrlInput, setListingUrlInput] = useState('');

  useEffect(() => {
    if (!window.electronAPI?.onMonitoringActivity) return;
    return window.electronAPI.onMonitoringActivity(({ nodeId }) => {
      setNodes((nds) => nds.map((n) => {
        if (n.id === nodeId && n.type === 'listing') {
          return { ...n, data: { ...n.data, activityCount: (n.data.activityCount || 0) + 1 } };
        }
        return n;
      }));
    });
  }, [setNodes]);

  const onListingDragStart = useCallback((e, platform) => {
    e.dataTransfer.setData('app/node-type', `listing-${platform.id}`);
    e.dataTransfer.effectAllowed = 'copy';
    setupDragGhost(e, platform.name, platform.color);
  }, []);

  const triggerPendingListing = useCallback((position, platform) => {
    setPendingListing({ position, platform });
    setListingUrlInput('');
  }, []);

  const submitListingUrl = useCallback(async () => {
    if (!pendingListing) return;
    const { position, platform } = pendingListing;
    let label = `${platform} Listing`;
    if (window.electronAPI?.registerListing && listingUrlInput.trim()) {
      try {
        const result = await window.electronAPI.registerListing({ url: listingUrlInput, platform });
        if (result?.title) label = result.title;
      } catch (e) {
        console.error('Failed to register listing:', e);
      }
    }
    takeSnapshot();
    setNodes((nds) => nds.concat({
      id: uuidv4(), type: 'listing', position,
      data: { platform, url: listingUrlInput, label, monitoring: false, activityCount: 0, error: null },
    }));
    setPendingListing(null);
    setListingUrlInput('');
  }, [pendingListing, listingUrlInput, takeSnapshot, setNodes]);

  const listingDialog = pendingListing ? (
    <Dialog title={`Add ${pendingListing.platform} Listing`} onClose={() => setPendingListing(null)}>
      <p className="text-white/50 text-sm">Paste the listing URL to start tracking:</p>
      <input
        type="text"
        className="w-full bg-black/40 border border-white/10 rounded px-3 py-2 text-white font-mono text-sm outline-none"
        value={listingUrlInput}
        onChange={(e) => setListingUrlInput(e.target.value)}
        placeholder="https://..."
        autoFocus
        onKeyDown={(e) => { if (e.key === 'Enter') submitListingUrl(); }}
      />
      <div className="flex gap-2 mt-2">
        <button className="flex-1 bg-blue-500 hover:bg-blue-600 text-white rounded px-4 py-2 font-medium transition-colors" onClick={submitListingUrl}>Add</button>
        <button className="px-4 py-2 text-white/50 hover:text-white/80 transition-colors" onClick={() => setPendingListing(null)}>Cancel</button>
      </div>
    </Dialog>
  ) : null;

  return { onListingDragStart, triggerPendingListing, listingDialog };
}
