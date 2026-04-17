import React, { useState, useCallback, useEffect, useRef } from 'react';
import { Search, Store, BarChart3, ChevronLeft, ChevronRight, UserCircle, Briefcase, Bug } from 'lucide-react';
import { SELL_PLATFORMS, JOB_SOURCES, PRICE_COMP_SOURCES } from '../utils/constants';

import { JobsTab } from './sidebar/JobsTab';
import { SellTab } from './sidebar/SellTab';
import { DashboardTab } from './sidebar/DashboardTab';
import { AccountsTab } from './sidebar/AccountsTab';
/** Icons specific to the Sidebar connection view. */
const PLATFORM_ICONS = {
  // Job Platforms
  linkedin: '💼', indeed: '🔍', glassdoor: '⭐', ziprecruiter: '🚀', dice: '🎲', wellfound: '🦄',
  // Marketplace
  ebay: '🏷️', facebook: '📘', mercari: '🛍️', poshmark: '👗', depop: '🔥', swappa: '📱', reverb: '🎸', whatnot: '🎴', stockx: '👟',
};

/** Match existing ids to central sources, adding icon and section tags dynamically */
const PLATFORMS = [
  ...JOB_SOURCES.filter(p => PLATFORM_ICONS[p.id]).map(p => ({ id: p.id, name: p.name, icon: PLATFORM_ICONS[p.id], section: 'jobs' })),
  ...SELL_PLATFORMS.map(p => ({ id: p.id, name: p.name, icon: PLATFORM_ICONS[p.id] || '🏷️', section: 'sell' })),
  ...PRICE_COMP_SOURCES.filter(p => p.id === 'stockx').map(p => ({ id: p.id, name: p.name, icon: PLATFORM_ICONS[p.id], section: 'sell' })),
];

/**
 * Sidebar — three-tab sliding panel.
 * Jobs + Sell tabs show draggable module items (drag to canvas to create hub nodes).
 * Dashboard tab shows aggregate stats from canvas nodes.
 *
 * Props:
 *   nodes — current canvas nodes (for dashboard stats)
 */
export const Sidebar = React.memo(function Sidebar({ nodes = [], onReportBugClick }) {
  const [collapsed, setCollapsed] = useState(true);
  const [activeTab, setActiveTab] = useState('jobs');
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

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
    e.dataTransfer.effectAllowed = 'copy';
  }, []);

  // Compute aggregate numerical stats directly (avoids allocating massive arrays that break memoization)
  const { jobCardsCount, sellHubsCount, appliedJobsCount, totalValue } = React.useMemo(() => {
    let jCount = 0, sCount = 0, aCount = 0, value = 0;
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (n.type === 'jobcard') {
        jCount++;
        if (n.data?.status === 'Applied') aCount++;
      } else if (n.type === 'sellhub') {
        sCount++;
        if (n.data?.hubState === 'priced') {
          value += parseFloat(n.data?.userPrice) || 0;
        }
      }
    }
    return { jobCardsCount: jCount, sellHubsCount: sCount, appliedJobsCount: aCount, totalValue: value };
  }, [nodes]);

  const [accountStatuses, setAccountStatuses] = useState({});
  const [systemStatuses, setSystemStatuses] = useState(null);
  const [loadingPlatform, setLoadingPlatform] = useState(null);

  // Fetch CACHED statuses when accounts tab opens — instant, no Chrome launch.
  // The user can click "Refresh" to do a live Chrome-based check.
  useEffect(() => {
    if (activeTab === 'accounts' && !collapsed) {
      if (window.electronAPI?.getCachedSessionStatuses) {
        window.electronAPI.getCachedSessionStatuses().then(statuses => {
          if (!isMountedRef.current) return;
          const map = {};
          for (const s of statuses) map[s.platform] = s;
          setAccountStatuses(map);
        }).catch(console.error);
      }
      if (window.electronAPI?.invoke) {
        window.electronAPI.invoke('get-system-config-status')
          .then(res => { if (isMountedRef.current) setSystemStatuses(res); })
          .catch(console.error);
      }
    }
  }, [activeTab, collapsed]);

  const handleConnect = useCallback(async (platformId) => {
    if (!window.electronAPI?.openLoginWindow) return;
    setLoadingPlatform(platformId);
    try {
      await window.electronAPI.openLoginWindow({ platformId });
      // After login window closes, re-read the cache (which was just written by the main process).
      // No Chrome launch — the main process already marked it as connected.
      const statuses = await window.electronAPI.getCachedSessionStatuses();
      if (!isMountedRef.current) return;
      const map = {};
      for (const s of statuses) map[s.platform] = s;
      setAccountStatuses(map);
    } catch (e) {
      console.error('Login failed:', e);
    }
    if (isMountedRef.current) setLoadingPlatform(null);
  }, []);

  const tabs = [
    { id: 'jobs', icon: Briefcase, label: 'Jobs', badge: jobCardsCount > 0 ? jobCardsCount : null },
    { id: 'sell', icon: Store, label: 'Sell', badge: sellHubsCount > 0 ? sellHubsCount : null },
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

        {/* Accounts button — pinned to bottom */}
        <div className="gradient-divider w-6 mx-auto" />
        <button
          onClick={() => handleTabClick('accounts')}
          className={`relative p-2.5 rounded-lg transition-all ${
            activeTab === 'accounts' && !collapsed ? 'bg-white/10 text-white' : 'text-white/40 hover:text-white/70 hover:bg-white/5'
          }`}
          title="Connected Accounts"
        >
          <UserCircle size={18} />
          {Object.values(accountStatuses).some(s => s.connected) && (
            <span className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-emerald-500 border border-[#0d0d0d]" />
          )}
        </button>

        <button
          onClick={onReportBugClick}
          className="p-2.5 rounded-lg transition-all text-red-400/35 hover:text-red-400 hover:bg-red-400/10"
          title="Report a Bug"
        >
          <Bug size={16} />
        </button>

        <button
          onClick={() => setCollapsed(!collapsed)}
          className="p-2 text-white/30 hover:text-white/60 transition-colors"
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {collapsed ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
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
          {activeTab === 'accounts' && (
            <AccountsTab 
              systemStatuses={systemStatuses}
              accountStatuses={accountStatuses}
              PLATFORMS={PLATFORMS}
              loadingPlatform={loadingPlatform}
              handleConnect={handleConnect}
            />
          )}

        </div>
      </div>
    </div>
  );
}, (prev, next) => {
  if (prev.onReportBugClick !== next.onReportBugClick) return false;
  
  // Fast loop to check if any dashboard-relevant statistics changed.
  // If only node positions changed, we skip rendering entirely!
  let pJ=0, pA=0, pS=0, pV=0;
  for (let i = 0; i < prev.nodes.length; i++) {
    const n = prev.nodes[i];
    if (n.type === 'jobcard') { pJ++; if (n.data?.status === 'Applied') pA++; }
    else if (n.type === 'sellhub') { pS++; if (n.data?.hubState === 'priced') pV += parseFloat(n.data?.userPrice) || 0; }
  }
  
  let nJ=0, nA=0, nS=0, nV=0;
  for (let i = 0; i < next.nodes.length; i++) {
    const n = next.nodes[i];
    if (n.type === 'jobcard') { nJ++; if (n.data?.status === 'Applied') nA++; }
    else if (n.type === 'sellhub') { nS++; if (n.data?.hubState === 'priced') nV += parseFloat(n.data?.userPrice) || 0; }
  }
  
  return pJ === nJ && pA === nA && pS === nS && pV === nV;
});
