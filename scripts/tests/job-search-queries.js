import { assert, buildExactTargetRoleQueryBundle, buildPinnedTitleQueryBundle, flattenJobSearchQueries } from '../test-dependencies.js';

export default [
  {
    name: 'A set target role constructs exactly one literal scrape query with no generated variations',
    run: () => {
      const bundle = buildExactTargetRoleQueryBundle('  Product Manager  ');
      const queries = flattenJobSearchQueries(bundle);

      assert(JSON.stringify(queries) === JSON.stringify(['Product Manager']),
        'target-role search must use the trimmed literal role exactly once');
      assert(bundle.titleQueries.length === 0
        && bundle.suggestedRoleQueries.length === 0
        && bundle.skillsOnlyQueries.length === 0,
      'target-role search must not contain title, suggested-role, or skills variations');
      return { queries };
    },
  },
  {
    name: 'Job query bundles normalize text duplicates and discard malformed query values',
    run: () => {
      const queries = flattenJobSearchQueries({
        targetRoleQueries: [],
        titleQueries: ['  Software\u00a0\u00a0Engineer  ', 'software engineer', { query: 'invalid' }, 12],
        suggestedRoleQueries: ['Platform\nEngineer'],
        skillsOnlyQueries: ['Kubernetes Go', null],
      });

      assert(JSON.stringify(queries) === JSON.stringify([
        'Software Engineer',
        'Platform Engineer',
        'Kubernetes Go',
      ]), 'empty-role bundles retain valid groups, collapse whitespace-equivalent duplicates, and never stringify malformed values');

      const exactRole = buildExactTargetRoleQueryBundle('  Product\n Manager  ');
      assert(JSON.stringify(flattenJobSearchQueries(exactRole)) === JSON.stringify(['Product Manager']),
        'target roles use the same boundary normalization as generated queries');
      return { queries };
    },
  },
  {
    // Unicode canonical-form dedup (NFD vs NFC). Career data is frequently
    // PDF/OCR-derived, and PDF text extraction routinely yields NFD
    // (decomposed) accented characters that render pixel-identical to NFC
    // but compare unequal byte-for-byte — see normalizeJobSearchQuery's
    // docstring in src/utils/jobSearchQueries.js. Build the NFD form
    // explicitly (base letter + combining acute accent, U+0301) rather than
    // typing an accented literal, so this test does not silently depend on
    // the source file's own on-disk normalization.
    name: 'flattenJobSearchQueries merges NFD/NFC Unicode canonical-form duplicates, the same as whitespace/case duplicates',
    run: () => {
      const nfcCafe = 'Café Manager';       // precomposed "é" (U+00E9)
      const nfdCafe = 'Café Manager';       // "e" + combining acute (U+0065 U+0301)
      assert(nfcCafe !== nfdCafe, 'fixture sanity: the two byte sequences must actually differ before normalization');
      assert(nfcCafe.normalize('NFC') === nfcCafe && nfdCafe.normalize('NFC') === nfcCafe,
        'fixture sanity: both fixtures compose to the same NFC string');

      const queries = flattenJobSearchQueries({
        targetRoleQueries: [],
        titleQueries: [nfcCafe, nfdCafe],
        suggestedRoleQueries: [],
        skillsOnlyQueries: [],
      });
      assert(JSON.stringify(queries) === JSON.stringify([nfcCafe]),
        'an NFD-encoded query must merge with its NFC-encoded twin instead of scraping the same visual query twice');
      return { queries };
    },
  },
  {
    // The inverse of the merge tests: near-duplicates that LOOK related but
    // carry distinct search meaning must survive as separate queries. Merging
    // any of these risks silently dropping search coverage, which the sibling
    // "caps-dedup" work deliberately chose not to risk — see the dedup-key
    // audit comment above normalizeJobSearchQuery in src/utils/jobSearchQueries.js.
    name: 'flattenJobSearchQueries keeps wording, seniority qualifiers, punctuation, and word order distinct — dedup never stems or drops meaning',
    run: () => {
      const queries = flattenJobSearchQueries({
        targetRoleQueries: [],
        titleQueries: [
          // wording/synonyms: different job titles, not the same title twice
          'Product Engineer', 'Product Manager, Engineering',
          // seniority/qualifier tokens: boards treat these as different searches
          'Software Engineer', 'Senior Software Engineer', 'Software Engineer II',
          // punctuation: a board may treat a hyphen or period as meaningful
          'Sr. Data Analyst', 'Sr Data Analyst', 'Front-End Developer', 'Front End Developer',
        ],
        suggestedRoleQueries: [
          // word order / pluralization: no stemming, ever
          'Engineer Product', 'Data Analysts',
        ],
        skillsOnlyQueries: [],
      });
      const distinct = [
        'Product Engineer', 'Product Manager, Engineering',
        'Software Engineer', 'Senior Software Engineer', 'Software Engineer II',
        'Sr. Data Analyst', 'Sr Data Analyst', 'Front-End Developer', 'Front End Developer',
        'Engineer Product', 'Data Analysts',
      ];
      assert(queries.length === distinct.length && distinct.every((q) => queries.includes(q)),
        `every wording/seniority/punctuation/word-order variant must survive as its own query, got: ${JSON.stringify(queries)}`);
      return { queries };
    },
  },
  {
    // buildPinnedTitleQueryBundle (the Search-Brief-resolved-titles path) runs
    // its OWN dedup loop, separate from flattenJobSearchQueries' — both must
    // agree on what counts as "the same query" since they share
    // normalizeJobSearchQuery, but this proves the bundle's own loop actually
    // applies it rather than assuming flattenJobSearchQueries will clean up
    // after it downstream.
    name: 'buildPinnedTitleQueryBundle merges the resolved-role near-duplicates (whitespace/case/Unicode form) but keeps seniority-distinct titles separate',
    run: () => {
      const bundle = buildPinnedTitleQueryBundle([
        'Backend Engineer',
        'backend  engineer',              // case + internal double-space duplicate
        'Senior Backend Engineer',         // seniority-distinct: must survive
        'Café Concierge',             // NFC
        'Café Concierge',            // NFD twin of the line above
      ]);
      assert(bundle.titleQueries.length === 0 && bundle.suggestedRoleQueries.length === 0 && bundle.skillsOnlyQueries.length === 0,
        'a pinned-title bundle only ever populates targetRoleQueries, the same "one query per role" shape as buildExactTargetRoleQueryBundle');
      assert(JSON.stringify(bundle.targetRoleQueries) === JSON.stringify([
        'Backend Engineer', 'Senior Backend Engineer', 'Café Concierge',
      ]), `pinned titles must merge case/whitespace/Unicode-form duplicates while keeping the seniority-qualified title distinct, got: ${JSON.stringify(bundle.targetRoleQueries)}`);
      return { bundle };
    },
  },
];
