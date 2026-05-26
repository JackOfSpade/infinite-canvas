import React, { useState, useCallback } from 'react';
import { Store, BarChart3, Briefcase, Bug } from 'lucide-react';

import { JobsTab } from './sidebar/JobsTab';
import { SellTab } from './sidebar/SellTab';
import { DashboardTab } from './sidebar/DashboardTab';

/**
 * Sidebar — three-tab sliding panel.
 * Jobs + Sell tabs show draggable module items (drag to canvas to create hub nodes).
 * Dashboard tab shows aggregate stats from canvas nodes.
 *
 * Props:
 *   nodes — current canvas nodes (for dashboard stats)
 */
// Helper to compute stats cleanly
function getStats(nodes) {
  let jobCardsCount = 0, sellHubsCount = 0, appliedJobsCount = 0, totalValue = 0;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.type === 'jobcard') {
      jobCardsCount++;
      if (n.data?.status === 'Applied') appliedJobsCount++;
    } else if (n.type === 'sellhub') {
      sellHubsCount++;
      if (n.data?.hubState === 'priced') {
        totalValue += parseFloat(n.data?.userPrice) || 0;
      }
    }
  }
  return { jobCardsCount, sellHubsCount, appliedJobsCount, totalValue };
}

export const Sidebar = React.memo(function Sidebar({ nodes = [], onReportBugClick }) {
  const [collapsed, setCollapsed] = useState(true);
  const [activeTab, setActiveTab] = useState('jobs');

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

  const { jobCardsCount, sellHubsCount, appliedJobsCount, totalValue } = React.useMemo(() => getStats(nodes), [nodes]);

  const tabs = [
    { id: 'jobs', icon: Briefcase, label: 'Jobs' },
    { id: 'sell', icon: Store, label: 'Sell' },
    { id: 'dashboard', icon: BarChart3, label: 'Stats' },
  ];

  return (
    <div className="h-full flex shrink-0 overflow-hidden">
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
                {tab.badge && (
                  <span className="absolute -top-1 -right-1 min-w-[16px] h-[16px] rounded-full bg-blue-500 text-white text-[9px] font-bold flex items-center justify-center px-0.5 badge-bounce">
                    {tab.badge}
                  </span>
                )}
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
              jobCards={{ length: jobCardsCount }} 
              appliedJobs={{ length: appliedJobsCount }} 
              sellHubs={{ length: sellHubsCount }} 
              totalValue={totalValue} 
            />
          )}

        </div>
      </div>
    </div>
  );
}, (prev, next) => {
  if (prev.onReportBugClick !== next.onReportBugClick) return false;
  if (prev.nodes === next.nodes) return true;
  
  const pStats = getStats(prev.nodes);
  const nStats = getStats(next.nodes);
  
  return pStats.jobCardsCount === nStats.jobCardsCount &&
         pStats.appliedJobsCount === nStats.appliedJobsCount &&
         pStats.sellHubsCount === nStats.sellHubsCount &&
         pStats.totalValue === nStats.totalValue;
});
