import React, { useState, useCallback, useRef, useEffect, useContext } from 'react';
import { useReactFlow } from '@xyflow/react';
import { Search, X, ChevronUp, ChevronDown } from 'lucide-react';
import { CanvasNavigationContext } from '../contexts/CanvasNavigationContext';
import { getNodeDims } from '../utils/constants';
import { panDuration } from '../utils/layoutGeometry';
import { matchesQuery } from '../utils/searchMatch';
import { TIMINGS } from '../utils/timings';
import { cancelTimeout, replaceTimeout } from '../utils/latestTimeout';

/**
 * Canvas search bar with match count indicator and navigation.
 * Searches nodes by name/title/text (including deep group search) and pans to the match.
 * Features: match count badge, next/prev arrows, clear button, Cmd+F activation.
 */
export const SearchBar = React.memo(function SearchBar() {
  const [searchQuery, setSearchQuery] = useState('');
  const [matchIndex, setMatchIndex] = useState(0);
  const [matchCount, setMatchCount] = useState(0);
  const [isExpanded, setIsExpanded] = useState(false);
  const { setCenter, getViewport, getNodes } = useReactFlow();
  const inputRef = useRef(null);
  const autoDiveTimeoutRef = useRef(null);
  const nav = useContext(CanvasNavigationContext);
  const isAnimating = nav?.isAnimating || false;

  // Cmd+F / Ctrl+F to focus search
  useEffect(() => {
    const handleKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault();
        setIsExpanded(true);
        setTimeout(() => inputRef.current?.focus(), TIMINGS.FOCUS_DELAY_MS);
      }
      if (e.key === 'Escape' && isExpanded) {
        setIsExpanded(false);
        setSearchQuery('');
        setMatchCount(0);
        setMatchIndex(0);
        inputRef.current?.blur();
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [isExpanded]);

  // Cleanup autoDiveTimeout on unmount
  useEffect(() => {
    return () => {
      cancelTimeout(autoDiveTimeoutRef);
    };
  }, []);

  const getMatches = useCallback(() => {
    if (!searchQuery.trim()) return [];
    const q = searchQuery.toLowerCase();
    const currentNodes = getNodes();

    const deepSearch = (items) => {
      if (!items || items.length === 0) return false;
      for (const item of items) {
        if (matchesQuery(item, q)) return true;
        const nested = item.data?.canvasData?.nodes;
        if (nested && nested.length > 0 && deepSearch(nested)) return true;
      }
      return false;
    };

    return currentNodes.map(n => {
      const titleMatch = matchesQuery(n, q);
      const nested = n.data?.canvasData?.nodes;
      const internalMatch = nested && nested.length > 0 && deepSearch(nested);
      
      if (titleMatch || internalMatch) {
        return { node: n, internalOnly: !titleMatch && internalMatch };
      }
      return null;
    }).filter(Boolean);
  }, [searchQuery, getNodes]);

  const handleQueryChange = (e) => {
    setSearchQuery(e.target.value);
    setMatchIndex(0);
  };

  const navigateBy = useCallback((offset) => {
    // A previous internal-only result may still be waiting to auto-dive. Once
    // the user navigates again, that result is stale and must not move them
    // into a different canvas after this newer selection has been shown.
    cancelTimeout(autoDiveTimeoutRef);
    if (isAnimating) return;
    const matches = getMatches();
    setMatchCount(matches.length);
    if (matches.length === 0) return;
    const nextIdx = ((matchIndex - 1 + offset) % matches.length + matches.length) % matches.length;
    const targetInfo = matches[nextIdx];
    const target = targetInfo.node;

    // Preserve the user's current zoom level; only pan to the match
    const vp = getViewport();
    const dims = getNodeDims(target);
    const targetCx = target.position.x + dims.w / 2;
    const targetCy = target.position.y + dims.h / 2;
    // Scale the animation by how far we're actually travelling on screen, so a
    // near match snaps and a cross-canvas jump glides (replaces a fixed 600ms).
    const viewCx = (window.innerWidth / 2 - vp.x) / vp.zoom;
    const viewCy = (window.innerHeight / 2 - vp.y) / vp.zoom;
    const travelPx = Math.hypot(targetCx - viewCx, targetCy - viewCy) * vp.zoom;
    setCenter(targetCx, targetCy, { zoom: vp.zoom, duration: panDuration(travelPx) });
    setMatchIndex(nextIdx + 1);

    // If it's an internal match, auto-dive after a short delay if the user
    // kept focus in the search bar (indicating they want to navigate deeper).
    if (targetInfo.internalOnly && nav?.diveIn) {
      replaceTimeout(autoDiveTimeoutRef, () => {
        // inputRef is a stable ref object — read .current inside the callback
        if (inputRef.current === document.activeElement || document.activeElement?.closest('[data-search-bar]')) {
           nav.diveIn(target.id);
        }
      }, TIMINGS.SEARCH_AUTODIVE_MS);
    }
  // inputRef is a stable ref object — intentionally omitted from deps
  }, [getMatches, matchIndex, setCenter, isAnimating, getViewport, nav]);

  const executeSearch = useCallback((e) => {
    if (e.key !== 'Enter' || searchQuery.trim() === '') return;
    navigateBy(e.shiftKey ? -1 : 1);
  }, [searchQuery, navigateBy]);

  const handleNext = useCallback(() => navigateBy(1), [navigateBy]);
  const handlePrev = useCallback(() => navigateBy(-1), [navigateBy]);

  const handleClear = () => {
    cancelTimeout(autoDiveTimeoutRef);
    setSearchQuery('');
    setMatchCount(0);
    setMatchIndex(0);
    setIsExpanded(false);
    inputRef.current?.blur();
  };

  useEffect(() => {
    if (searchQuery.trim() === '') {
      return;
    }

    const timer = setTimeout(() => {
      setMatchCount(getMatches().length);
    }, TIMINGS.SEARCH_RECOUNT_DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      cancelTimeout(autoDiveTimeoutRef);
    };
  }, [searchQuery, getMatches]);

  return (
    <div
      className="absolute top-4 left-1/2 -translate-x-1/2 z-10"
      data-search-bar
      onPointerDown={e => e.stopPropagation()}
    >
      <div className={`flex items-center gap-0 glass-card bg-black/40 rounded-full border border-white/10 shadow-xl transition-all duration-300 ${isExpanded ? 'w-[420px]' : 'w-80'}`}>
        <Search
          size={16}
          className="text-white/30 ml-4 shrink-0 cursor-pointer"
          onClick={() => { setIsExpanded(true); setTimeout(() => inputRef.current?.focus(), TIMINGS.FOCUS_DELAY_MS); }}
        />
        <input
          ref={inputRef}
          type="text"
          placeholder={isExpanded ? "Search… (Enter to navigate, Shift+Enter for prev)" : "Search items… (⌘F)"}
          className="flex-1 bg-transparent text-white px-3 py-3 focus:outline-none placeholder-white/30 text-sm"
          value={searchQuery}
          onChange={handleQueryChange}
          onKeyDown={executeSearch}
          onFocus={() => setIsExpanded(true)}
          onBlur={() => { if (!searchQuery.trim()) setIsExpanded(false); }}
        />

        {/* Match count badge */}
        {searchQuery.trim() !== '' && (
          <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full mr-1 shrink-0 ${
            matchCount > 0 ? 'text-blue-400 bg-blue-400/10' : 'text-white/30 bg-white/5'
          }`}>
            {matchCount} {matchCount === 1 ? 'match' : 'matches'}
          </span>
        )}

        {/* Navigation arrows */}
        {isExpanded && searchQuery.trim() !== '' && matchCount > 0 && (
          <div className="flex items-center gap-0.5 mr-1">
            <button
               onClick={handlePrev}
              className="p-1 text-white/30 hover:text-white/70 transition-colors rounded"
              title="Previous match (Shift+Enter)"
            >
              <ChevronUp size={14} />
            </button>
            <button
              onClick={handleNext}
              className="p-1 text-white/30 hover:text-white/70 transition-colors rounded"
              title="Next match (Enter)"
            >
              <ChevronDown size={14} />
            </button>
          </div>
        )}

        {/* Clear button */}
        {searchQuery && (
          <button
            onClick={handleClear}
            className="p-1.5 mr-2 text-white/30 hover:text-white/70 transition-colors rounded-full hover:bg-white/5"
            title="Clear search"
          >
            <X size={14} />
          </button>
        )}
      </div>
    </div>
  );
});
