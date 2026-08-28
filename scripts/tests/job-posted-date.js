import { assert } from '../test-dependencies.js';
import { formatPostedForDisplay } from '../../src/utils/jobPostedDate.js';

const NOW = new Date('2026-08-28T12:00:00Z');

export default [
  {
    name: 'Posted display reformats ISO timestamps the API sources store',
    run: () => {
      // Dice (postedDate), USAJobs (PublicationStartDate) and WeWorkRemotely all
      // store full ISO; the card used to render it raw next to neighbours
      // reading "3 days ago".
      assert(formatPostedForDisplay('2026-08-28T09:00:00Z', NOW) === 'Today', 'same day reads Today');
      assert(formatPostedForDisplay('2026-08-27T17:11:55+00:00', NOW) === 'Yesterday', 'offset form parses, reads Yesterday');
      assert(formatPostedForDisplay('2026-08-25T09:00:00.000Z', NOW) === '3 days ago', 'within a week stays relative');
      assert(formatPostedForDisplay('2026-08-01T09:00:00Z', NOW) === 'Aug 1', 'beyond a week uses an absolute date');
      assert(formatPostedForDisplay('2025-12-02T09:00:00Z', NOW) === 'Dec 2, 2025', 'a prior year keeps the year');
      return { ok: true };
    },
  },
  {
    name: 'Posted display leaves every non-ISO value byte-identical',
    run: () => {
      // The browser sources scrape strings that already read well, and the same
      // stored value feeds parsePostedDate for the age filter — presentation may
      // never rewrite it into a shape the parser handles differently.
      for (const passthrough of [
        '3 days ago', 'Posted today', '30d+', 'Just posted', '24h',
        '8/27/2026', '2026-08-27', 'Active 5 days ago', '', 'Invalid Date',
      ]) {
        assert(formatPostedForDisplay(passthrough, NOW) === passthrough, `"${passthrough}" must pass through unchanged`);
      }
      return { ok: true };
    },
  },
  {
    name: 'Posted display never throws on malformed input',
    run: () => {
      for (const bad of [null, undefined, 0, {}, [], NaN, true]) {
        const out = formatPostedForDisplay(bad, NOW);
        assert(typeof out === 'string', `non-string input yields a string, got ${typeof out}`);
      }
      // A syntactically ISO-shaped but impossible date must not render "Invalid Date".
      const impossible = formatPostedForDisplay('2026-13-45T99:99:99Z', NOW);
      assert(!/Invalid/.test(impossible), `an impossible ISO date must not render "Invalid Date", got "${impossible}"`);
      return { ok: true };
    },
  },
];
