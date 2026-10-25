import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildCareerCleanLayer, careerCleanLayerPages, cleanCareerSkillNames, readCareerCleanLayer,
  produceCareerCleanLayer, verifyCareerCleanText, writeCareerCleanLayer,
} from '../../electron/ipc/careerCleanLayer.js';
import { fullApprovedHand, writeVerifySourcePrompt } from '../../electron/ipc/applicationWriteVerify.js';
import { __pasteTwinParagraphCitationsForTests, __pasteUnitGroundingErrorsForTests } from '../../electron/ipc/localAiApplication.js';

const snapshotId = 'a'.repeat(64);
const careers = [
  { id: 'host.career.achievement.farm.1', quote: 'I suported data-entry workflows using python for farm orders.', clean: 'I supported data-entry workflows using Python for farm orders.' },
  { id: 'host.career.achievement.museum.1', quote: 'I maintained blue-print records for 24 museum visits.', clean: 'I maintained blueprint records for 24 museum visits.' },
  { id: 'host.career.achievement.clinic.1', quote: 'I used nodeJS in client reports for a clinic.', clean: 'I used Node JS in client reports for a clinic.' },
  { id: 'host.career.achievement.library.1', quote: 'I did evualuation work for a library.', clean: 'I did evaluation work for a library.' },
];

export default [{
  name: 'Clean layer accepts only guarded orthographic variants across three unrelated careers',
  async run() {
    for (const career of careers) assert.equal(verifyCareerCleanText(career.quote, career.clean), true, career.id);
    const mutations = [
      ['word added', 'I suported data-entry workflows using python for all farm orders.'],
      ['number changed', 'I maintained blue-print records for 25 museum visits.'],
      ['verb inflated', 'I authored blue-print records for 24 museum visits.'],
      ['words reordered', 'I used client reports in nodeJS for a clinic.'],
      ['unit annotation changed', '- Python [Skill ID: pythan]'],
    ];
    for (const [label, mutated] of mutations) {
      const source = label === 'unit annotation changed' ? '- python [Skill ID: python]'
        : label === 'number changed' || label === 'verb inflated' ? careers[1].quote
        : label === 'words reordered' ? careers[2].quote : careers[0].quote;
      assert.equal(verifyCareerCleanText(source, mutated), false, label);
    }
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'career-clean-layer-'));
    try {
      const catalog = careers.map(({ id, quote }) => ({ id, quote, sourceId: 'career-data' }));
      const layer = buildCareerCleanLayer(snapshotId, catalog, [{ items: careers.map(({ id, clean }) => ({ id, clean })) }]);
      assert.equal(layer.rejections.length, 0);
      assert.equal(layer.items.filter((row, index) => row.clean !== catalog[index].quote).length, careers.length);
      await writeCareerCleanLayer(root, layer);
      const read = await readCareerCleanLayer(root, snapshotId, catalog);
      assert.ok(read);
      assert.deepEqual(read.catalog.map(row => row.quote), catalog.map(row => row.quote), 'immutable original audit quotes');
      assert.deepEqual(read.catalog.map(row => row.cleanQuote), careers.map(row => row.clean));
      assert.equal(await readCareerCleanLayer(root, snapshotId, catalog.map((row, index) => index ? row : { ...row, quote: 'tampered' })), null);
      const invalid = buildCareerCleanLayer(snapshotId, catalog, [{ items: careers.map((row, index) => ({ id: row.id, clean: index === 1 ? mutations[1][1] : row.clean })) }]);
      assert.equal(invalid.items[1].clean, catalog[1].quote, 'bad clean text falls back to original');
      assert.deepEqual(invalid.rejections.map(row => row.reason), ['non-orthographic']);
      let handoffs = 0;
      const reused = await produceCareerCleanLayer({ snapshotId, catalog, root,
        callText: async () => { handoffs += 1; throw new Error('existing sidecar must avoid another AI pass'); } });
      assert.equal(reused.reused, true);
      assert.equal(reused.reusedItems, catalog.length);
      assert.equal(reused.processedItems, 0);
      assert.equal(handoffs, 0);
      const freshRoot = path.join(root, 'fresh');
      const produced = await produceCareerCleanLayer({ snapshotId, catalog, root: freshRoot,
        callText: async (_prompt, options) => {
          handoffs += 1;
          assert.equal(options.task, 'career-profile-clean');
          return { items: careers.map(({ id, clean }) => ({ id, clean })) };
        } });
      assert.equal(produced.reused, false);
      assert.equal(produced.reusedItems, 0);
      assert.equal(produced.processedItems, catalog.length);
      assert.equal(handoffs, 1);
      assert.ok(await readCareerCleanLayer(freshRoot, snapshotId, catalog));
      // Independent pages are issued together, not one after another.
      const longCatalog = Array.from({ length: 6 }, (_, page) => careers.map(({ id, quote }) => ({
        id: `${id}.p${page}`, quote: `${quote} ${'x'.repeat(6_000)}`, sourceId: 'career-data' }))).flat();
      const pageCount = careerCleanLayerPages(longCatalog).length;
      assert.ok(pageCount > 1, 'fixture spans several pages');
      let inFlight = 0; let peak = 0;
      const parallel = await produceCareerCleanLayer({ snapshotId, catalog: longCatalog, root: path.join(root, 'parallel'),
        callText: async (prompt) => {
          inFlight += 1; peak = Math.max(peak, inFlight);
          await new Promise(resolve => setTimeout(resolve, 10));
          inFlight -= 1;
          return { items: longCatalog.filter(row => prompt.includes(row.id)).map(row => ({ id: row.id, clean: row.quote })) };
        } });
      assert.equal(parallel.reused, false);
      assert.equal(peak, pageCount, 'every page is in flight at once');
      assert.deepEqual(parallel.layer.rejections, []);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  },
}, {
  name: 'Clean source updates send only changed rows and carry verified spellings for exact id and quote matches',
  async run() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'career-clean-incremental-'));
    try {
      const catalog = careers.map(({ id, quote }) => ({ id, quote, sourceId: 'career-data' }));
      await writeCareerCleanLayer(root, buildCareerCleanLayer(snapshotId, catalog, [{ items: careers.map(({ id, clean }) => ({ id, clean })) }]));
      const current = catalog.map((row, index) => index === 1 ? { ...row, quote: row.quote.replace('24', '25') } : row);
      const batches = [];
      const result = await produceCareerCleanLayer({ snapshotId: 'b'.repeat(64), catalog: current, root,
        previous: { snapshotId, catalog },
        callText: async prompt => {
          const rows = JSON.parse(prompt.split('\n\n').at(-1));
          batches.push(rows);
          return { items: rows.map(row => ({ id: row.id, clean: row.original.replace('blue-print', 'blueprint') })) };
        } });
      assert.deepEqual(batches, [[{ id: current[1].id, original: current[1].quote }]], 'unchanged career text must stay out of the AI request');
      assert.equal(result.reusedItems, 3);
      assert.equal(result.processedItems, 1);
      assert.deepEqual(result.layer.rejections, []);
      assert.equal(result.layer.items[0].clean, careers[0].clean, 'verified previous spelling survives the new snapshot');
      assert.equal(result.layer.items[1].clean, careers[1].clean.replace('24', '25'), 'changed quotes require a new spelling proposal');
      const published = await readCareerCleanLayer(root, 'b'.repeat(64), current);
      assert.ok(published);
      assert.deepEqual(published.catalog.map(row => row.quote), current.map(row => row.quote));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  },
}, {
  name: 'Clean source updates cannot retain deleted rows or transfer spellings to a different evidence id',
  async run() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'career-clean-deletion-'));
    try {
      const catalog = careers.map(({ id, quote }) => ({ id, quote }));
      await writeCareerCleanLayer(root, buildCareerCleanLayer(snapshotId, catalog, [{ items: careers.map(({ id, clean }) => ({ id, clean })) }]));
      const remaining = [catalog[0], catalog[2]];
      const deleted = await produceCareerCleanLayer({ snapshotId: 'b'.repeat(64), catalog: remaining, root,
        previous: { snapshotId, catalog }, callText: async () => { throw new Error('retained rows need no new AI work'); } });
      assert.equal(deleted.reusedItems, 2);
      assert.equal(deleted.processedItems, 0);
      assert.deepEqual(deleted.layer.items.map(row => row.id), remaining.map(row => row.id), 'deleted evidence has no row in the new clean layer');
      const renamed = [{ ...catalog[0], id: `${catalog[0].id}.new` }];
      let handoffs = 0;
      const changedIdentity = await produceCareerCleanLayer({ snapshotId: 'c'.repeat(64), catalog: renamed, root,
        previous: { snapshotId, catalog }, callText: async () => {
          handoffs += 1;
          return { items: [{ id: renamed[0].id, clean: renamed[0].quote }] };
        } });
      assert.equal(handoffs, 1, 'a quote match alone cannot transfer a previously verified evidence row');
      assert.equal(changedIdentity.reusedItems, 0);
      assert.equal(changedIdentity.processedItems, 1);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  },
}, {
  name: 'Clean source updates fall back to the complete catalog when the previous clean layer is corrupt',
  async run() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'career-clean-corrupt-'));
    try {
      const catalog = careers.map(({ id, quote }) => ({ id, quote }));
      const layer = buildCareerCleanLayer(snapshotId, catalog, [{ items: careers.map(({ id, clean }) => ({ id, clean })) }]);
      await writeCareerCleanLayer(root, layer);
      layer.items[0].clean = 'I owned all farm operations.';
      fs.writeFileSync(path.join(root, 'clean-layers', `${snapshotId}.json`), JSON.stringify(layer));
      const submitted = [];
      const result = await produceCareerCleanLayer({ snapshotId: 'b'.repeat(64), catalog, root,
        previous: { snapshotId, catalog }, callText: async prompt => {
          const rows = JSON.parse(prompt.split('\n\n').at(-1));
          submitted.push(...rows);
          return { items: rows.map(row => ({ id: row.id, clean: row.original })) };
        } });
      assert.equal(result.reusedItems, 0);
      assert.equal(result.processedItems, catalog.length);
      assert.deepEqual(submitted.map(row => row.id), catalog.map(row => row.id));
      assert.ok(await readCareerCleanLayer(root, 'b'.repeat(64), catalog));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  },
}, {
  name: 'Clean source updates with identical evidence rows publish a verified new layer without AI calls',
  async run() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'career-clean-identical-'));
    try {
      const catalog = careers.map(({ id, quote }) => ({ id, quote }));
      await writeCareerCleanLayer(root, buildCareerCleanLayer(snapshotId, catalog, [{ items: careers.map(({ id, clean }) => ({ id, clean })) }]));
      const result = await produceCareerCleanLayer({ snapshotId: 'b'.repeat(64), catalog, root,
        previous: { snapshotId, catalog }, callText: async () => { throw new Error('identical verified rows need no new AI work'); } });
      assert.equal(result.reused, false, 'this is a new immutable snapshot layer');
      assert.equal(result.reusedItems, catalog.length);
      assert.equal(result.processedItems, 0);
      assert.equal(result.layer.snapshotId, 'b'.repeat(64));
      assert.deepEqual(result.layer.items.map(row => row.clean), careers.map(row => row.clean));
      assert.ok(await readCareerCleanLayer(root, 'b'.repeat(64), catalog));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  },
}, {
  name: 'Clean skill display and full hand use verified casing while ids and originals remain fixed',
  run() {
    const profile = { roles: [], achievements: [], projects: [], skills: [{ id: 'python', name: 'python', indexEligible: true }], education: [], certifications: [], otherEvidence: [] };
    const catalog = [{ id: 'host.career.skill.python.1', quote: '- python [Skill ID: python]', cleanQuote: '- Python [Skill ID: python]', sourceId: 'career-data' }];
    assert.equal(cleanCareerSkillNames(profile, catalog).get('python'), 'Python');
    const alteredName = buildCareerCleanLayer(snapshotId, [{ id: catalog[0].id, quote: catalog[0].quote }], [
      { items: [{ id: catalog[0].id, clean: '- pythan [Skill ID: python]' }] },
    ]);
    assert.equal(alteredName.items[0].clean, catalog[0].quote, 'a skill name cannot change letters');
    assert.ok(fullApprovedHand(profile, catalog).includes('[host.career.skill.python.1] - Python'));
    const prompt = writeVerifySourcePrompt({ posting: 'Need Python.', requirements: [], listingEvidence: [], identity: {}, sourceRoles: [], profile, catalog });
    assert.ok(prompt.includes('"name":"Python"'));
    assert.equal(catalog[0].quote, '- python [Skill ID: python]');
    assert.deepEqual(__pasteTwinParagraphCitationsForTests([{ evidenceIds: [catalog[0].id] }], catalog), [[
      '- python [Skill ID: python]', '- Python [Skill ID: python]',
    ]], 'literal-source checks receive the original and verified clean layer');
  },
}, {
  name: 'Truth checks read both guarded layers without losing ownership catches in three domains',
  run() {
    for (const career of careers) {
      const input = {
        unitLabel: 'Résumé bullet', unitId: 'b', finalText: career.clean,
        evidenceIds: [career.id], acceptedEvidence: [{ id: career.id, sourceId: 'career-data', quote: career.quote, cleanQuote: career.clean }],
        identityTokens: [], label: 'resumeBullets', sourceRoles: [], careerData: career.quote,
        authority: null, projects: [], postingText: '', targetCompany: '',
      };
      assert.deepEqual(__pasteUnitGroundingErrorsForTests(input), [], career.id);
      assert.ok(__pasteUnitGroundingErrorsForTests({ ...input, finalText: `I owned ${career.clean.slice(2)}` }).length, career.id);
    }
  },
}, {
  name: 'Sabotage: bypassing ordered-word comparison makes the reorder mutation pass and fails this proof',
  async run() {
    // A data: module cannot resolve the layer's relative scheduler import.
    const schedulerImport = "'../../src/utils/handoffScheduler.js'";
    const rawSource = fs.readFileSync(fileURLToPath(new URL('../../electron/ipc/careerCleanLayer.js', import.meta.url)), 'utf8');
    assert.ok(rawSource.includes(schedulerImport), 'scheduler import exists');
    const source = rawSource.replace(schedulerImport, `'${new URL('../../src/utils/handoffScheduler.js', import.meta.url).href}'`);
    const target = 'return orthographicGrouping(original, proposed, originalWords, cleanWords);';
    assert.ok(source.includes(target), 'guard branch exists');
    const sabotaged = await import(`data:text/javascript;base64,${Buffer.from(source.replace(target, 'return true;')).toString('base64')}`);
    assert.equal(verifyCareerCleanText(careers[2].quote, 'I used client reports in nodeJS for a clinic.'), false);
    assert.equal(sabotaged.verifyCareerCleanText(careers[2].quote, 'I used client reports in nodeJS for a clinic.'), true);
    const annotationFence = 'if (JSON.stringify(annotations(original)) !== JSON.stringify(annotations(proposed))) return false;';
    assert.ok(source.includes(annotationFence));
    const withoutAnnotationFence = await import(`data:text/javascript;base64,${Buffer.from(source.replace(annotationFence, '')).toString('base64')}`);
    assert.equal(verifyCareerCleanText('- python [Skill ID: python]', '- Python [Skill ID: Python]'), false);
    assert.equal(withoutAnnotationFence.verifyCareerCleanText('- python [Skill ID: python]', '- Python [Skill ID: Python]'), true);
  },
}];
