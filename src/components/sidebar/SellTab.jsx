import React from 'react';
import { Camera } from 'lucide-react';
import { DraggableModuleCard } from './DraggableModuleCard';

export const SellTab = React.memo(function SellTab({ handleModuleDragStart }) {
  return (
    <DraggableModuleCard
      title="Sell Items"
      nodeType="sellhub"
      icon={<Camera size={22} className="text-emerald-400/50" />}
      moduleName="Sell Item Module"
      instructions="Drag to canvas, then drop photos"
      subInstructions="Or drop product photos directly on the canvas"
      footerText="AI generates listing + researches price"
      hoverBorderClass="hover:border-emerald-500/30"
      hoverBgClass="hover:bg-emerald-500/5"
      handleModuleDragStart={handleModuleDragStart}
    />
  );
});
