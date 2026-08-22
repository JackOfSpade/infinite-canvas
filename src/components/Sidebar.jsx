import React, { useState, useCallback, useEffect, useRef } from 'react';
import { Store, BarChart3, Briefcase, Bug } from 'lucide-react';

import { JobsTab } from './sidebar/JobsTab';
import { SellTab } from './sidebar/SellTab';
import { DashboardTab } from './sidebar/DashboardTab';

/**
 * Sidebar — three-tab sliding panel.
 * Jobs + Sell tabs show draggable module items (drag to canvas to create hub nodes).
 * Dashboard tab shows aggregate stats (passed in as primitives — see getStats).
 */
export const Sidebar = React.memo(function Sidebar({ jobCardsCount = 0, sellHubsCount = 0, totalValue = 0, onReportBugClick }) {
  const [collapsed, setCollapsed] = useState(true);
  const [activeTab, setActiveTab] = useState('jobs');
  const sidebarRef = useRef(null);

  const handleTabClick = useCallback((tab) => {
    if (activeTab === tab && !collapsed) {
      setCollapsed(true);
    } else {
      setActiveTab(tab);
      setCollapsed(false);
    }
  }, [activeTab, collapsed]);

  // Drag handlers — set dataTransfer type so Canvas knows what to create
  const handleModuleDragStart = useCallback((e, moduleType) => {
    e.dataTransfer.setData('app/node-type', moduleType);
    // Explicitly set text/plain to empty string to prevent the browser from
    // auto-filling it with the element's text content (e.g. "Drag to canvas...").
    // Without this, the canvas drop handler falls through to text-node creation.
    e.dataTransfer.setData('text/plain', '');
    e.dataTransfer.effectAllowed = 'copy';
  }, []);

  useEffect(() => {
    if (collapsed) return;

    const handleDocumentPointerDown = (event) => {
      if (sidebarRef.current?.contains(event.target)) return;
      setCollapsed(true);
    };

    document.addEventListener('pointerdown', handleDocumentPointerDown, { capture: true });
    return () => document.removeEventListener('pointerdown', handleDocumentPointerDown, { capture: true });
  }, [collapsed]);

  const tabs = [
    { id: 'sell', icon: Store, label: 'Sell' },
    { id: 'jobs', icon: Briefcase, label: 'Jobs' },
    { id: 'dashboard', icon: BarChart3, label: 'Stats' },
  ];

  return (
    <div ref={sidebarRef} className="h-full flex shrink-0 overflow-hidden">
      {/* Tab strip */}
      <div className="w-12 h-full bg-[#0d0d0d] border-r border-white/5 flex flex-col items-center py-3 gap-1.5 shrink-0 z-10 relative">
        {tabs.map((tab, i) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id && !collapsed;
          return (
            <React.Fragment key={tab.id}>
              {i > 0 && <div className="gradient-divider w-6 mx-auto" />}
              <button
                onClick={() => handleTabClick(tab.id)}
                className={`relative p-2.5 rounded-lg transition-all ${
                  isActive ? 'bg-white/10 text-white' : 'text-white/40 hover:text-white/70 hover:bg-white/5'
                }`}
                title={tab.label}
              >
                <Icon size={18} />
              </button>
            </React.Fragment>
          );
        })}

        <div className="flex-1" />

        <div className="gradient-divider w-6 mx-auto" />
        <button
          onClick={onReportBugClick}
          className="p-2.5 rounded-lg transition-all text-red-400/35 hover:text-red-400 hover:bg-red-400/10"
          title="Report a Bug"
        >
          <Bug size={16} />
        </button>
      </div>

      {/* Panel content */}
      <div
        className={`bg-[#111111] flex flex-col overflow-hidden transition-[width] duration-300 ease-in-out border-white/5 ${
          collapsed ? 'w-0 border-r-0' : 'w-56 border-r'
        }`}
      >
        <div className="w-56 flex flex-col h-full">

          {/* ── Tabs ─────────────────────────────────────────────────── */}
          {activeTab === 'jobs' && <JobsTab handleModuleDragStart={handleModuleDragStart} />}
          {activeTab === 'sell' && <SellTab handleModuleDragStart={handleModuleDragStart} />}
          {activeTab === 'dashboard' && (
            <DashboardTab
              jobCardsCount={jobCardsCount}
              sellHubsCount={sellHubsCount}
              totalValue={totalValue}
            />
          )}

        </div>
      </div>
    </div>
  );
});
