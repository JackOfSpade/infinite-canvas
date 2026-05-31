import React from 'react';
import { Briefcase } from 'lucide-react';
import { DraggableModuleCard } from './DraggableModuleCard';

export const JobsTab = React.memo(function JobsTab({ handleModuleDragStart }) {
  return (
    <DraggableModuleCard
      title="Job Search"
      nodeType="jobhub"
      icon={<Briefcase size={22} className="text-blue-400/50" />}
      moduleName="Job Search Module"
      instructions="Drag to canvas, then drop career files"
      subInstructions="Or drop your career files directly on the canvas — a hub will be created automatically"
      footerText="AI explores career directions you haven't considered"
      hoverBorderClass="hover:border-blue-500/30"
      hoverBgClass="hover:bg-blue-500/5"
      handleModuleDragStart={handleModuleDragStart}
    />
  );
});
