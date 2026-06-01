import React from 'react';

export const DashboardTab = React.memo(function DashboardTab({ jobCardsCount, sellHubsCount, totalValue }) {
  return (
    <>
      <div className="px-4 py-3 border-b border-white/5">
        <h3 className="text-white/80 text-xs font-semibold uppercase tracking-wider">Dashboard</h3>
      </div>

      <div className="p-4 space-y-4">
        {/* Jobs stats */}
        <div className="space-y-2">
          <div className="text-white/30 text-[10px] font-semibold uppercase tracking-wider">Jobs</div>
          <div className="bg-black/20 rounded-lg p-2.5 text-center">
            <div className="text-blue-400 text-lg font-bold">{jobCardsCount}</div>
            <div className="text-white/30 text-[10px]">Matches</div>
          </div>
        </div>

        {/* Marketplace stats */}
        <div className="space-y-2">
          <div className="text-white/30 text-[10px] font-semibold uppercase tracking-wider">Marketplace</div>
          <div className="grid grid-cols-2 gap-2">
            <div className="bg-black/20 rounded-lg p-2.5 text-center">
              <div className="text-amber-400 text-lg font-bold">{sellHubsCount}</div>
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
  );
});
