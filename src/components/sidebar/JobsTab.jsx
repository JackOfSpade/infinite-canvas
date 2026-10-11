import React from 'react';
import { Briefcase, CircleHelp, LayoutGrid } from 'lucide-react';
import { DraggableModuleCard } from './DraggableModuleCard';

export const JobsTab = React.memo(function JobsTab({ handleModuleDragStart }) {
  return (
    <div className="flex flex-col h-full overflow-y-auto">
      <DraggableModuleCard
        title="Job Search"
        nodeType="jobhub"
        icon={<Briefcase size={22} className="text-blue-400/50" />}
        moduleName="Job Search Module"
        instructions="Configure one search and add career files"
        subInstructions="Connect it to a Job Board; the board can queue and run selected searches"
        hoverBorderClass="hover:border-blue-500/30"
        hoverBgClass="hover:bg-blue-500/5"
        handleModuleDragStart={handleModuleDragStart}
      />
      <DraggableModuleCard
        title="Job Board"
        nodeType="jobboard"
        icon={<LayoutGrid size={22} className="text-indigo-400/50" />}
        moduleName="Job Board Module"
        instructions="Connect Job Search modules, then choose which to scan"
        subInstructions="The board queues selected searches and combines every completed connected result into one ranked board"
        footerText="Run and merge searches from different locations in one place"
        hoverBorderClass="hover:border-indigo-500/30"
        hoverBgClass="hover:bg-indigo-500/5"
        handleModuleDragStart={handleModuleDragStart}
      />
      <DraggableModuleCard
        title="Interview"
        nodeType="interviewhelper"
        icon={<CircleHelp size={22} className="text-violet-400/50" />}
        moduleName="Interview Helper"
        instructions="Prepare a private, grounded interview workspace"
        subInstructions="Use an approved or independently compiled career snapshot, job listing, and submitted bundle; it never invents career evidence"
        hoverBorderClass="hover:border-violet-500/30"
        hoverBgClass="hover:bg-violet-500/5"
        handleModuleDragStart={handleModuleDragStart}
      />
    </div>
  );
});
