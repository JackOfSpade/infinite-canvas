import React from 'react';
import { Camera, Radar } from 'lucide-react';
import { DraggableModuleCard } from './DraggableModuleCard';

export const SellTab = React.memo(function SellTab({ handleModuleDragStart }) {
  return (
    <div className="flex flex-col h-full overflow-y-auto">
      <DraggableModuleCard
        title="Price Check"
        nodeType="sellhub"
        icon={<Camera size={22} className="text-emerald-400/50" />}
        moduleName="Price Check Module"
        instructions="Drag to canvas, then drop photos"
        subInstructions="Photos dropped straight on the canvas just become picture nodes — drop them onto the module after placing it"
        footerText="AI generates listing + researches price"
        hoverBorderClass="hover:border-emerald-500/30"
        hoverBgClass="hover:bg-emerald-500/5"
        handleModuleDragStart={handleModuleDragStart}
      />
      <DraggableModuleCard
        title="Marketplace Status"
        nodeType="marketplacestatus"
        icon={<Radar size={22} className="text-sky-400/50" />}
        moduleName="Marketplace Status Module"
        instructions="Drag onto a canvas with Price Check Modules"
        subInstructions="Monitors all your listings via each site's notification hub"
        footerText="Checks the watch URLs in Settings for anything needing action"
        hoverBorderClass="hover:border-sky-500/30"
        hoverBgClass="hover:bg-sky-500/5"
        handleModuleDragStart={handleModuleDragStart}
      />
    </div>
  );
});
