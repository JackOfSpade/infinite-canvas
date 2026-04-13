import React, { useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { PLATFORMS } from '../utils/platforms';

/**
 * Sidebar component with a Marketplace tab.
 *
 * Props:
 *   onDragStart(e, platform) — called when a platform icon begins dragging
 */
export const Sidebar = React.memo(function Sidebar({ onDragStart }) {
  const [collapsed, setCollapsed] = useState(false);
  const [activeTab, setActiveTab] = useState('marketplace');

  return (
    <div className={`h-full flex shrink-0 transition-all duration-200 ${collapsed ? 'w-12' : 'w-56'}`}>
      {/* Tab strip */}
      <div className="w-12 h-full bg-[#0d0d0d] border-r border-white/5 flex flex-col items-center py-3 gap-2 shrink-0">
        <button
          onClick={() => { setActiveTab('marketplace'); if (collapsed) setCollapsed(false); }}
          className={`p-2.5 rounded-lg transition-all ${activeTab === 'marketplace' && !collapsed ? 'bg-white/10 text-white' : 'text-white/40 hover:text-white/70 hover:bg-white/5'}`}
          title="Marketplace"
        >
          <Store size={18} />
        </button>

        {/* Spacer pushes collapse button to bottom */}
        <div className="flex-1" />

        <button
          onClick={() => setCollapsed(!collapsed)}
          className="p-2 text-white/30 hover:text-white/60 transition-colors"
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {collapsed ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
        </button>
      </div>

      {/* Panel content */}
      {!collapsed && (
        <div className="flex-1 bg-[#111111] border-r border-white/5 flex flex-col overflow-hidden">
          {activeTab === 'marketplace' && (
            <>
              <div className="px-4 py-3 border-b border-white/5">
                <h3 className="text-white/80 text-xs font-semibold uppercase tracking-wider">Marketplace</h3>
              </div>
              <div className="flex-1 overflow-y-auto custom-scrollbar p-3 flex flex-col gap-1.5">
                {PLATFORMS.map((platform) => {
                  const Icon = platform.icon;
                  return (
                    <div
                      key={platform.id}
                      draggable
                      onDragStart={(e) => onDragStart(e, platform)}
                      className="flex items-center gap-3 px-3 py-2.5 rounded-lg cursor-grab active:cursor-grabbing hover:bg-white/5 transition-colors group"
                    >
                      <div
                        className="w-8 h-8 rounded-md flex items-center justify-center shrink-0 transition-transform group-hover:scale-110"
                        style={{ backgroundColor: platform.color + '20' }}
                      >
                        <Icon size={16} style={{ color: platform.color }} />
                      </div>
                      <span className="text-white/80 text-sm font-medium select-none">{platform.name}</span>
                    </div>
                  );
                })}
              </div>
              <div className="px-4 py-3 border-t border-white/5">
                <p className="text-white/20 text-xs text-center">Drag onto canvas to monitor</p>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
});
