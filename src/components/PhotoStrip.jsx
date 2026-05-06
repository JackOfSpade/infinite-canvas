import React from 'react';
import { Camera } from 'lucide-react';
import { toLocalFileUrl } from '../utils/fileDisplayUtils';

/**
 * Horizontal photo thumbnail strip used by SellHub draft/priced states.
 * Renders up to 4 thumbnails; any extra are summarised in a "+N" tile.
 * Falls back to a "No photos" placeholder when no paths are provided.
 */
export function PhotoStrip({ imagePaths = [], maxVisible = 4, size = 'md' }) {
  const dim = size === 'sm' ? 'h-6 text-[10px]' : 'h-10 text-xs';
  const tile = size === 'sm' ? 'h-12 w-12' : 'h-16 w-16';

  if (imagePaths.length === 0) {
    return (
      <div className={`${dim} flex items-center gap-1 text-white/15`}>
        <Camera size={size === 'sm' ? 10 : 12} />
        No photos
      </div>
    );
  }

  const visible = imagePaths.slice(0, maxVisible);
  const overflow = Math.max(0, imagePaths.length - maxVisible);

  return (
    <div className="flex gap-1 overflow-x-auto pb-1">
      {visible.map((p, i) => (
        <img
          key={i}
          src={toLocalFileUrl(p)}
          alt={`Product photo ${i + 1}`}
          className={`${tile} object-cover rounded shrink-0 border border-white/10`}
          onError={(e) => { e.currentTarget.style.display = 'none'; }}
        />
      ))}
      {overflow > 0 && (
        <div className={`${tile} rounded border border-white/10 bg-black/20 flex items-center justify-center shrink-0 text-white/30 text-[10px]`}>
          +{overflow}
        </div>
      )}
    </div>
  );
}
