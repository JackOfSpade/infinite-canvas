import React, { useState, useCallback, useRef, useEffect } from 'react';
import { useReactFlow } from '@xyflow/react';
import { Search, X, ChevronUp, ChevronDown } from 'lucide-react';

/**
 * Canvas search bar with match count indicator and navigation.
 * Searches nodes by name/title/text (including deep group search) and pans to the match.
 * Features: match count badge, next/prev arrows, clear button, Cmd+F activation.
 */
export const SearchBar = React.memo(function SearchBar({ nodes }) {
  const [searchQuery, setSearchQuery] = useState('');
  const [matchIndex, setMatchIndex] = useState(0);
  const [matchCount, setMatchCount] = useState(0);
  const [isExpanded, setIsExpanded] = useState(false);
  const { setCenter } = useReactFlow();
  const inputRef = useRef(null);

  // Cmd+F / Ctrl+F to focus search
  useEffect(() => {
    const handleKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault();
        setIsExpanded(true);
        setTimeout(() => inputRef.current?.focus(), 100);
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

  const getMatches = useCallback(() => {
    if (searchQuery.trim() === '') return [];

    const q = searchQuery.toLowerCase();

    const deepSearch = (items) => {
      for (const item of items) {
        if (
          (item.type === 'document' && item.filename?.toLowerCase().includes(q)) ||
          (item.type === 'group' && item.title?.toLowerCase().includes(q)) ||
          (item.data?.text && item.data.text.toLowerCase().includes(q))
        ) return true;
        if (item.items && deepSearch(item.items)) return true;
      }
      return false;
    };

    return nodes.filter(n => {
      if (
        (n.type === 'document' && n.data.filename?.toLowerCase().includes(q)) ||
        (n.type === 'text' && n.data.text?.toLowerCase().includes(q)) ||
        (n.type === 'group' && n.data.title?.toLowerCase().includes(q)) ||
        (n.type === 'link' && (n.data.label?.toLowerCase().includes(q) || n.data.url?.toLowerCase().includes(q))) ||
        (n.type === 'listing' && n.data.label?.toLowerCase().includes(q))
      ) return true;
      if (n.type === 'group' && n.data.items && deepSearch(n.data.items)) return true;
      return false;
    });
  }, [searchQuery, nodes]);

  const handleQueryChange = (e) => {
    setSearchQuery(e.target.value);
    setMatchIndex(0);
  };

  const navigateBy = useCallback((offset) => {
    const matches = getMatches();
    setMatchCount(matches.length);
    if (matches.length === 0) return;
    const nextIdx = ((matchIndex - 1 + offset) % matches.length + matches.length) % matches.length;
    const target = matches[nextIdx];
    setCenter(target.position.x + 100, target.position.y + 50, { zoom: 1.5, duration: 600 });
    setMatchIndex(nextIdx + 1);
  }, [getMatches, matchIndex, setCenter]);

  const executeSearch = useCallback((e) => {
    if (e.key !== 'Enter' || searchQuery.trim() === '') return;
    navigateBy(e.shiftKey ? -1 : 1);
  }, [searchQuery, navigateBy]);

  const handleNext = useCallback(() => navigateBy(1), [navigateBy]);
  const handlePrev = useCallback(() => navigateBy(-1), [navigateBy]);

  const handleClear = () => {
    setSearchQuery('');
    setMatchCount(0);
    setMatchIndex(0);
    setIsExpanded(false);
    inputRef.current?.blur();
  };

  // Update match count live as user types (after 300ms)
  useEffect(() => {
    if (searchQuery.trim() === '') {
      setMatchCount(0);
      return;
    }
    const timer = setTimeout(() => {
      setMatchCount(getMatches().length);
    }, 200);
    return () => clearTimeout(timer);
  }, [searchQuery, getMatches]);

  return (
    <div className="absolute top-4 left-1/2 -translate-x-1/2 z-10">
      <div className={`flex items-center gap-0 glass-card bg-black/40 rounded-full border border-white/10 shadow-xl transition-all duration-300 ${isExpanded ? 'w-[420px]' : 'w-80'}`}>
        <Search
          size={16}
          className="text-white/30 ml-4 shrink-0 cursor-pointer"
          onClick={() => { setIsExpanded(true); setTimeout(() => inputRef.current?.focus(), 100); }}
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
