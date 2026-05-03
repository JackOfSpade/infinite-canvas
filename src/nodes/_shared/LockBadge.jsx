import React from 'react';
import { Lock } from 'lucide-react';

/** Small lock badge shown on locked nodes (top-right corner). */
export const LockBadge = React.memo(function LockBadge() {
  return (
    <div className="absolute -top-2 -right-2 bg-black/60 rounded-full p-0.5 text-white/70 backdrop-blur-sm pointer-events-none z-10">
      <Lock size={10} />
    </div>
  );
});
