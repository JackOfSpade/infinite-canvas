import { assert, assertResponseMatchesSchema, assertResponseSchemaVocabularySupported, auditResponseSchemaVocabulary, canonicalizeResponseSchemaEnums, validateResponseSchema } from '../test-dependencies.js';
import * as responseSchemas from '../../electron/ipc/aiSchemas.js';

export default [
  {
    name: 'RESUME_PARSE_SCHEMA: work-history dates preserve exact source spelling instead of requesting normalization',
    run: () => {
      const fields = responseSchemas.RESUME_PARSE_SCHEMA.properties.workHistory.items.properties;
      assert(fields.startDate.description.includes('copied exactly as stated in the source')
        && fields.endDate.description.includes('copied exactly as stated in the source')
        && !fields.startDate.description.includes('preferably YYYY-MM')
        && !fields.endDate.description.includes('preferably YYYY-MM')
        && !fields.endDate.description.includes('use "present"'),
      'resume parsing must retain authoritative month, punctuation, and year spelling rather than asking the model to normalize it');
      return { startDate: fields.startDate.description, endDate: fields.endDate.description };
    },
  },
  {
    name: 'Claude structured-output validation: original response schema constraints remain enforced locally',
    run: () => {
      const schema = {
        type: 'object',
        required: ['score', 'labels', 'title'],
        additionalProperties: false,
        properties: {
          score: { type: 'integer', minimum: 1, maximum: 100 },
          labels: { type: 'array', minItems: 1, maxItems: 2, items: { type: 'string', minLength: 2 } },
          title: { type: 'string', minLength: 1, maxLength: 5 },
        },
      };
      const valid = { score: 95, labels: ['ok'], title: 'good' };
      assert(validateResponseSchema(valid, schema).length === 0,
        'a fully conforming structured response is accepted');

      const errors = validateResponseSchema({ score: 101, labels: [], title: '', leaked: true }, schema);
      const detail = errors.map(({ path, message }) => `${path} ${message}`).join(' | ');
      assert(detail.includes('$.score must be less than or equal to 100')
        && detail.includes('$.labels must contain at least 1 item')
        && detail.includes('$.title must contain at least 1 character')
        && detail.includes('$.leaked is not an allowed property'),
      'numeric, array, string, and explicit additional-property constraints remain enforced after provider schema conversion');

      let thrown = null;
      try { assertResponseMatchesSchema({ score: 0, labels: ['x'], title: '' }, schema, { provider: 'Claude', task: 'schema-test' }); }
      catch (error) { thrown = error; }
      assert(thrown?.code === 'STRUCTURED_OUTPUT_SCHEMA_INVALID'
        && thrown.message.includes("task 'schema-test'")
        && thrown.message.includes('$.score'),
      'invalid output raises a retryable, field-specific structured-output error rather than allowing a partial result through');
      return { errorCount: errors.length };
    },
  },
  {
    name: 'Claude structured-output validation: schema unions and JSON primitive types are handled',
    run: () => {
      const schema = {
        allOf: [{ type: 'object', required: ['state'], properties: { state: { type: 'string' } } }],
        properties: {
          state: { oneOf: [{ const: 'ready' }, { const: 'pending' }] },
          value: { anyOf: [{ type: 'boolean' }, { type: 'number' }] },
        },
      };
      assert(validateResponseSchema({ state: 'ready', value: false }, schema).length === 0,
        'const, allOf, oneOf, and anyOf accept a valid branch');
      const errors = validateResponseSchema({ state: 'unknown', value: 'no' }, schema);
      assert(errors.some((error) => error.path === '$.state' && error.message.includes('exactly one'))
        && errors.some((error) => error.path === '$.value' && error.message.includes('at least one')),
      'union mismatch errors retain the failing JSON paths');
      return { errorCount: errors.length };
    },
  },
  {
    name: 'Claude structured-output validation: unsupported schema keywords fail as configuration errors',
    run: () => {
      const schema = { type: 'object', minProperties: 1 };
      const audit = auditResponseSchemaVocabulary(schema);
      assert(audit.length === 1 && audit[0].path === '$.minProperties' && audit[0].message.includes('unsupported validation keyword'),
        'the vocabulary audit names an unimplemented validation keyword and its schema path');
      let thrown = null;
      try { assertResponseSchemaVocabularySupported(schema, { task: 'schema-test' }); }
      catch (error) { thrown = error; }
      assert(thrown?.code === 'STRUCTURED_OUTPUT_SCHEMA_UNSUPPORTED_KEYWORD'
        && thrown.message.includes('schema configuration error')
        && thrown.message.includes('$.minProperties'),
      'an unsupported constraint cannot silently appear enforced at runtime');

      let matcherError = null;
      try { assertResponseMatchesSchema({}, schema, { provider: 'Claude', task: 'schema-test' }); }
      catch (error) { matcherError = error; }
      assert(matcherError?.code === 'STRUCTURED_OUTPUT_SCHEMA_UNSUPPORTED_KEYWORD',
        'post-response validation reuses the same vocabulary assertion if called independently');

      const liveSchemas = Object.entries(responseSchemas)
        .filter(([name, value]) => name.endsWith('_SCHEMA') && value && typeof value === 'object')
        .map(([name, value]) => ({ name, problems: auditResponseSchemaVocabulary(value) }));
      liveSchemas.push({
        name: 'buildPlatformFitSchema',
        problems: auditResponseSchemaVocabulary(responseSchemas.buildPlatformFitSchema(['fixture-platform'])),
      });
      const invalid = liveSchemas.filter(({ problems }) => problems.length > 0);
      assert(invalid.length === 0,
        `every exported live response schema uses the locally enforced vocabulary: ${invalid.map(({ name, problems }) => `${name}: ${problems[0].path}`).join(', ')}`);
      return { checkedSchemas: liveSchemas.length };
    },
  },
  {
    name: 'Claude structured-output validation: documented enum casing drift is canonicalized without weakening validation',
    run: () => {
      const schema = {
        type: 'object', required: ['condition', 'nested'], additionalProperties: false,
        properties: {
          condition: { type: 'string', enum: ['New', 'Like New', 'Used - Good'] },
          nested: {
            type: 'array', items: {
              type: 'object', required: ['status'], additionalProperties: false,
              properties: { status: { const: 'not_documented' } },
            },
          },
        },
      };
      const normalized = canonicalizeResponseSchemaEnums({
        condition: 'like new', nested: [{ status: 'NOT_DOCUMENTED' }],
      }, schema);
      assert(normalized.condition === 'Like New' && normalized.nested[0].status === 'not_documented'
        && validateResponseSchema(normalized, schema).length === 0,
      'unique case-insensitive enum/const matches are restored to schema spelling before consumers see them');

      const ambiguous = canonicalizeResponseSchemaEnums('new', { enum: ['New', 'NEW'] });
      assert(ambiguous === 'new' && validateResponseSchema(ambiguous, { enum: ['New', 'NEW'] }).length === 1,
        'case-only ambiguous schema values are not guessed or silently accepted');
      const union = canonicalizeResponseSchemaEnums('ready', { anyOf: [{ const: 'Ready' }, { const: 'Pending' }] });
      assert(union === 'Ready' && validateResponseSchema(union, { anyOf: [{ const: 'Ready' }, { const: 'Pending' }] }).length === 0,
        'enum canonicalization also selects a uniquely valid union branch');
      return { condition: normalized.condition };
    },
  },
  {
    // Every query here is broadcast to up to 9 job boards, so an uncapped
    // array response would fan a malformed response out arbitrarily wide —
    // see the maxItems rationale on JOB_QUERY_GENERATION_SCHEMA itself. This
    // test proves both the STATIC declaration (a per-key assert, not one
    // blanket check spanning all four — a regression that recaps only one
    // array must still fail) and the BEHAVIORAL enforcement (a 21-item
    // response on each key independently trips validateResponseSchema),
    // since a maxItems property that is declared but never actually
    // enforced by the validator would be a silent no-op.
    name: 'JOB_QUERY_GENERATION_SCHEMA: all four query arrays cap at maxItems 20 as a malformed-response tripwire, and validateResponseSchema actually enforces it',
    run: () => {
      const schema = responseSchemas.JOB_QUERY_GENERATION_SCHEMA;
      const arrayKeys = ['titleQueries', 'suggestedRoleQueries', 'skillsOnlyQueries', 'targetRoleQueries'];
      for (const key of arrayKeys) {
        assert(schema.properties[key]?.type === 'array' && schema.properties[key]?.maxItems === 20,
          `JOB_QUERY_GENERATION_SCHEMA.${key} must declare { type: 'array', maxItems: 20 }`);
      }
      const validLocation = { city: '', stateCode: '', region: '', country: '', isRemote: false, display: '' };
      const baseValid = {
        titleQueries: [], suggestedRoleQueries: [], skillsOnlyQueries: [], targetRoleQueries: [],
        canonicalLocation: validLocation,
      };
      assert(validateResponseSchema(baseValid, schema).length === 0,
        'four empty query arrays plus a resolved location remain valid against the live schema');
      for (const key of arrayKeys) {
        const twentyItems = { ...baseValid, [key]: Array.from({ length: 20 }, (_, i) => `query ${i}`) };
        assert(validateResponseSchema(twentyItems, schema).length === 0,
          `${key} at exactly the cap (20 items) must still validate — the cap is a tripwire, not a stricter target`);
        const twentyOneItems = { ...baseValid, [key]: Array.from({ length: 21 }, (_, i) => `query ${i}`) };
        const errors = validateResponseSchema(twentyOneItems, schema);
        assert(errors.some((e) => e.path === `$.${key}` && e.message === 'must contain at most 20 items'),
          `${key} exceeding 20 items must fail validation as a malformed-response tripwire, and only ${key}`);
      }
      return { arrayKeys };
    },
  },
];
