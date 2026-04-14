import React from 'react';
import { GripVertical } from 'lucide-react';

export function DraggableModuleCard({
  title,
  nodeType,
  icon,
  moduleName,
  instructions,
  subInstructions,
  footerText,
  hoverBorderClass,
  hoverBgClass,
  handleModuleDragStart
}) {
  return (
    <>
      <div className="px-4 py-3 border-b border-white/5">
        <h3 className="text-white/80 text-xs font-semibold uppercase tracking-wider">{title}</h3>
      </div>

      <div className="p-3">
        <div
          draggable
          onDragStart={(e) => handleModuleDragStart(e, nodeType)}
          className={`border-2 border-dashed border-white/10 rounded-xl p-4 text-center cursor-grab active:cursor-grabbing 
                     ${hoverBorderClass} ${hoverBgClass} transition-all group`}
        >
          <div className="flex items-center justify-center gap-1.5 mb-2">
            <GripVertical size={12} className="text-white/15 group-hover:text-white/30 transition-colors" />
            {icon}
          </div>
          <p className="text-white/50 text-xs font-medium">{moduleName}</p>
          <p className="text-white/20 text-[10px] mt-1">{instructions}</p>
        </div>

        {subInstructions && (
          <p className="text-white/15 text-[9px] text-center mt-3 leading-relaxed">
            {subInstructions}
          </p>
        )}
      </div>

      <div className="flex-1" />
      
      {footerText && (
        <div className="px-4 py-3 border-t border-white/5">
          <p className="text-white/15 text-[10px] text-center">{footerText}</p>
        </div>
      )}
    </>
  );
}
