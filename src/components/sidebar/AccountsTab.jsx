import React from 'react';
import { Loader2, Check } from 'lucide-react';

export const AccountsTab = React.memo(function AccountsTab({
  systemStatuses,
  accountStatuses,
  PLATFORMS,
  loadingPlatform,
  handleConnect
}) {
  return (
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
  );
});
