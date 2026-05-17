import React, { useState, useCallback } from 'react';
import { Camera, Maximize2 } from 'lucide-react';
import { toLocalFileUrl } from '../utils/fileDisplayUtils';
import { PhotoLightbox } from './PhotoLightbox';

/**
 * Horizontal photo thumbnail strip used by SellHub draft/priced states.
 * Renders up to `maxVisible` thumbnails; any extra are summarised in a "+N"
 * tile. Clicking any tile (including the "+N" overflow) opens a portal-based
 * lightbox at that image so the user can inspect at full size and page
 * through the set.
 *
 * All click handlers stopPropagation + nodrag so ReactFlow doesn't treat
 * tile clicks as the start of a node drag.
 */
export function PhotoStrip({ imagePaths = [], maxVisible = 4, size = 'md' }) {
  const [lightboxIndex, setLightboxIndex] = useState(null);

  const dim  = size === 'sm' ? 'h-6 text-[10px]' : 'h-10 text-xs';
  const tile = size === 'sm' ? 'h-12 w-12'      : 'h-16 w-16';

  const openAt = useCallback((i) => (e) => {
    e.stopPropagation();
    setLightboxIndex(i);
  }, [setLightboxIndex]);

  if (imagePaths.length === 0) {
    return (
      <div className={`${dim} flex items-center gap-1 text-white/15`}>
        <Camera size={size === 'sm' ? 10 : 12} />
        No photos
      </div>
    );
  }

  const visible  = imagePaths.slice(0, maxVisible);
  const overflow = Math.max(0, imagePaths.length - maxVisible);

  return (
    <>
      <div className="flex gap-1 overflow-x-auto pb-1">
        {visible.map((p, i) => (
          <button
            key={i}
            type="button"
            onClick={openAt(i)}
            onPointerDown={(e) => e.stopPropagation()}
            className={`nodrag ${tile} shrink-0 rounded border border-white/10 hover:border-white/40 overflow-hidden relative group transition-colors`}
            title="Click to view full size"
          >
            <img
              src={toLocalFileUrl(p)}
              alt={`Product photo ${i + 1}`}
              className="w-full h-full object-cover pointer-events-none"
              onError={(e) => { e.currentTarget.style.display = 'none'; }}
              draggable={false}
            />
            <div className="absolute inset-0 bg-black/0 group-hover:bg-black/40 transition-colors flex items-center justify-center opacity-0 group-hover:opacity-100">
              <Maximize2 size={size === 'sm' ? 10 : 14} className="text-white/90" />
            </div>
          </button>
        ))}
        {overflow > 0 && (
          <button
            type="button"
            // The "+N" tile opens the lightbox at the first hidden image so
            // the user lands on what they couldn't see in the strip.
            onClick={openAt(maxVisible)}
            onPointerDown={(e) => e.stopPropagation()}
            className={`nodrag ${tile} rounded border border-white/10 bg-black/20 hover:bg-black/40 hover:border-white/30 flex items-center justify-center shrink-0 text-white/40 hover:text-white/80 text-[10px] transition-colors`}
            title={`View all ${imagePaths.length} photos`}
          >
            +{overflow}
          </button>
        )}
      </div>

      {lightboxIndex !== null && (
        <PhotoLightbox
          imagePaths={imagePaths}
          initialIndex={lightboxIndex}
          onClose={() => setLightboxIndex(null)}
        />
      )}
    </>
  );
}
