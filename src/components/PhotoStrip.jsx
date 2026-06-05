import React, { useState, useCallback, useRef } from 'react';
import { Camera, ImageOff, Maximize2, Trash2, Upload } from 'lucide-react';
import { toLocalFilePreviewUrl } from '../utils/fileDisplayUtils';
import { PhotoLightbox } from './PhotoLightbox';
import { PRODUCT_IMAGE_EXT_RE } from '../utils/fileExtensions';

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
export function PhotoStrip({
  imagePaths = [],
  maxVisible = 4,
  size = 'md',
  editable = false,
  onRemoveImage,
  onAddImages,
}) {
  const [lightboxIndex, setLightboxIndex] = useState(null);
  const [brokenPaths, setBrokenPaths] = useState(() => new Set());
  const [isDropTargetOver, setIsDropTargetOver] = useState(false);
  const dragCounterRef = useRef(0);

  const dim  = size === 'sm' ? 'h-6 text-[10px]' : 'h-10 text-xs';
  const tile = size === 'sm' ? 'h-12 w-12'      : 'h-16 w-16';
  const iconSize = size === 'sm' ? 10 : 14;
  const canEditPhotos = editable && !!onAddImages;

  const openAt = useCallback((i) => (e) => {
    e.stopPropagation();
    setLightboxIndex(i);
  }, [setLightboxIndex]);

  const markBroken = useCallback((path) => {
    setBrokenPaths(prev => {
      const next = new Set(prev);
      next.add(path);
      return next;
    });
  }, []);

  const markLoaded = useCallback((path) => {
    setBrokenPaths(prev => {
      if (!prev.has(path)) return prev;
      const next = new Set(prev);
      next.delete(path);
      return next;
    });
  }, []);

  const handleRemove = useCallback((index) => (e) => {
    e.stopPropagation();
    setLightboxIndex(null);
    onRemoveImage?.(index);
  }, [onRemoveImage]);

  const getImagePathsFromFiles = useCallback((files) => {
    const paths = files
      .filter(f => PRODUCT_IMAGE_EXT_RE.test(f.name || ''))
      .map(f => f.path || (window.electronAPI?.getPathForFile ? window.electronAPI.getPathForFile(f) : ''))
      .filter(Boolean);
    return paths;
  }, []);

  const handleDragEnter = useCallback((e) => {
    if (!canEditPhotos) return;
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current += 1;
    if (dragCounterRef.current === 1) setIsDropTargetOver(true);
  }, [canEditPhotos]);

  const handleDragLeave = useCallback((e) => {
    if (!canEditPhotos) return;
    e.stopPropagation();
    dragCounterRef.current -= 1;
    if (dragCounterRef.current <= 0) {
      dragCounterRef.current = 0;
      setIsDropTargetOver(false);
    }
  }, [canEditPhotos]);

  const handleDragOver = useCallback((e) => {
    if (!canEditPhotos) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
  }, [canEditPhotos]);

  const handleDrop = useCallback((e) => {
    if (!canEditPhotos) return;
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current = 0;
    setIsDropTargetOver(false);
    const paths = getImagePathsFromFiles(Array.from(e.dataTransfer?.files || []));
    if (paths.length > 0) onAddImages(paths);
  }, [canEditPhotos, getImagePathsFromFiles, onAddImages]);

  const dropTargetProps = canEditPhotos ? {
    onDragEnter: handleDragEnter,
    onDragLeave: handleDragLeave,
    onDragOver: handleDragOver,
    onDrop: handleDrop,
  } : {};

  if (imagePaths.length === 0) {
    return (
      <div
        {...dropTargetProps}
        className={`${dim} flex items-center gap-1 rounded-md border border-dashed px-2 transition-colors ${
          canEditPhotos
            ? isDropTargetOver
              ? 'border-emerald-400/70 bg-emerald-500/10 text-emerald-200/80'
              : 'border-white/10 bg-white/[0.02] text-white/25'
            : 'border-transparent text-white/15'
        }`}
      >
        <Camera size={size === 'sm' ? 10 : 12} />
        <span>{canEditPhotos ? 'Drop display photos here' : 'No photos'}</span>
      </div>
    );
  }

  const visible  = imagePaths.slice(0, maxVisible);
  const overflow = Math.max(0, imagePaths.length - maxVisible);

  return (
    <>
      <div
        {...dropTargetProps}
        className={`flex gap-1 overflow-x-auto rounded-md border border-dashed p-1 transition-colors ${
          canEditPhotos
            ? isDropTargetOver
              ? 'border-emerald-400/70 bg-emerald-500/10'
              : 'border-white/5 bg-transparent'
            : 'border-transparent p-0'
        }`}
      >
        {visible.map((p, i) => {
          const isBroken = brokenPaths.has(p);
          const fileName = p?.split(/[\\/]/).pop() || `Photo ${i + 1}`;
          return (
            <div
              key={`${p}-${i}`}
              className={`nodrag ${tile} shrink-0 rounded border overflow-hidden relative group transition-colors ${
                isBroken
                  ? 'border-red-400/35 bg-red-500/10'
                  : 'border-white/10 hover:border-white/40'
              }`}
              title={isBroken ? `${fileName} is missing or unreadable` : 'Click to view full size'}
              onPointerDown={(e) => e.stopPropagation()}
            >
              <img
                src={toLocalFilePreviewUrl(p, { maxDimension: 512 })}
                alt={`Product photo ${i + 1}`}
                className={`w-full h-full object-cover pointer-events-none ${isBroken ? 'hidden' : ''}`}
                onLoad={() => markLoaded(p)}
                onError={() => markBroken(p)}
                loading="lazy"
                decoding="async"
                fetchPriority="low"
                draggable={false}
              />
              {isBroken && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-0.5 px-1 text-center">
                  <ImageOff size={iconSize} className="text-red-200/80" />
                  <span className="max-w-full truncate text-[8px] font-medium text-red-100/70">
                    Missing
                  </span>
                </div>
              )}
              {!isBroken && (
                <button
                  type="button"
                  onClick={openAt(i)}
                  className="absolute inset-0 bg-black/0 group-hover:bg-black/40 transition-colors flex items-center justify-center opacity-0 group-hover:opacity-100"
                  title="View full size"
                >
                  <Maximize2 size={iconSize} className="text-white/90" />
                </button>
              )}
              {editable && onRemoveImage && (
                <button
                  type="button"
                  onClick={handleRemove(i)}
                  onPointerDown={(e) => e.stopPropagation()}
                  className={`absolute right-0.5 top-0.5 z-10 rounded bg-black/70 p-0.5 text-white/70 hover:bg-red-500/80 hover:text-white transition-colors ${
                    isBroken ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                  }`}
                  title="Remove this display photo"
                >
                  <Trash2 size={size === 'sm' ? 9 : 11} />
                </button>
              )}
            </div>
          );
        })}
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
        {canEditPhotos && (
          <div
            className={`nodrag ${tile} rounded border border-dashed border-white/10 bg-white/[0.03] flex flex-col items-center justify-center shrink-0 text-white/35 text-[8px] transition-colors ${
              isDropTargetOver ? 'border-emerald-300/80 text-emerald-100/80 bg-emerald-500/15' : ''
            }`}
            title="Drop replacement photos here for display only"
            onPointerDown={(e) => e.stopPropagation()}
          >
            <Upload size={iconSize} />
            <span>Drop</span>
          </div>
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
