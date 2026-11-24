import React from 'react';
import { Briefcase, LayoutGrid } from 'lucide-react';
import { DraggableModuleCard } from './DraggableModuleCard';
import { appAllowsModule } from '../../utils/appRole.js';

export const JobsTab = React.memo(function JobsTab({ handleModuleDragStart }) {
  return (
    <div className="flex flex-col h-full overflow-y-auto">
      {appAllowsModule('jobhub') && <DraggableModuleCard
        title="Job Search"
        nodeType="jobhub"
        icon={<Briefcase size={22} className="text-blue-400/50" />}
        moduleName="Job Search Module"
        instructions="Configure one search, add career files, and run it"
        subInstructions="Its listings are saved as it reads them; a Job Board scores and shows them"
        hoverBorderClass="hover:border-blue-500/30"
        hoverBgClass="hover:bg-blue-500/5"
        handleModuleDragStart={handleModuleDragStart}
      />}
      {appAllowsModule('jobboard') && <DraggableModuleCard
        title="Job Board"
        nodeType="jobboard"
        icon={<LayoutGrid size={22} className="text-indigo-400/50" />}
        moduleName="Job Board Module"
        instructions="Connect Job Searches to score and review what they find"
        subInstructions="Listings are scored as they arrive and grouped into one ranked board"
        footerText="Merge searches from different locations in one place"
        hoverBorderClass="hover:border-indigo-500/30"
        hoverBgClass="hover:bg-indigo-500/5"
        handleModuleDragStart={handleModuleDragStart}
      />}
    </div>
  );
});
