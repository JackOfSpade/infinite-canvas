import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { assert } from './testHelpers.js';
import { generateMarkdown } from '../test-dependencies.js';
import { collectPointerProbes, POINTER_PROBE_TARGETS } from '../../src/utils/pointerOcclusionProbe.js';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

function makeDom({ buttonRect = { x: 100, y: 100, width: 90, height: 60 } } = {}) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  const doc = dom.window.document;
  const button = doc.createElement('button');
  button.setAttribute('data-testid', 'canvas-settings-button');
  doc.body.appendChild(button);
  button.getBoundingClientRect = () => ({ ...buttonRect, top: buttonRect.y, left: buttonRect.x, bottom: buttonRect.y + buttonRect.height, right: buttonRect.x + buttonRect.width });
  return { dom, doc, win: dom.window, button };
}

function closeDom(dom) {
  dom.window.close();
}

export default [
  {
    name: 'pointer occlusion probe: reachable target scores 9/9',
    run: () => {
      const { dom, doc, win, button } = makeDom();
      try {
        doc.elementFromPoint = () => button;
        const result = collectPointerProbes(doc, win);
        assert(result.v === 1, 'probe carries version 1');
        assert(result.targets.length === 1, 'one target reported');
        const t = result.targets[0];
        assert(t.id === 'canvas-settings-button', 'target id matches');
        assert(t.status === 'reachable', `expected reachable, got ${t.status}`);
        assert(t.reachable === 9, `expected reachable 9, got ${t.reachable}`);
        assert(t.sampled === 9, `expected sampled 9, got ${t.sampled}`);
      } finally {
        closeDom(dom);
      }
    },
  },
  {
    name: 'pointer occlusion probe: dock covers the control entirely',
    run: () => {
      const { dom, doc, win } = makeDom();
      try {
        const occluder = doc.createElement('div');
        const section = doc.createElement('section');
        section.id = 'non-api-ai-handoff-panel';
        section.appendChild(occluder);
        const dock = doc.createElement('div');
        dock.setAttribute('data-handoff-dock', 'expanded');
        dock.appendChild(section);
        doc.body.appendChild(dock);
        dock.getBoundingClientRect = () => ({ x: 320, y: 420, width: 300, height: 240, top: 420, left: 320, bottom: 660, right: 620 });

        doc.elementFromPoint = () => occluder;
        const result = collectPointerProbes(doc, win);
        const t = result.targets[0];
        assert(t.status === 'occluded', `expected occluded, got ${t.status}`);
        assert(t.reachable === 0, `expected reachable 0, got ${t.reachable}`);
        assert(t.occludedBy === 'div < section#non-api-ai-handoff-panel', `unexpected occludedBy: ${t.occludedBy}`);
        assert(t.occluderInDock === true, 'occluder flagged as inside dock');
        assert(result.dock.state === 'expanded', `expected expanded dock, got ${result.dock.state}`);
        assert(typeof result.dock.rect.x === 'number' && Number.isInteger(result.dock.rect.x), 'dock rect.x is a rounded number');
        assert(typeof result.dock.rect.width === 'number' && Number.isInteger(result.dock.rect.width), 'dock rect.width is a rounded number');
      } finally {
        closeDom(dom);
      }
    },
  },
  {
    name: 'pointer occlusion probe: partially covered target reports partial',
    run: () => {
      const { dom, doc, win, button } = makeDom();
      try {
        const occluder = doc.createElement('aside');
        doc.body.appendChild(occluder);
        const rect = button.getBoundingClientRect();
        doc.elementFromPoint = (x) => (x > rect.x + rect.width * 2 / 3 ? occluder : button);
        const result = collectPointerProbes(doc, win);
        const t = result.targets[0];
        assert(t.status === 'partial', `expected partial, got ${t.status}`);
        assert(t.reachable === 6, `expected reachable 6, got ${t.reachable}`);
        assert(t.sampled === 9, `expected sampled 9, got ${t.sampled}`);
      } finally {
        closeDom(dom);
      }
    },
  },
  {
    name: 'pointer occlusion probe: edge statuses and error path',
    run: () => {
      {
        const { dom, doc, win } = makeDom();
        try {
          const result = collectPointerProbes(doc, win);
          const t = result.targets[0];
          assert(t.status === 'unsupported', `expected unsupported, got ${t.status}`);
        } finally { closeDom(dom); }
      }
      {
        const { dom, doc, win, button } = makeDom();
        try {
          doc.body.removeChild(button);
          const result = collectPointerProbes(doc, win);
          assert(result.targets[0].status === 'missing', 'missing target reported when selector absent');
        } finally { closeDom(dom); }
      }
      {
        const { dom, doc, win } = makeDom({ buttonRect: { x: 100, y: 100, width: 0, height: 60 } });
        try {
          const result = collectPointerProbes(doc, win);
          assert(result.targets[0].status === 'no-layout', 'zero-size rect reports no-layout');
        } finally { closeDom(dom); }
      }
      {
        const { dom, doc, win } = makeDom({ buttonRect: { x: -100, y: -100, width: 50, height: 50 } });
        try {
          doc.elementFromPoint = () => null;
          const result = collectPointerProbes(doc, win);
          assert(result.targets[0].status === 'offscreen', 'fully off-screen rect reports offscreen');
        } finally { closeDom(dom); }
      }
      {
        const { dom, doc, win } = makeDom();
        try {
          const dock = doc.createElement('div');
          dock.setAttribute('data-handoff-dock', 'collapsed');
          doc.body.appendChild(dock);
          const result = collectPointerProbes(doc, win);
          assert(result.dock.state === 'collapsed', 'collapsed dock recognised');
        } finally { closeDom(dom); }
      }
      {
        const { dom, doc, win } = makeDom();
        try {
          const result = collectPointerProbes(doc, win);
          assert(result.dock.state === 'absent', 'no dock element reports absent');
        } finally { closeDom(dom); }
      }
      {
        const { dom, doc, win } = makeDom();
        try {
          const dock = doc.createElement('div');
          dock.setAttribute('data-handoff-dock', 'banana');
          doc.body.appendChild(dock);
          const result = collectPointerProbes(doc, win);
          assert(result.dock.state === 'unknown', 'unrecognised dock attribute reports unknown');
        } finally { closeDom(dom); }
      }
      {
        const { dom, doc, win, button } = makeDom();
        try {
          button.getBoundingClientRect = () => { throw new Error('boom'); };
          const result = collectPointerProbes(doc, win);
          assert(JSON.stringify(result) === JSON.stringify({ v: 1, error: 'probe-failed' }),
            'throwing getBoundingClientRect collapses to probe-failed');
        } finally { closeDom(dom); }
      }
    },
  },
  {
    name: 'pointer occlusion probe: never leaks text content or class names',
    run: () => {
      const { dom, doc, win } = makeDom();
      try {
        const occluder = doc.createElement('div');
        occluder.textContent = 'SECRET-TEXT-9';
        occluder.className = 'secret-class-9';
        doc.body.appendChild(occluder);
        doc.elementFromPoint = () => occluder;
        const result = collectPointerProbes(doc, win);
        const json = JSON.stringify(result);
        assert(!json.includes('SECRET-TEXT-9'), 'text content must not appear');
        assert(!json.includes('secret-class-9'), 'class name must not appear');
      } finally {
        closeDom(dom);
      }
    },
  },
  {
    name: 'pointer occlusion probe: markdown renders window size and occlusion section',
    run: () => {
      const probe = {
        v: 1,
        dock: { state: 'expanded', rect: { x: 320, y: 420, width: 300, height: 240 } },
        targets: [
          {
            id: 'canvas-settings-button',
            status: 'occluded',
            rect: { x: 330, y: 430, width: 90, height: 60 },
            reachable: 0,
            sampled: 9,
            occludedBy: 'div < section#non-api-ai-handoff-panel',
            occluderInDock: true,
          },
        ],
      };
      const report = generateMarkdown({
        description: 'Cannot click Settings.',
        nodes: [], edges: [], drawings: [],
        frontEndState: { windowInnerWidth: 1280, windowInnerHeight: 800, pointerProbes: probe },
        nodeInternals: [], nodeComponentStates: [], eventLogs: [], filterCode: 'FULL',
      }).markdown;

      assert(report.includes('- Window: 1280×800 (inner, CSS px)'), 'window size line rendered');
      assert(report.includes('## Pointer Occlusion Probe'), 'probe section rendered');
      assert(report.includes('⚠️ **occluded**'), 'occluded wording rendered');
      assert(report.includes('div < section#non-api-ai-handoff-panel'), 'occluder described via id only');
      assert(report.includes('(inside the AI handoff dock)'), 'dock provenance rendered');

      const app = report.indexOf('## Application State Summary');
      const runtime = report.indexOf('## Runtime Identity');
      const probeIdx = report.indexOf('## Pointer Occlusion Probe');
      const persisted = report.indexOf('## Persisted Workspace Snapshot');
      assert(app !== -1 && runtime !== -1 && probeIdx !== -1 && persisted !== -1, 'all expected headings present');
      assert(probeIdx > runtime, 'probe section comes after Runtime Identity');
      assert(probeIdx > app, 'probe section comes after Application State Summary');
      assert(probeIdx < persisted, 'probe section comes before Persisted Workspace Snapshot');

      const reachableReport = generateMarkdown({
        description: 'd', nodes: [], edges: [], drawings: [],
        frontEndState: { pointerProbes: { v: 1, dock: { state: 'absent', rect: null }, targets: [{ id: 'canvas-settings-button', status: 'reachable', rect: { x: 1, y: 2, width: 30, height: 20 }, reachable: 9, sampled: 9, occludedBy: null, occluderInDock: false }] } },
        nodeInternals: [], nodeComponentStates: [], eventLogs: [], filterCode: 'FULL',
      }).markdown;
      assert(reachableReport.includes('✅ reachable'), 'reachable target renders ✅ reachable');

      const emptyReport = generateMarkdown({
        description: 'd', nodes: [], edges: [], drawings: [], frontEndState: {},
        nodeInternals: [], nodeComponentStates: [], eventLogs: [], filterCode: 'FULL',
      }).markdown;
      assert(!emptyReport.includes('## Pointer Occlusion Probe'), 'empty state has no probe section');
      assert(!emptyReport.includes('Window:'), 'empty state has no Window line');
      assert(!emptyReport.includes('undefined'), 'no undefined leaks in empty report');
      assert(!emptyReport.includes('NaN'), 'no NaN leaks in empty report');
    },
  },
  {
    name: 'pointer occlusion probe: hostile values never echo',
    run: () => {
      const hostile = {
        v: 1,
        dock: { state: '<script>alert(1)</script>', rect: { x: NaN, y: Infinity, width: -5, height: 'big' } },
        targets: [
          {
            id: 'bad id!',
            status: '<script>alert(1)</script>',
            rect: { x: 1, y: 2, width: 3, height: 4 },
            reachable: 0,
            sampled: 9,
            occludedBy: 'https://evil.example/x?token=[REDACTED]',
            occluderInDock: true,
          },
          {
            id: 'canvas-settings-button',
            status: 'occluded',
            rect: { x: 1, y: 2, width: 3, height: 4 },
            reachable: 'https://evil2.example/count',
            sampled: '<img src=x onerror=1>',
            occludedBy: 'https://evil.example/x?token=[REDACTED]',
            occluderInDock: false,
          },
        ],
      };
      const report = generateMarkdown({
        description: 'd', nodes: [], edges: [], drawings: [],
        frontEndState: { pointerProbes: hostile },
        nodeInternals: [], nodeComponentStates: [], eventLogs: [], filterCode: 'FULL',
      }).markdown;
      assert(report.includes('## Pointer Occlusion Probe'), 'section still renders for hostile input');
      assert(!report.includes('evil.example'), 'hostile occluder URL never echoed');
      assert(!report.includes('<script>'), 'hostile status never echoed');
      assert(!report.includes('token=[REDACTED]'), 'hostile token never echoed');
      assert(!report.includes('bad id!'), 'hostile target id never echoed');
      assert(!report.includes('evil2.example') && !report.includes('<img'), 'hostile reachable/sampled counts never echoed');
      assert(report.includes('?/? sampled points reach the control'), 'non-numeric counts render as ?/?');
      assert(report.includes('an element (description withheld)'), 'withheld description fallback rendered');
    },
  },
  {
    name: 'pointer occlusion probe: looks through the issue reporter dialog\'s own backdrop',
    run: () => {
      const { dom, doc, win, button } = makeDom();
      try {
        const backdrop = doc.createElement('div');
        backdrop.setAttribute('data-pointer-probe-ignore', '');
        const panel = doc.createElement('div');
        panel.setAttribute('data-pointer-probe-ignore', '');
        const panelChild = doc.createElement('textarea');
        panel.appendChild(panelChild);
        doc.body.append(backdrop, panel);

        // The reporter's invisible backdrop (and its panel) sit above the control.
        doc.elementsFromPoint = () => [panelChild, panel, backdrop, button, doc.body];
        let t = collectPointerProbes(doc, win).targets[0];
        assert(t.status === 'reachable' && t.reachable === 9 && t.sampled === 9,
          `ignored dialog layers do not count as occluders (got ${t.status} ${t.reachable}/${t.sampled})`);

        // A real occluder BELOW the ignored layers is still found and named.
        const dock = doc.createElement('div');
        dock.setAttribute('data-handoff-dock', 'expanded');
        const dockPanel = doc.createElement('section');
        dockPanel.id = 'non-api-ai-handoff-panel';
        dock.appendChild(dockPanel);
        doc.body.appendChild(dock);
        doc.elementsFromPoint = () => [backdrop, dockPanel, dock, button, doc.body];
        t = collectPointerProbes(doc, win).targets[0];
        assert(t.status === 'occluded' && t.reachable === 0, `a real occluder under the dialog layers is still reported (got ${t.status})`);
        assert(t.occludedBy === 'section#non-api-ai-handoff-panel' && t.occluderInDock === true,
          `the occluder is the dock panel, not the ignored backdrop (got ${t.occludedBy})`);

        // Without the marker the very same backdrop IS reported (the flag is what excuses it).
        backdrop.removeAttribute('data-pointer-probe-ignore');
        doc.elementsFromPoint = () => [backdrop, button, doc.body];
        t = collectPointerProbes(doc, win).targets[0];
        assert(t.status === 'occluded' && t.occludedBy === 'div', 'an unmarked backdrop still counts as an occluder');
      } finally {
        closeDom(dom);
      }
    },
  },
  {
    name: 'pointer occlusion probe: occluder grammar is exact and the summary spacing is unchanged',
    run: () => {
      const render = (occludedBy) => generateMarkdown({
        description: 'd', nodes: [], edges: [], drawings: [],
        frontEndState: { pointerProbes: { v: 1, dock: { state: 'absent', rect: null }, targets: [{ id: 'canvas-settings-button', status: 'occluded', rect: { x: 1, y: 2, width: 3, height: 4 }, reachable: 0, sampled: 9, occludedBy, occluderInDock: false }] } },
        nodeInternals: [], nodeComponentStates: [], eventLogs: [], filterCode: 'FULL',
      }).markdown;
      for (const legit of ['div', 'section#non-api-ai-handoff-panel', 'button[data-testid=canvas-settings-button]', 'div < section#non-api-ai-handoff-panel', 'span < button[data-testid=x-1]', 'my-element#a_b-1']) {
        assert(render(legit).includes(`covered by \`${legit}\``), `a description the probe can produce is kept: ${legit}`);
      }
      for (const hostile of ['<img src=x>', 'div < <img src=x>', 'div < div', 'DIV', 'div#a b', 'div[onclick=x]', 'a'.repeat(200), 'div < section#x < main#y']) {
        const out = render(hostile);
        assert(!out.includes(hostile) && out.includes('an element (description withheld)'), `a description outside the grammar is withheld: ${hostile.slice(0, 30)}`);
      }

      const empty = generateMarkdown({ description: 'd', nodes: [], edges: [], drawings: [], frontEndState: {}, nodeInternals: [], nodeComponentStates: [], eventLogs: [], filterCode: 'FULL' }).markdown;
      assert(/- OS: [^\n]+\n\n\n## Runtime Identity/.test(empty), 'a report without window size keeps the spacing it always had');
      const sized = generateMarkdown({ description: 'd', nodes: [], edges: [], drawings: [], frontEndState: { viewport: { x: 1, y: 2, zoom: 3 }, windowInnerWidth: 1280, windowInnerHeight: 800 }, nodeInternals: [], nodeComponentStates: [], eventLogs: [], filterCode: 'FULL' }).markdown;
      assert(/- Viewport: zoom=3 x=1 y=2\n- Window: 1280×800 \(inner, CSS px\)\n\n## Runtime Identity/.test(sized), 'the window size follows the viewport line with no stray blank row');
    },
  },
  {
    name: 'pointer occlusion probe: wiring pins',
    run: () => {
      const hookSrc = fs.readFileSync(path.join(repoRoot, 'src/hooks/useIssueReporter.js'), 'utf8');
      assert(hookSrc.includes("from '../utils/pointerOcclusionProbe'"), 'useIssueReporter imports the probe');
      const feStart = hookSrc.indexOf('frontEndState: {');
      const feEnd = hookSrc.indexOf('nodeInternals,', feStart);
      assert(feStart !== -1 && feEnd !== -1 && feEnd > feStart, 'frontEndState block found');
      const block = hookSrc.slice(feStart, feEnd);
      assert(block.includes('pointerProbes: collectPointerProbes(),'), 'pointerProbes collected inside frontEndState');

      // The reporter's own dialog must be looked through (its invisible backdrop is
      // open when the report is captured). The marker lives on Dialog, only the
      // issue reporter turns it on, and the probe reads the very same attribute.
      const dialogSrc = fs.readFileSync(path.join(repoRoot, 'src/components/Dialog.jsx'), 'utf8');
      const reporterSrc = fs.readFileSync(path.join(repoRoot, 'src/components/IssueReporterDialog.jsx'), 'utf8');
      const probeSrc = fs.readFileSync(path.join(repoRoot, 'src/utils/pointerOcclusionProbe.js'), 'utf8');
      assert((dialogSrc.match(/data-pointer-probe-ignore=\{probePassthrough \? '' : undefined\}/g) || []).length === 2,
        'Dialog marks BOTH its backdrop and its panel when probePassthrough is set');
      assert(reporterSrc.includes('<Dialog onClose={handleClose} title="Report an Issue" probePassthrough>'), 'the issue reporter opts in');
      assert(probeSrc.includes("const IGNORE_SELECTOR = '[data-pointer-probe-ignore]';"), 'the probe ignores exactly the attribute Dialog sets');
      const otherDialogUsers = ['src/components/CustomizeDialog.jsx', 'src/components/NonApiAiDialog.jsx']
        .filter(file => fs.readFileSync(path.join(repoRoot, file), 'utf8').includes('probePassthrough'));
      assert(otherDialogUsers.length === 0, `no other dialog silently opts out of being reported as an occluder: ${otherDialogUsers.join(', ')}`);

      const toolbarSrc = fs.readFileSync(path.join(repoRoot, 'src/components/CanvasToolbar.jsx'), 'utf8');
      assert(toolbarSrc.includes('data-testid="canvas-settings-button"'), 'Settings button keeps its testid');
      assert(POINTER_PROBE_TARGETS.length === 1, 'single probe target configured');
      assert(POINTER_PROBE_TARGETS[0].selector === '[data-testid="canvas-settings-button"]', 'selector matches the Settings button testid');
    },
  },
];
