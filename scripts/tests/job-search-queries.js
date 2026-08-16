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
    name: 'Job query bundles preserve empty-role generation and normalize already-seen duplicates only',
    run: () => {
      const queries = flattenJobSearchQueries({
        targetRoleQueries: [],
        titleQueries: ['  Software Engineer  ', 'software engineer'],
        suggestedRoleQueries: ['Platform Engineer'],
        skillsOnlyQueries: ['Kubernetes Go'],
      });

      assert(JSON.stringify(queries) === JSON.stringify([
        'Software Engineer',
        'Platform Engineer',
        'Kubernetes Go',
      ]), 'empty-role bundles retain every non-empty query group while collapsing only the previously seen literal query');
      return { queries };
    },
  },
];
