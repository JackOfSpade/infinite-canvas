import { jsonSchemaOutputFormat } from '@anthropic-ai/sdk/helpers/json-schema';
import {
  BUNDLE_PRICE_SCHEMA,
  CAREER_FILE_EXTRACT_SCHEMA,
  JOB_COMPENSATION_EVIDENCE_SCHEMA,
  JOB_LOCATION_RESOLUTION_SCHEMA,
  JOB_QUERY_GENERATION_SCHEMA,
  JOB_SCORING_SCHEMA,
  JOB_TAXONOMY_CLASSIFY_SCHEMA,
  JOB_TAXONOMY_PLAN_SCHEMA,
  MARKETPLACE_HUB_SCAN_SCHEMA,
  PRICE_SYNTHESIS_SCHEMA,
  RESUME_PARSE_SCHEMA,
  ROLE_FAMILY_EXPERIENCE_BANDS_SCHEMA,
  VISION_PRODUCT_ANALYSIS_SCHEMA,
  buildPlatformFitSchema,
} from '../../electron/ipc/aiSchemas.js';
import { SELL_PLATFORMS } from '../../src/utils/constants.js';
import {
  assert,
  buildAnthropicMessageParams,
  buildAnthropicTokenCountParams,
  callClaudeText,
  callLLMText,
  callLLMVision,
  callLLMDocument,
} from '../test-dependencies.js';

function optionalFieldCount(schema) {
  if (!schema || typeof schema !== 'object') return 0;
  let count = 0;
  if (schema.type === 'object' && schema.properties) {
    const required = new Set(schema.required || []);
    count += Object.keys(schema.properties).filter((key) => !required.has(key)).length;
    for (const child of Object.values(schema.properties)) count += optionalFieldCount(child);
  }
  if (schema.items) count += optionalFieldCount(schema.items);
  return count;
}

// Anthropic's grammar compiler caps the combined number of schema parameters
// using `anyOf` or a type array at 16. Keep this alongside the optional-field
// ceiling so a future portable schema cannot make every Claude call 400.
function unionFieldCount(schema) {
  if (!schema || typeof schema !== 'object') return 0;
  let count = Array.isArray(schema.type) || Array.isArray(schema.anyOf) ? 1 : 0;
  if (schema.properties) {
    for (const child of Object.values(schema.properties)) count += unionFieldCount(child);
  }
  if (schema.items) count += unionFieldCount(schema.items);
  for (const branch of schema.anyOf || []) count += unionFieldCount(branch);
  for (const branch of schema.oneOf || []) count += unionFieldCount(branch);
  for (const branch of schema.allOf || []) count += unionFieldCount(branch);
  return count;
}

function hasAdditionalPropertiesFalseAtEveryObject(schema) {
  if (!schema || typeof schema !== 'object') return true;
  if (schema.type === 'object' && schema.additionalProperties !== false) return false;
  if (schema.properties && !Object.values(schema.properties).every(hasAdditionalPropertiesFalseAtEveryObject)) return false;
  return !schema.items || hasAdditionalPropertiesFalseAtEveryObject(schema.items);
}

function sse(events) {
  return events.map(({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
}

function messageEvents({ content = [], stopReason = 'end_turn', outputTokens = 5 }) {
  const events = [{
    event: 'message_start',
    data: {
      type: 'message_start',
      message: {
        id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-sonnet-5',
        content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 8, output_tokens: 1 },
      },
    },
  }];
  content.forEach((text, index) => {
    events.push({
      event: 'content_block_start',
      data: { type: 'content_block_start', index, content_block: { type: 'text', text: '' } },
    }, {
      event: 'content_block_delta',
      data: { type: 'content_block_delta', index, delta: { type: 'text_delta', text } },
    }, {
      event: 'content_block_stop',
      data: { type: 'content_block_stop', index },
    });
  });
  events.push({
    event: 'message_delta',
    data: {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: outputTokens },
    },
  }, { event: 'message_stop', data: { type: 'message_stop' } });
  return events;
}

async function withMockClaudeStream(responseFactory, fn) {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null });
    return new Response(sse(responseFactory()), {
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'request-id': 'req_test' },
    });
  };
  try {
    return await fn(requests);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

export default [
  {
    name: 'Claude Structured Outputs: every responseSchema uses JSON Schema output format without a fake tool',
    run: () => {
      const schema = {
        type: 'object',
        required: ['answer'],
        properties: { answer: { type: 'string' }, optionalNote: { type: 'string' } },
      };
      const options = { model: 'claude-sonnet-5', maxTokens: 900, responseSchema: schema, cachedPrefix: 'STATIC' };
      const live = buildAnthropicMessageParams('DYNAMIC', options);
      const format = live.output_config?.format;
      assert(live.thinking?.type === 'adaptive' && live.output_config?.effort === 'medium',
        'modern reasoning effort remains present when Structured Outputs adds an output format');
      assert(format?.type === 'json_schema' && format.schema?.type === 'object'
        && format.schema?.properties?.answer?.type === 'string'
        && format.schema?.additionalProperties === false,
      'responseSchema becomes Anthropic output_config.format with the SDK-transformed schema');
      assert(!live.tools && !live.tool_choice && !JSON.stringify(live).includes('submit_response'),
        'schema-only responses have no fake submit_response tool or forced tool choice');
      assert(schema.additionalProperties === undefined && schema.properties.optionalNote.additionalProperties === undefined,
        'SDK transformation does not mutate the portable source schema shared with Gemini');
      const count = buildAnthropicTokenCountParams('DYNAMIC', options);
      const { max_tokens: _maxTokens, ...liveWithoutOutputCap } = live;
      assert(JSON.stringify(count) === JSON.stringify(liveWithoutOutputCap),
        'token-count request retains the identical output_config.format, effort, cache prefix, and messages');

      const plain = buildAnthropicMessageParams('research', { model: 'claude-sonnet-5', maxTokens: 400 });
      assert(plain.output_config?.effort === 'medium' && !plain.output_config?.format && !plain.tools,
        'grounded/plain prose remains free of a schema or fake tool envelope');
      const haiku = buildAnthropicMessageParams('answer', { model: 'claude-haiku-4-5', maxTokens: 600, responseSchema: schema });
      assert(haiku.thinking?.type === 'enabled' && !haiku.output_config?.effort
        && haiku.output_config?.format?.type === 'json_schema',
      'legacy manual-thinking models still receive Structured Outputs without an unsupported effort field');
      return { outputFormat: format.type };
    },
  },
  {
    name: 'Claude Structured Outputs: all live schemas compile within the supported optional-field budget',
    run: () => {
      const schemas = {
        'vision-product-analysis': VISION_PRODUCT_ANALYSIS_SCHEMA,
        'price-synthesis': PRICE_SYNTHESIS_SCHEMA,
        'bundle-price': BUNDLE_PRICE_SCHEMA,
        'platform-fit-assessment': buildPlatformFitSchema(SELL_PLATFORMS.map(({ id }) => id)),
        'marketplace-hub-scan': MARKETPLACE_HUB_SCAN_SCHEMA,
        'job-location-resolution': JOB_LOCATION_RESOLUTION_SCHEMA,
        'role-family-experience-bands': ROLE_FAMILY_EXPERIENCE_BANDS_SCHEMA,
        'job-compensation-evidence': JOB_COMPENSATION_EVIDENCE_SCHEMA,
        'career-file-extract': CAREER_FILE_EXTRACT_SCHEMA,
        'resume-parse': RESUME_PARSE_SCHEMA,
        'job-query-generation': JOB_QUERY_GENERATION_SCHEMA,
        'job-scoring': JOB_SCORING_SCHEMA,
        'job-taxonomy-plan': JOB_TAXONOMY_PLAN_SCHEMA,
        'job-taxonomy-classify': JOB_TAXONOMY_CLASSIFY_SCHEMA,
      };
      const optionalCounts = {};
      const unionCounts = {};
      for (const [task, schema] of Object.entries(schemas)) {
        const format = jsonSchemaOutputFormat(schema);
        optionalCounts[task] = optionalFieldCount(schema);
        unionCounts[task] = unionFieldCount(schema);
        assert(format.type === 'json_schema' && format.schema?.type === 'object', `${task} compiles to an Anthropic JSON-schema output format`);
        assert(optionalCounts[task] <= 24, `${task} has ${optionalCounts[task]} optional fields (Anthropic limit is 24)`);
        assert(unionCounts[task] <= 16, `${task} has ${unionCounts[task]} union-typed fields (Anthropic limit is 16)`);
        assert(hasAdditionalPropertiesFalseAtEveryObject(format.schema), `${task} is closed recursively after SDK transformation`);
      }
      const scoring = buildAnthropicMessageParams('score', {
        model: 'claude-sonnet-5', maxTokens: 16000, responseSchema: JOB_SCORING_SCHEMA,
      });
      assert(scoring.output_config.format.schema.properties.scores.items.properties.requirementAssessments.items.additionalProperties === false
        && !scoring.tools,
      'the deeply nested job-scoring schema remains viable as a JSON-schema output request without tool grammar');
      return {
        schemas: Object.keys(schemas).length,
        maxOptionalFields: Math.max(...Object.values(optionalCounts)),
        maxUnionFields: Math.max(...Object.values(unionCounts)),
      };
    },
  },
  {
    name: 'Claude Structured Outputs: live text extraction and terminal stop reasons remain safe',
    run: async () => {
      const schema = { type: 'object', required: ['answer'], properties: { answer: { type: 'string' } } };
      await withMockClaudeStream(() => messageEvents({ content: ['{"answer":"ok"}'] }), async (requests) => {
        const text = await callClaudeText('Return an answer.', 'claude-sonnet-5', 'test-key', null, {
          maxTokens: 256, responseSchema: schema,
        });
        assert(text === '{"answer":"ok"}', 'structured response returns the text JSON payload, not a tool-use input');
        assert(requests.length === 1 && requests[0].body.output_config?.format?.type === 'json_schema'
          && !requests[0].body.tools && !requests[0].body.tool_choice,
        'the actual SDK request sends output_config.format and no fake tool envelope');
      });
      await withMockClaudeStream(() => messageEvents({ content: ['{"answer":123}'] }), async () => {
        let caught = null;
        try {
          await callClaudeText('Return an answer.', 'claude-sonnet-5', 'test-key', null, {
            maxTokens: 256, responseSchema: schema,
          });
        } catch (error) {
          caught = error;
        }
        assert(caught?.code === 'STRUCTURED_OUTPUT_SCHEMA_INVALID' && /\$\.answer/.test(caught.message),
          'a completed JSON payload that violates the original schema is rejected on the live Claude path');
      });
      const conditionSchema = {
        type: 'object', required: ['condition'], additionalProperties: false,
        properties: { condition: { type: 'string', enum: ['New', 'Like New'] } },
      };
      await withMockClaudeStream(() => messageEvents({ content: ['{"condition":"like new"}'] }), async () => {
        const text = await callClaudeText('Classify the item.', 'claude-sonnet-5', 'test-key', null, {
          maxTokens: 256, responseSchema: conditionSchema,
        });
        assert(text === '{"condition":"Like New"}',
          'Claude’s documented enum-casing exception is canonicalized before the normal JSON consumer sees it');
      });
      await withMockClaudeStream(() => messageEvents({ content: ['{"answer":"ok"}', '{"answer":"duplicate"}'] }), async () => {
        let caught = null;
        try {
          await callClaudeText('Return one answer.', 'claude-sonnet-5', 'test-key', null, {
            maxTokens: 256, responseSchema: schema,
          });
        } catch (error) { caught = error; }
        assert(caught?.code === 'STRUCTURED_OUTPUT_INVALID_JSON',
          'multiple completed structured text blocks cannot be silently merged into an invalid or ambiguous JSON result');
      });
      await withMockClaudeStream(() => messageEvents({ content: ['first', 'second'] }), async () => {
        const text = await callClaudeText('Give prose.', 'claude-sonnet-5', 'test-key', null, { maxTokens: 256 });
        assert(text === 'first\nsecond', 'ordinary text responses still concatenate every text block');
      });
      for (const [stopReason, expected] of [
        ['refusal', /refus/i],
        ['max_tokens', /truncated/i],
        ['model_context_window_exceeded', /context window/i],
        ['pause_turn', /paused/i],
      ]) {
        await withMockClaudeStream(() => messageEvents({ stopReason }), async () => {
          let caught = null;
          try {
            await callClaudeText('Return an answer.', 'claude-sonnet-5', 'test-key', null, { maxTokens: 256, responseSchema: schema });
          } catch (error) {
            caught = error;
          }
          assert(caught && expected.test(caught.message), `${stopReason} is surfaced as a terminal error, never parsed as schema output`);
          if (stopReason === 'max_tokens') assert(caught.code === 'MAX_TOKENS', 'max_tokens retains the retry classification code');
        });
      }
      let conflict = null;
      try {
        await callClaudeText('Research and return JSON.', 'claude-sonnet-5', 'test-key', null, {
          maxTokens: 256, responseSchema: schema, grounding: true,
        });
      } catch (error) {
        conflict = error;
      }
      assert(conflict?.code === 'CLAUDE_GROUNDING_STRUCTURED_OUTPUT_CONFLICT',
        'a direct caller cannot silently lose requested grounding when it also asks for structured output');
      return { stops: 4 };
    },
  },
  {
    name: 'Claude Structured Outputs: structured public LLM entry points reject missing schemas before a provider call',
    run: async () => {
      for (const invoke of [
        () => callLLMText('structured result'),
        () => callLLMVision([], 'structured result'),
        () => callLLMDocument('/tmp/fixture.pdf', 'structured result'),
      ]) {
        let caught = null;
        try { await invoke(); } catch (error) { caught = error; }
        assert(/requires a responseSchema/.test(caught?.message || ''),
          'structured public LLM calls cannot silently fall back to reparsed prose');
      }
      return { guardedEntrypoints: 3 };
    },
  },
];
