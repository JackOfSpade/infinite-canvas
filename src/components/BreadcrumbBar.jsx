import React, { useContext } from 'react';
import { Panel } from '@xyflow/react';
import { ChevronRight, Home } from 'lucide-react';
import { CanvasNavigationContext } from '../contexts/CanvasNavigationContext';

/**
 * Breadcrumb navigation bar shown when inside a nested canvas.
 * Displays: Main Canvas > Sub A > Sub B (current)
 * All ancestors are clickable for jump-to navigation.
 */
export const BreadcrumbBar = React.memo(function BreadcrumbBar() {
  const nav = useContext(CanvasNavigationContext);
  if (!nav || nav.depth === 0) return null;

  const { breadcrumbs, jumpTo, isAnimating } = nav;

  return (
    <Panel position="top-center" style={{ top: 60, zIndex: 50 }}>
      <div className="breadcrumb-bar glass-card rounded-full px-3 py-1.5 flex items-center gap-1 bg-black/70 border border-white/10 text-xs select-none shadow-lg">
        {breadcrumbs.map((crumb, i) => {
          const isLast = i === breadcrumbs.length - 1;
          const isClickable = !isLast && !isAnimating;

          return (
            <React.Fragment key={crumb.id + i}>
              {i > 0 && (
                <ChevronRight size={12} className="text-white/20 shrink-0" />
              )}
              <button
                onClick={isClickable ? () => jumpTo(i) : undefined}
                disabled={!isClickable}
                className={`flex items-center gap-1 px-1.5 py-0.5 rounded-md transition-colors ${
                  isClickable
                    ? 'text-white/60 hover:text-white hover:bg-white/10 cursor-pointer'
                    : 'text-white/90 font-semibold cursor-default'
                }`}
              >
                {i === 0 && <Home size={11} className="shrink-0" />}
                <span className="max-w-[120px] truncate">{crumb.title}</span>
              </button>
            </React.Fragment>
          );
        })}
      </div>
    </Panel>
  );
});
