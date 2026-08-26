import { assert, buildExactTargetRoleQueryBundle, flattenJobSearchQueries } from '../test-dependencies.js';

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
];
