import React, { useState, useCallback, useEffect } from 'react';
import { Search, Store, BarChart3, ChevronLeft, ChevronRight, Briefcase, Camera, GripVertical, UserCircle, Check, Loader2 } from 'lucide-react';

/** Static platform list — hoisted to module scope to avoid re-allocation on each render. */
const PLATFORMS = [
  // Job Platforms
  { id: 'linkedin', name: 'LinkedIn', icon: '💼', section: 'jobs' },
  { id: 'indeed', name: 'Indeed', icon: '🔍', section: 'jobs' },
  { id: 'glassdoor', name: 'Glassdoor', icon: '⭐', section: 'jobs' },
  { id: 'ziprecruiter', name: 'ZipRecruiter', icon: '🚀', section: 'jobs' },
  { id: 'dice', name: 'Dice', icon: '🎲', section: 'jobs' },
  { id: 'wellfound', name: 'Wellfound', icon: '🦄', section: 'jobs' },
  // Marketplace — Selling Destinations
  { id: 'ebay', name: 'eBay', icon: '🏷️', section: 'sell' },
  { id: 'facebook', name: 'Facebook', icon: '📘', section: 'sell' },
  { id: 'mercari', name: 'Mercari', icon: '🛍️', section: 'sell' },
  { id: 'poshmark', name: 'Poshmark', icon: '👗', section: 'sell' },
  { id: 'depop', name: 'Depop', icon: '🔥', section: 'sell' },
  { id: 'swappa', name: 'Swappa', icon: '📱', section: 'sell' },
  { id: 'reverb', name: 'Reverb', icon: '🎸', section: 'sell' },
  { id: 'whatnot', name: 'Whatnot', icon: '🎴', section: 'sell' },
  // Marketplace — Pricing Data Only
  { id: 'stockx', name: 'StockX', icon: '👟', section: 'sell' },
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

  // Compute stats from canvas nodes
  const jobCards = nodes.filter(n => n.type === 'jobcard');
  const sellHubs = nodes.filter(n => n.type === 'sellhub');
  const appliedJobs = jobCards.filter(n => n.data?.status === 'Applied');
  const pricedListings = sellHubs.filter(n => n.data?.hubState === 'priced');
  const totalValue = pricedListings.reduce((sum, n) => sum + (parseFloat(n.data?.userPrice) || 0), 0);

  // Accounts state
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
    { id: 'jobs', icon: Search, label: 'Jobs', badge: jobCards.length > 0 ? jobCards.length : null },
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

          {/* ── Jobs Tab ────────────────────────────────────────────── */}
          {activeTab === 'jobs' && (
            <>
              <div className="px-4 py-3 border-b border-white/5">
                <h3 className="text-white/80 text-xs font-semibold uppercase tracking-wider">Job Search</h3>
              </div>

              {/* Draggable module */}
              <div className="p-3">
                <div
                  draggable
                  onDragStart={(e) => handleModuleDragStart(e, 'jobhub')}
                  className="border-2 border-dashed border-white/10 rounded-xl p-4 text-center cursor-grab active:cursor-grabbing 
                             hover:border-blue-500/30 hover:bg-blue-500/5 transition-all group"
                >
                  <div className="flex items-center justify-center gap-1.5 mb-2">
                    <GripVertical size={12} className="text-white/15 group-hover:text-white/30 transition-colors" />
                    <Briefcase size={22} className="text-blue-400/50" />
                  </div>
                  <p className="text-white/50 text-xs font-medium">Job Search Module</p>
                  <p className="text-white/20 text-[10px] mt-1">Drag to canvas, then drop resume</p>
                </div>

                <p className="text-white/15 text-[9px] text-center mt-3 leading-relaxed">
                  Or drop a resume directly on the canvas — a hub will be created automatically
                </p>
              </div>

              <div className="flex-1" />
              <div className="px-4 py-3 border-t border-white/5">
                <p className="text-white/15 text-[10px] text-center">AI explores career directions you haven't considered</p>
              </div>
            </>
          )}

          {/* ── Sell Tab ────────────────────────────────────────────── */}
          {activeTab === 'sell' && (
            <>
              <div className="px-4 py-3 border-b border-white/5">
                <h3 className="text-white/80 text-xs font-semibold uppercase tracking-wider">Sell Items</h3>
              </div>

              {/* Draggable module */}
              <div className="p-3">
                <div
                  draggable
                  onDragStart={(e) => handleModuleDragStart(e, 'sellhub')}
                  className="border-2 border-dashed border-white/10 rounded-xl p-4 text-center cursor-grab active:cursor-grabbing 
                             hover:border-emerald-500/30 hover:bg-emerald-500/5 transition-all group"
                >
                  <div className="flex items-center justify-center gap-1.5 mb-2">
                    <GripVertical size={12} className="text-white/15 group-hover:text-white/30 transition-colors" />
                    <Camera size={22} className="text-emerald-400/50" />
                  </div>
                  <p className="text-white/50 text-xs font-medium">Sell Item Module</p>
                  <p className="text-white/20 text-[10px] mt-1">Drag to canvas, then drop photos</p>
                </div>

                <p className="text-white/15 text-[9px] text-center mt-3 leading-relaxed">
                  Or drop product photos directly on the canvas
                </p>
              </div>

              <div className="flex-1" />
              <div className="px-4 py-3 border-t border-white/5">
                <p className="text-white/15 text-[10px] text-center">AI generates listing + researches price</p>
              </div>
            </>
          )}

          {/* ── Dashboard Tab ──────────────────────────────────────── */}
          {activeTab === 'dashboard' && (
            <>
              <div className="px-4 py-3 border-b border-white/5">
                <h3 className="text-white/80 text-xs font-semibold uppercase tracking-wider">Dashboard</h3>
              </div>

              <div className="p-4 space-y-4">
                {/* Jobs stats */}
                <div className="space-y-2">
                  <div className="text-white/30 text-[10px] font-semibold uppercase tracking-wider">Jobs</div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="bg-black/20 rounded-lg p-2.5 text-center">
                      <div className="text-blue-400 text-lg font-bold">{jobCards.length}</div>
                      <div className="text-white/30 text-[10px]">Matches</div>
                    </div>
                    <div className="bg-black/20 rounded-lg p-2.5 text-center">
                      <div className="text-emerald-400 text-lg font-bold">{appliedJobs.length}</div>
                      <div className="text-white/30 text-[10px]">Applied</div>
                    </div>
                  </div>
                </div>

                {/* Marketplace stats */}
                <div className="space-y-2">
                  <div className="text-white/30 text-[10px] font-semibold uppercase tracking-wider">Marketplace</div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="bg-black/20 rounded-lg p-2.5 text-center">
                      <div className="text-amber-400 text-lg font-bold">{sellHubs.length}</div>
                      <div className="text-white/30 text-[10px]">Listings</div>
                    </div>
                    <div className="bg-black/20 rounded-lg p-2.5 text-center">
                      <div className="text-purple-400 text-lg font-bold">${totalValue}</div>
                      <div className="text-white/30 text-[10px]">Value</div>
                    </div>
                  </div>
                </div>
              </div>

              <div className="flex-1" />
              <div className="px-4 py-3 border-t border-white/5">
                <p className="text-white/15 text-[10px] text-center">Stats update as you use the app</p>
              </div>
            </>
          )}

          {/* ── Accounts Tab ──────────────────────────────────────── */}
          {activeTab === 'accounts' && (
            <>
              <div className="px-4 py-3 border-b border-white/5">
                <h3 className="text-white/80 text-xs font-semibold uppercase tracking-wider">Connected Accounts</h3>
              </div>

              <div className="p-3 space-y-2 overflow-y-auto flex-1 custom-scrollbar">
                <p className="text-white/30 text-[10px] px-1 mb-2 leading-relaxed">
                  Log in to platforms for better results. Sessions persist across app restarts.
                </p>

                {/* System Connections */}
                <div className="mb-4">
                  <div className="text-white/25 text-[9px] font-semibold uppercase tracking-wider mt-2 mb-1.5 px-1">System APIs</div>
                  <div className="space-y-1.5">
                    {systemStatuses && Object.entries(systemStatuses).map(([key, config]) => (
                      <div key={key} className="flex items-center gap-2.5 p-2.5 rounded-lg bg-black/20 group">
                        <span className="text-base w-6 text-center">⚙️</span>
                        <div className="flex-1 min-w-0">
                          <div className="text-white/70 text-xs font-medium">{config.name}</div>
                          <div className={`text-[9px] mt-0.5 ${config.connected ? 'text-emerald-400/70' : 'text-amber-400/70'}`}>
                            {config.connected ? 'Configured' : 'Missing Configuration'}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {['jobs', 'sell'].map(section => (
                  <div key={section}>
                    <div className="text-white/25 text-[9px] font-semibold uppercase tracking-wider mt-2 mb-1.5 px-1">
                      {section === 'jobs' ? 'Job Platforms' : 'Marketplace'}
                    </div>
                    {PLATFORMS.filter(p => p.section === section).map(platform => {
                      const status = accountStatuses[platform.id];
                      const isConnected = status?.connected;
                      const isLoading = loadingPlatform === platform.id;

                      return (
                        <div
                          key={platform.id}
                          className="flex items-center gap-2.5 p-2.5 rounded-lg bg-black/20 hover:bg-black/30 transition-colors group mb-1.5"
                        >
                          <span className="text-base w-6 text-center">{platform.icon}</span>
                          <div className="flex-1 min-w-0">
                            <div className="text-white/70 text-xs font-medium">{platform.name}</div>
                            <div className={`text-[9px] ${isConnected ? 'text-emerald-400/70' : 'text-white/20'}`}>
                              {isConnected ? 'Connected' : 'Not connected'}
                            </div>
                          </div>
                          <button
                            onClick={() => handleConnect(platform.id)}
                            disabled={isLoading}
                            className={`px-2 py-1 rounded text-[10px] font-medium transition-all ${
                              isConnected
                                ? 'text-white/30 hover:text-white/60 hover:bg-white/5'
                                : 'bg-white/10 text-white/70 hover:bg-white/15'
                            }`}
                          >
                            {isLoading ? (
                              <Loader2 size={12} className="animate-spin" />
                            ) : isConnected ? (
                              <span className="flex items-center gap-1"><Check size={10} /> Active</span>
                            ) : (
                              'Connect'
                            )}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>

              <div className="px-4 py-3 border-t border-white/5">
                <p className="text-white/15 text-[10px] text-center">A browser window will open for login</p>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
});
