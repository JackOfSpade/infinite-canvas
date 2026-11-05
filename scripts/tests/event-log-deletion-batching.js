import fs from 'node:fs';
import path from 'node:path';
import { EventLoggerSingleton } from '../../src/utils/EventLogger.js';
import { eventHistoryHeading } from '../../electron/ipc/bugReport/clipboardCap.js';
import { assert } from './testHelpers.js';

export default [
  {
    name: 'Job Board child cascades collapse removal rows without hiding ordinary deletions',
    run: () => {
      const logger = new EventLoggerSingleton();
      logger.beginRemovalBatch({
        nodeIds: ['board-child-1', 'board-child-2'],
        edgeIds: ['board-edge-1', 'board-edge-2'],
        jobCardDismissalIds: ['board-child-1', 'board-child-2'],
        summary: '[JobBoard] child cascade requested id=board-1',
      });
      // Deliberately place one dismissal before its node removal and one after:
      // React Flow's lifecycle callbacks need not share a fixed ordering.
      logger.logJobCardDismissal('board-child-1', 'board-1', 1);
      logger.logNodeRemoval('board-child-1');
      logger.logNodeRemoval('board-child-2');
      logger.logEdgeRemoval('board-edge-1');
      logger.logEdgeRemoval('board-edge-2');
      logger.logJobCardDismissal('board-child-2', 'board-1', 0);
      logger.logNodeRemoval('ordinary-node');
      logger.logEdgeRemoval('ordinary-edge');
      logger.logJobCardDismissal('ordinary-card', 'board-1', 3);

      const abandonedBatch = logger.beginRemovalBatch({
        jobCardDismissalIds: ['restored-card'],
        summary: '[JobBoard] abandoned child cascade id=board-1',
      });
      logger.endRemovalBatch(abandonedBatch);
      logger.logJobCardDismissal('restored-card', 'board-1', 4);

      const events = logger.getLogs().join('\n');
      const summaries = logger.getLogs().filter(line => line.includes('[JobBoard] child cascade requested'));
      assert(summaries.length === 1
        && summaries[0].includes('nodes=2 edges=2 jobcards=2')
        && summaries[0].includes('individual removal events suppressed'),
      'a registered cascade must emit exactly one counted summary');
      assert(!events.includes('node removed id=board-child-1')
        && !events.includes('edge removed id=board-edge-1')
        && !events.includes('[JobCard] dismissed id=board-child-1'),
      'registered child node, edge, and dismissal rows must not flood the event log');
      assert(events.includes('node removed id=ordinary-node')
        && events.includes('edge removed id=ordinary-edge')
        && events.includes('[JobCard] dismissed id=ordinary-card')
        && events.includes('[JobCard] dismissed id=restored-card'),
      'ordinary deletions and manual Job Card dismissals must remain individually logged');

      const canvas = fs.readFileSync(path.resolve('src/Canvas.jsx'), 'utf8');
      const cleanup = fs.readFileSync(path.resolve('src/nodes/_shared/hubChildCleanup.js'), 'utf8');
      const board = fs.readFileSync(path.resolve('src/nodes/JobBoardNode.jsx'), 'utf8');
      assert(canvas.includes('EventLogger.logNodeRemoval(ch.id)')
        && canvas.includes('EventLogger.logEdgeRemoval(ch.id)'),
      'Canvas must route removal callbacks through the scoped suppression gate');
      assert(cleanup.includes('jobCardDismissalIds: owned.filter(n => n.type === \'jobcard\')')
        && cleanup.includes('EventLogger.beginRemovalBatch({'),
      'the child deletion helper must register exact node, edge, and Job Card dismissal IDs before deleting them');
      const deletionHook = fs.readFileSync(path.resolve('src/hooks/useCanvasOSDeletion.js'), 'utf8');
      assert(deletionHook.includes('EventLogger.logJobCardDismissal(cardId, hubId, stats.resultCount)'),
        'the Job Card deletion audit must pass through the scoped suppression gate');
      assert(board.includes('removalLogSummary: `[JobBoard] child cascade requested id=${id}`'),
        'Job Board cleanup must opt into the compact cascade summary');
      return { summaryRows: summaries.length, ordinaryDeletionRows: 2 };
    },
  },
  {
    name: 'event history reports its retained age and eviction count while settled handoffs fold into counters',
    run: () => {
      const logger = new EventLoggerSingleton();
      for (let index = 0; index < 2_500; index += 1) logger.log(`retention-${index} ${'x'.repeat(240)}`);
      for (let index = 0; index < 3; index += 1) logger.logCumulative('manual-ai-handoff-settled-test', 'focus-preserved');
      for (let index = 0; index < 2; index += 1) logger.logCumulative('manual-ai-handoff-settled-test', 'focus-cleared');
      const metadata = logger.getEventHistoryMetadata();
      const heading = eventHistoryHeading(metadata);
      const cumulativeRows = logger.getLogs().filter(line => line.includes('[Manual AI] handoff settled events:'));
      assert(metadata.retainedCount > 0 && metadata.evictedCount > 0
        && Number.isFinite(Date.parse(metadata.oldestRetainedAt))
        && heading.includes(`${metadata.retainedCount} retained row(s)`)
        && heading.includes(`${metadata.evictedCount} older row(s) evicted`)
        && heading.includes(`oldest retained ${metadata.oldestRetainedAt}`),
      'the report header names the actual retained event count, oldest retained timestamp, and number of evicted events');
      assert(cumulativeRows.length === 1 && cumulativeRows[0].includes('events: 5')
        && cumulativeRows[0].includes('focus-preserved=3') && cumulativeRows[0].includes('focus-cleared=2'),
      'repeated dock settlement outcomes update one cumulative line instead of evicting earlier history');
      return metadata;
    },
  },
];
