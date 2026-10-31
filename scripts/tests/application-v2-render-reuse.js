import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applicationV2RenderKey, createApplicationV2RenderCache } from '../../electron/ipc/applicationV2RenderCache.js';
import { createApplicationV2HandoffReuse } from '../../electron/ipc/applicationV2HandoffReuse.js';
import { applicationRendererAssetDigest, applicationRendererSourceDigest, applicationV2RendererVersion } from '../../electron/ipc/applicationV2RendererVersion.js';
import { __applicationV2RenderCacheStatsForTests, __setLocalAiRenderPdfForTests, __writeVerifyRenderPhaseForTests } from '../../electron/ipc/localAiApplication.js';

const inputs = () => ({ html: '<main class="page">Synthetic</main>', letter: { name: 'Synthetic', paragraphs: ['Built tested software.'] },
  variantAttrs: 'data-page="letter"', trustedRenderedRoleDates: ['2020 – 2021'], targetPageCount: 1, rendererVersion: 'renderer-v1' });
const phase = () => ({ kind: 'ok', hostRenders: 1,
  resumeFit: { pageCount: 1, fontsLoaded: true, bytes: Buffer.from('synthetic-resume'), layoutIssues: [], layout: { contentHeightPx: 100 } },
  letterFit: { pageCount: 1, fontsLoaded: true, bytes: Buffer.from('synthetic-letter'), layoutIssues: [] } });
const binding = () => ({ jobId: 'synthetic', canvasRoot: '/tmp/synthetic', revision: 4, stage: 'pick', handoffCode: 'current',
  baseHashes: { source: 'current' }, input: { careerSnapshotId: 'snapshot' }, writeVerify: { candidates: ['accepted'] }, authority: { head: 'head' } });
function handoff() {
  const record = { jobId: 'synthetic', revision: 4, stage: 'pick', handoffCode: 'current', prompt: 'Synthetic prompt',
    pageImages: [{ candidateId: 'candidate-1', data: 'synthetic-image' }], baseHashes: { source: 'current' } };
  Object.defineProperties(record, { freshContextRequired: { value: true, enumerable: false }, freshContextKey: { value: 'synthetic-context', enumerable: false } });
  return record;
}

export default [
  {
    name: 'v2 render identity preserves exact content and every renderer input while excluding document ids',
    run() {
      const original = inputs(); const key = applicationV2RenderKey(original);
      assert.equal(applicationV2RenderKey({ ...original, docId: 'different-editor-id' }), key);
      for (const patch of [{ html: `${original.html} ` }, { letter: { ...original.letter, date: '2026-01-01' } },
        { letter: { ...original.letter, paragraphs: ['Different proof.'] } }, { variantAttrs: 'data-page="a4"' },
        { trustedRenderedRoleDates: ['2020 – 2022'] }, { targetPageCount: 2 }, { rendererVersion: 'renderer-v2' }])
        assert.notEqual(applicationV2RenderKey({ ...original, ...patch }), key);
      assert.equal(applicationV2RenderKey({ ...original, rendererVersion: null }), null);
    },
  },
  {
    name: 'v2 render cache retains verified bytes defensively and reports zero physical renders on a hit',
    async run() {
      const cache = createApplicationV2RenderCache(); let calls = 0;
      const render = async () => { calls += 1; return phase(); };
      const first = await cache.getOrRender('same', render);
      first.resumeFit.bytes.fill(0); first.resumeFit.layout.contentHeightPx = 999;
      const second = await cache.getOrRender('same', render);
      assert.equal(calls, 1); assert.equal(second.hostRenders, 0); assert.equal(second.cacheHit, true);
      assert.equal(second.resumeFit.bytes.toString(), 'synthetic-resume'); assert.equal(second.resumeFit.layout.contentHeightPx, 100);
      second.letterFit.bytes.fill(0);
      assert.equal((await cache.getOrRender('same', render)).letterFit.bytes.toString(), 'synthetic-letter');
      assert.equal(cache.stats().hits, 2);
    },
  },
  {
    name: 'v2 render cache never retains font faults missing bytes layout errors or non-one-page results',
    async run() {
      for (const changed of [{ kind: 'render-fault' }, { kind: 'host-fault' }, { kind: 'fit' },
        { resumeFit: { ...phase().resumeFit, fontsLoaded: false } }, { letterFit: { ...phase().letterFit, fontsLoaded: null } },
        { resumeFit: { ...phase().resumeFit, pageCount: 2 } }, { letterFit: { ...phase().letterFit, bytes: null } },
        { resumeFit: { ...phase().resumeFit, renderError: 'synthetic' } }, { resumeFit: { ...phase().resumeFit, layoutIssues: [{ id: 'overflow' }] } }]) {
        const cache = createApplicationV2RenderCache(); let calls = 0;
        const render = async () => { calls += 1; return { ...phase(), ...changed }; };
        await cache.getOrRender('same', render); await cache.getOrRender('same', render);
        assert.equal(calls, 2); assert.equal(cache.stats().entries, 0);
      }
    },
  },
  {
    name: 'v2 render cache coalesces identical in-flight work and clears pending ownership safely',
    async run() {
      const cache = createApplicationV2RenderCache(); let release; let calls = 0;
      const render = () => { calls += 1; return new Promise(resolve => { release = resolve; }); };
      const first = cache.getOrRender('same', render); const joined = cache.getOrRender('same', render);
      await Promise.resolve(); assert.equal(calls, 1); release(phase());
      assert.equal((await first).hostRenders, 1); assert.equal((await joined).hostRenders, 0);
      assert.equal(cache.stats().coalesced, 1);
      const pending = cache.getOrRender('next', render); await Promise.resolve(); cache.clear(); release(phase()); await pending;
      assert.equal(cache.stats().entries, 0, 'work started before a reset cannot repopulate the cache');
      await assert.rejects(cache.getOrRender('failed', async () => { throw new Error('synthetic'); }), /synthetic/);
      assert.equal(cache.stats().pending, 0);
    },
  },
  {
    name: 'v2 render cache enforces entry and byte bounds with least-recently-used eviction',
    async run() {
      const cache = createApplicationV2RenderCache({ maxEntries: 2 }); let calls = 0;
      const render = async () => { calls += 1; return phase(); };
      for (const key of ['a', 'b', 'a', 'c', 'b']) await cache.getOrRender(key, render);
      assert.equal(calls, 4); assert.equal(cache.stats().entries, 2);
      const tiny = createApplicationV2RenderCache({ maxBytes: 1 });
      await tiny.getOrRender('large', render); assert.equal(tiny.stats().entries, 0);
    },
  },
  {
    name: 'v2 handoff reuse requires the original untampered host object and exact current source state',
    run() {
      const reuse = createApplicationV2HandoffReuse(); const record = reuse.remember(handoff(), binding());
      assert.equal(reuse.match(record, binding()), record);
      assert.equal(record.freshContextRequired, true); assert.equal(record.freshContextKey, 'synthetic-context');
      assert.equal(reuse.match(structuredClone(record), binding()), null, 'IPC clones and forged records have no host brand');
      for (const patch of [{ revision: 5 }, { stage: 'write' }, { handoffCode: 'new' }, { jobId: 'other' },
        { canvasRoot: '/tmp/other' }, { baseHashes: { source: 'other' } }, { input: { careerSnapshotId: 'other' } },
        { writeVerify: { candidates: ['different'] } }, { authority: { head: 'changed' } }])
        assert.equal(reuse.match(record, { ...binding(), ...patch }), null);
      record.pageImages[0].data = 'tampered'; assert.equal(reuse.match(record, binding()), null);
      const changedPrompt = reuse.remember(handoff(), binding()); changedPrompt.prompt += ' forged';
      assert.equal(reuse.match(changedPrompt, binding()), null);
    },
  },
  {
    name: 'v2 renderer version hashes source CSS font bytes and Electron version rather than file metadata',
    run() {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-render-version-'));
      try {
        fs.mkdirSync(path.join(root, 'electron/ipc'), { recursive: true });
        for (const name of ['resumeHtml.js', 'resumeRender.js']) fs.writeFileSync(path.join(root, 'electron/ipc', name), name);
        const sourceDigest = applicationRendererSourceDigest(root);
        fs.writeFileSync(path.join(root, 'electron/ipc/resumeRender.js'), 'changed-renderer');
        assert.notEqual(applicationRendererSourceDigest(root), sourceDigest);
        for (const file of ['colors_and_type.css', 'resume.css', 'cover-letter.css']) fs.writeFileSync(path.join(root, file), file);
        const font = path.join(root, 'font.ttf'); fs.writeFileSync(font, 'synthetic-font');
        const args = { sourceDigest, designDir: root, fontContract: { body: 'Synthetic' }, electronVersion: '44', fontPaths: [font] };
        const version = applicationRendererAssetDigest(args);
        assert.notEqual(applicationRendererAssetDigest({ ...args, sourceDigest: 'new-source' }), version);
        assert.notEqual(applicationRendererAssetDigest({ ...args, electronVersion: '45' }), version);
        assert.notEqual(applicationRendererAssetDigest({ ...args, fontContract: { body: 'Different' } }), version);
        fs.writeFileSync(font, 'different-font'); assert.notEqual(applicationRendererAssetDigest(args), version);
        fs.writeFileSync(font, 'synthetic-font'); fs.writeFileSync(path.join(root, 'resume.css'), 'new-css');
        assert.notEqual(applicationRendererAssetDigest(args), version);
        fs.writeFileSync(path.join(root, 'resume.css'), 'resume.css');
        fs.writeFileSync(path.join(root, 'cover-letter.css'), '@font-face { src: url("font.ttf"); }');
        const local = applicationRendererAssetDigest({ ...args, fontPaths: [] }); fs.writeFileSync(font, 'changed-local-font');
        assert.notEqual(applicationRendererAssetDigest({ ...args, fontPaths: [] }), local);
      } finally { fs.rmSync(root, { recursive: true, force: true }); }
    },
  },
  {
    name: 'v2 memoized renderer version observes runtime source CSS and font changes and refuses unknown fonts',
    run() {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-live-version-'));
      try {
        fs.mkdirSync(path.join(root, 'electron/ipc'), { recursive: true });
        for (const name of ['resumeHtml.js', 'resumeRender.js']) fs.writeFileSync(path.join(root, 'electron/ipc', name), name);
        for (const name of ['colors_and_type.css', 'resume.css', 'cover-letter.css']) fs.writeFileSync(path.join(root, name), name);
        for (const name of ['Arial.ttf', 'Georgia.ttf', 'Menlo.ttc']) fs.writeFileSync(path.join(root, name), name);
        const args = { designDir: root, sourceRoot: root, fontContract: { body: 'Arial' }, electronVersion: '44', platform: 'darwin', fontRoots: [root] };
        const initial = applicationV2RendererVersion(args);
        assert.match(initial, /^[a-f\d]{64}$/u); assert.equal(applicationV2RendererVersion(args), initial);
        fs.appendFileSync(path.join(root, 'resume.css'), ' changed');
        const css = applicationV2RendererVersion(args); assert.notEqual(css, initial);
        fs.appendFileSync(path.join(root, 'Arial.ttf'), ' changed');
        const font = applicationV2RendererVersion(args); assert.notEqual(font, css);
        fs.appendFileSync(path.join(root, 'electron/ipc/resumeHtml.js'), ' changed');
        const source = applicationV2RendererVersion(args); assert.notEqual(source, font);
        assert.notEqual(applicationV2RendererVersion({ ...args, electronVersion: '45' }), source);
        assert.equal(applicationV2RendererVersion({ ...args, electronVersion: '' }), null);
        fs.unlinkSync(path.join(root, 'Menlo.ttc')); assert.equal(applicationV2RendererVersion(args), null);
        const vite = fs.readFileSync(path.resolve('vite.config.js'), 'utf8');
        assert.match(vite, /__APPLICATION_RENDERER_SOURCE_SHA256__:\s*JSON\.stringify\(applicationRendererSourceDigest\(\)\)/u);
      } finally { fs.rmSync(root, { recursive: true, force: true }); }
    },
  },
  {
    name: 'v2 injected PDF renderers bypass artifact reuse and retain independent fixture results',
    async run() {
      let calls = 0;
      __setLocalAiRenderPdfForTests(async () => { calls += 1; return { bytes: Buffer.from('synthetic'), fontsLoaded: true, pageCount: 1, layout: null }; });
      try {
        const args = { html: '<main class="page"><p>Synthetic proof.</p></main>', letter: { name: 'Synthetic', paragraphs: ['Synthetic proof.'] },
          input: { job: { title: 'Engineer', company: 'Synthetic' }, sourceRoles: [] }, renderState: { selectedRoleIds: [] } };
        assert.equal((await __writeVerifyRenderPhaseForTests(args)).kind, 'ok');
        assert.equal((await __writeVerifyRenderPhaseForTests(args)).kind, 'ok');
        assert.equal(calls, 4); assert.equal(__applicationV2RenderCacheStatsForTests().entries, 0);
      } finally { __setLocalAiRenderPdfForTests(null); }
    },
  },
];
