import { assert, assertAnthropicStructuredOutputLimits, assertResponseMatchesSchema, assertResponseSchemaVocabularySupported, auditResponseSchemaVocabulary, buildAnthropicMessageParams, canonicalizeResponseSchemaEnums, validateResponseSchema } from '../test-dependencies.js';
import * as responseSchemas from '../../electron/ipc/aiSchemas.js';

export default [
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

      let builderError = null;
      try { buildAnthropicMessageParams('fixture', { model: 'claude-sonnet-4-6', maxTokens: 100, responseSchema: schema }); }
      catch (error) { builderError = error; }
      assert(builderError?.code === 'STRUCTURED_OUTPUT_SCHEMA_UNSUPPORTED_KEYWORD'
        && builderError.message.includes('$.minProperties'),
      'the Claude request builder rejects an unsupported response contract before it can reach a token-count or billed API request');

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
    name: 'Claude structured-output validation: Anthropic explicit grammar limits reject generated schemas before a request',
    run: () => {
      const optionalOverLimit = {
        type: 'object', properties: Object.fromEntries(Array.from({ length: 25 }, (_, index) => [`f${index}`, { type: 'string' }])),
      };
      const unionOverLimit = {
        type: 'object', required: ['fields'], properties: {
          fields: {
            type: 'array', items: {
              type: 'object', required: Array.from({ length: 17 }, (_, index) => `f${index}`),
              properties: Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`f${index}`, { type: ['string', 'null'] }])),
            },
          },
        },
      };
      const oneOfOverLimit = {
        type: 'object', required: ['fields'], properties: {
          fields: {
            type: 'array', items: {
              type: 'object', required: Array.from({ length: 17 }, (_, index) => `f${index}`),
              properties: Object.fromEntries(Array.from({ length: 17 }, (_, index) => [
                `f${index}`, { oneOf: [{ type: 'string' }, { type: 'null' }] },
              ])),
            },
          },
        },
      };
      let optionalError = null;
      let unionError = null;
      let oneOfError = null;
      try { assertAnthropicStructuredOutputLimits(optionalOverLimit, { task: 'limit-test' }); } catch (error) { optionalError = error; }
      try { assertAnthropicStructuredOutputLimits(unionOverLimit); } catch (error) { unionError = error; }
      try { assertAnthropicStructuredOutputLimits(oneOfOverLimit); } catch (error) { oneOfError = error; }
      assert(optionalError?.code === 'STRUCTURED_OUTPUT_SCHEMA_TOO_COMPLEX' && /25 optional/.test(optionalError.message),
        'the 25th optional parameter fails locally instead of returning an Anthropic compilation 400');
      assert(unionError?.code === 'STRUCTURED_OUTPUT_SCHEMA_TOO_COMPLEX' && /17 union/.test(unionError.message),
        'the 17th union parameter fails locally instead of returning an Anthropic compilation 400');
      assert(oneOfError?.code === 'STRUCTURED_OUTPUT_SCHEMA_TOO_COMPLEX' && /17 union/.test(oneOfError.message),
        'oneOf-bearing parameters are counted because the SDK sends them as anyOf unions');
      let builderError = null;
      try { buildAnthropicMessageParams('fixture', { model: 'claude-sonnet-5', maxTokens: 100, responseSchema: optionalOverLimit }); }
      catch (error) { builderError = error; }
      assert(builderError?.code === 'STRUCTURED_OUTPUT_SCHEMA_TOO_COMPLEX',
        'the request builder applies Anthropic complexity preflight to billed and token-count shapes alike');
      return { optionalLimit: 24, unionLimit: 16 };
    },
  },
];
