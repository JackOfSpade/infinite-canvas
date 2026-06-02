import React from 'react';
import { Briefcase, LayoutGrid } from 'lucide-react';
import { DraggableModuleCard } from './DraggableModuleCard';

export const JobsTab = React.memo(function JobsTab({ handleModuleDragStart }) {
  return (
    <div className="flex flex-col h-full overflow-y-auto">
      <DraggableModuleCard
        title="Job Search"
        nodeType="jobhub"
        icon={<Briefcase size={22} className="text-blue-400/50" />}
        moduleName="Job Search Module"
        instructions="Drag to canvas, then drop career files"
        subInstructions="Or drop your career files directly on the canvas — a hub will be created automatically"
        hoverBorderClass="hover:border-blue-500/30"
        hoverBgClass="hover:bg-blue-500/5"
        handleModuleDragStart={handleModuleDragStart}
      />
      <DraggableModuleCard
        title="Job Board"
        nodeType="jobboard"
        icon={<LayoutGrid size={22} className="text-indigo-400/50" />}
        moduleName="Job Board Module"
        instructions="Drag to canvas, then connect Job Search modules"
        subInstructions="Connect one or more Job Search Modules to it, then Combine to merge all results into one ranked board"
        footerText="Merge searches from different locations into one hierarchy"
        hoverBorderClass="hover:border-indigo-500/30"
        hoverBgClass="hover:bg-indigo-500/5"
        handleModuleDragStart={handleModuleDragStart}
      />
    </div>
  );
});
