import React, { useState, useCallback } from 'react';
import { useReactFlow } from '@xyflow/react';

/**
 * Canvas search bar.
 * Searches nodes by name/title/text (including deep group search) and pans to the match.
 */
export const SearchBar = React.memo(function SearchBar({ nodes }) {
  const [searchQuery, setSearchQuery] = useState('');
  const [matchIndex, setMatchIndex] = useState(0);
  const { setCenter } = useReactFlow();

  const handleQueryChange = (e) => {
    setSearchQuery(e.target.value);
    setMatchIndex(0);
  };

  const executeSearch = useCallback((e) => {
    if (e.key !== 'Enter' || searchQuery.trim() === '') return;

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

    const matchingNodes = nodes.filter(n => {
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

    if (matchingNodes.length > 0) {
      const target = matchingNodes[matchIndex % matchingNodes.length];
      setCenter(target.position.x + 100, target.position.y + 50, { zoom: 1.5, duration: 800 });
      setMatchIndex(prev => prev + 1);
    }
  }, [searchQuery, nodes, setCenter, matchIndex]);

  return (
    <div className="absolute top-4 left-1/2 -translate-x-1/2 z-10 w-96">
      <input
        type="text"
        placeholder="Search items... (Press Enter to find)"
        className="w-full glass-card bg-black/40 text-white rounded-full px-6 py-3 border border-white/10 focus:outline-none focus:border-blue-500 shadow-xl placeholder-white/30 transition-all focus:bg-black/60"
        value={searchQuery}
        onChange={handleQueryChange}
        onKeyDown={executeSearch}
      />
    </div>
  );
});
