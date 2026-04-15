import React, { useState, useCallback, useEffect } from 'react';
import { Search, Store, BarChart3, ChevronLeft, ChevronRight, UserCircle, Briefcase } from 'lucide-react';
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
export const Sidebar = React.memo(function Sidebar({ nodes = [] }) {
  const [collapsed, setCollapsed] = useState(true);
  const [activeTab, setActiveTab] = useState('jobs');

  const handleTabClick = (tab) => {
    if (activeTab === tab && !collapsed) {
      setCollapsed(true);
    } else {
      setActiveTab(tab);
      setCollapsed(false);
    }
  };

  // Drag handlers — set dataTransfer type so Canvas knows what to create
  const handleModuleDragStart = useCallback((e, moduleType) => {
    e.dataTransfer.setData('app/node-type', moduleType);
    e.dataTransfer.effectAllowed = 'copy';
  }, []);

  // Compute stats from canvas nodes using useMemo for performance
  const { jobCards, sellHubs, appliedJobs, totalValue } = React.useMemo(() => {
    const jobs = nodes.filter(n => n.type === 'jobcard');
    const sells = nodes.filter(n => n.type === 'sellhub');
    const applied = jobs.filter(n => n.data?.status === 'Applied');
    const priced = sells.filter(n => n.data?.hubState === 'priced');
    const value = priced.reduce((sum, n) => sum + (parseFloat(n.data?.userPrice) || 0), 0);
    return { jobCards: jobs, sellHubs: sells, appliedJobs: applied, totalValue: value };
  }, [nodes]);
  const [accountStatuses, setAccountStatuses] = useState({});
  const [systemStatuses, setSystemStatuses] = useState(null);
  const [loadingPlatform, setLoadingPlatform] = useState(null);

  // Fetch session statuses when accounts tab opens
  useEffect(() => {
    if (activeTab === 'accounts' && !collapsed) {
      if (window.electronAPI?.getSessionStatuses) {
        window.electronAPI.getSessionStatuses().then(statuses => {
          const map = {};
          for (const s of statuses) map[s.platform] = s;
          setAccountStatuses(map);
        });
      }
      if (window.electronAPI?.invoke) {
        window.electronAPI.invoke('get-system-config-status').then(setSystemStatuses).catch(console.error);
      }
    }
  }, [activeTab, collapsed]);

  const handleConnect = useCallback(async (platformId) => {
    if (!window.electronAPI?.openLoginWindow) return;
    setLoadingPlatform(platformId);
    try {
      await window.electronAPI.openLoginWindow({ platformId });
      // After login window closes, re-check statuses
      const statuses = await window.electronAPI.getSessionStatuses();
      const map = {};
      for (const s of statuses) map[s.platform] = s;
      setAccountStatuses(map);
    } catch (e) {
      console.error('Login failed:', e);
    }
    setLoadingPlatform(null);
  }, []);

  const tabs = [
    { id: 'jobs', icon: Briefcase, label: 'Jobs', badge: jobCards.length > 0 ? jobCards.length : null },
    { id: 'sell', icon: Store, label: 'Sell', badge: sellHubs.length > 0 ? sellHubs.length : null },
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
              jobCards={jobCards} 
              appliedJobs={appliedJobs} 
              sellHubs={sellHubs} 
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
});
