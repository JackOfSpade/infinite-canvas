import fs from 'node:fs';
import assert from 'node:assert';

import {
  APPLICATION_BUNDLE_TONES,
  applicationBundleIndicator,
} from '../../src/utils/jobCardBundleIndicator.js';

function readNodeSource() {
  return fs.readFileSync(
    new URL('../../src/nodes/JobCardNode.jsx', import.meta.url),
    'utf8',
  );
}

export default [
  {
    name: 'applicationBundleIndicator returns null for non-saved and malformed inputs',
    run: async () => {
      const cases = [
        null,
        undefined,
        0,
        42,
        '',
        'saved',
        true,
        false,
        ['saved'],
        { status: 'saved' },
        { id: 'job-1' },
        { status: 'queued', id: 'job-1' },
        { status: 'importing', id: 'job-1' },
        { status: 'completed', id: 'job-1' },
        { status: 'failed', id: 'job-1' },
        { status: 'status-error', id: 'job-1' },
        { status: 'render-retry-required', id: 'job-1' },
        { status: 'invalid', id: 'job-1' },
        { status: 'saved', id: '' },
        { status: 'saved', id: 7 },
        { status: 'saved', id: null },
      ];

      for (const input of cases) {
        assert.strictEqual(
          applicationBundleIndicator(input),
          null,
          `expected null for ${JSON.stringify(input)}`,
        );
      }
    },
  },
  {
    name: 'a plain saved bundle maps to the saved tone and only appends savedDir when non-empty',
    run: async () => {
      const withoutDir = applicationBundleIndicator({ status: 'saved', id: 'job-1' });
      assert.strictEqual(withoutDir.tone, 'saved');
      assert.strictEqual(withoutDir.label, 'Application ready');
      assert.strictEqual(
        withoutDir.title,
        'An application bundle (résumé, cover letter, editable HTML) is already saved for this job.',
      );
      assert.ok(!withoutDir.title.includes('Folder:'), 'no savedDir should not append a Folder suffix');

      const withDir = applicationBundleIndicator({
        status: 'saved',
        id: 'job-2',
        savedDir: '/tmp/job-2',
      });
      assert.strictEqual(withDir.tone, 'saved');
      assert.ok(withDir.title.includes('Folder: /tmp/job-2'), 'savedDir is surfaced in the title');

      const emptyDir = applicationBundleIndicator({
        status: 'saved',
        id: 'job-3',
        savedDir: '',
      });
      assert.ok(!emptyDir.title.includes('Folder:'), 'empty savedDir should not append a Folder suffix');
    },
  },
  {
    name: 'missing artifacts produce an attention indicator naming each artifact with and',
    run: async () => {
      const indicator = applicationBundleIndicator({
        status: 'saved',
        id: 'job-1',
        missingArtifacts: ['Résumé PDF', 'Cover Letter PDF'],
      });
      assert.strictEqual(indicator.tone, 'attention');
      assert.strictEqual(indicator.label, 'Bundle saved · PDFs missing');
      assert.strictEqual(
        indicator.title,
        'Application bundle saved, but Résumé PDF and Cover Letter PDF could not be rendered. Use Repair bundle on this card to retry.',
      );
    },
  },
  {
    name: 'a résumé-length warning message produces an attention indicator with the message as title',
    run: async () => {
      const message = 'Your résumé runs long: it spans pages against its target.';
      const indicator = applicationBundleIndicator({
        status: 'saved',
        id: 'job-1',
        message,
      });
      assert.strictEqual(indicator.tone, 'attention');
      assert.strictEqual(indicator.label, 'Bundle saved · length warning');
      assert.strictEqual(indicator.title, message);
    },
  },
  {
    name: 'an empty missingArtifacts array with a normal message still maps to saved',
    run: async () => {
      const indicator = applicationBundleIndicator({
        status: 'saved',
        id: 'job-1',
        missingArtifacts: [],
        message: 'All good.',
      });
      assert.strictEqual(indicator.tone, 'saved');
      assert.strictEqual(indicator.label, 'Application ready');
    },
  },
  {
    name: 'the tone map carries a red cross class for both tones and is frozen',
    run: async () => {
      assert.strictEqual(Object.isFrozen(APPLICATION_BUNDLE_TONES), true, 'tone map must be frozen');
      for (const tone of ['saved', 'attention']) {
        const entry = APPLICATION_BUNDLE_TONES[tone];
        assert.ok(entry, `missing ${tone} tone`);
        assert.strictEqual(typeof entry.cross, 'string', `${tone} cross must be a string`);
        assert.ok(/text-red-/.test(entry.cross), `${tone} cross must be red`);
      }
    },
  },
  {
    name: 'JobCardNode lays a red X over saved cards that fades on hover/focus and never intercepts the pointer',
    run: async () => {
      const source = readNodeSource();

      assert.ok(source.includes("from '../utils/jobCardBundleIndicator'"), 'JobCardNode imports the bundle indicator helper');
      assert.ok(source.includes('applicationBundleIndicator(localApplication)'), 'JobCardNode calls the helper with the card state');
      assert.ok(!source.includes('job-card-bundle-badge') && !source.includes('job-card-bundle-stripe'), 'old badge/stripe are gone');

      const crossAt = source.indexOf('data-testid="job-card-bundle-cross"');
      assert.ok(crossAt !== -1, 'cross overlay present');
      const svgStart = source.lastIndexOf('<svg', crossAt);
      const svgEnd = source.indexOf('</svg>', crossAt);
      const svg = source.slice(svgStart, svgEnd);
      assert.ok(svg.includes('pointer-events-none'), 'overlay must not intercept the pointer');
      assert.ok(svg.includes('group-hover:opacity-0'), 'overlay disappears while the card is hovered');
      assert.ok(svg.includes('group-has-[:focus-visible]:opacity-0'), 'overlay disappears while the card has KEYBOARD focus');
      // A mouse-clicked button (e.g. the salary toggle) keeps plain focus after the pointer leaves; focus-within
      // would keep the X hidden forever (reported 2026-10-07).
      assert.ok(!svg.includes('group-focus-within'), 'overlay must not key off plain focus-within');
      assert.ok(svg.includes('absolute inset-2'), 'overlay covers the card but stays inset from the salary border');
      assert.ok(!svg.includes('border'), 'overlay draws no border of its own');
      assert.strictEqual((svg.match(/<line /g) || []).length, 2, 'two diagonals form the X');

      // The salary border and its title share one colour source.
      assert.ok(source.includes('style={{ borderColor: compensationBorderColor }}'), 'card border still comes from the compensation verdict');
      assert.ok(source.includes('{ color: compensationBorderColor }'), 'salary title uses the exact border colour');

      // The overlay depends on the card root being the positioned `group`.
      const rootAt = source.indexOf('relative rounded-2xl');
      assert.ok(rootAt !== -1 && source.slice(rootAt, rootAt + 160).includes('group'), 'card root is relative and a group');
      assert.ok(rootAt < crossAt, 'overlay renders inside the card root');
    },
  },
];
