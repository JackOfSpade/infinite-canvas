/**
 * Small, dependency-free JSON Schema validator for model responses.
 *
 * Anthropic Structured Outputs compiles a supported subset of JSON Schema into
 * a grammar. Its SDK turns unsupported constraints (such as numeric bounds and
 * array/string lengths) into prose descriptions before sending the request.
 * Validate the provider response against the caller's *original* schema here
 * so those constraints remain part of the application contract.
 *
 * This intentionally implements the JSON Schema vocabulary used by
 * aiSchemas.js. The vocabulary audit below fails loud if a response contract
 * gains a validation keyword outside this subset; add a real declared validator
 * dependency rather than silently treating that new constraint as enforced.
 */

const VALIDATION_KEYWORDS = new Set([
  'type', 'enum', 'const',
  'minLength', 'maxLength', 'pattern',
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum',
  'minItems', 'maxItems', 'items',
  'required', 'properties', 'additionalProperties',
  'allOf', 'anyOf', 'oneOf',
]);

// These convey documentation or identity only. They are deliberately accepted
// without changing validation semantics; `format`, for example, is NOT on this
// list because callers must not assume it is enforced locally.
const ANNOTATION_KEYWORDS = new Set([
  '$schema', '$id', '$comment', 'title', 'description', 'default', 'examples',
  'deprecated', 'readOnly', 'writeOnly', 'contentEncoding', 'contentMediaType',
]);

const JSON_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);
const ANTHROPIC_MAX_OPTIONAL_PARAMETERS = 24;
const ANTHROPIC_MAX_UNION_PARAMETERS = 16;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function joinPath(parent, segment) {
  if (typeof segment === 'number') return `${parent}[${segment}]`;
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(segment)
    ? `${parent}.${segment}`
    : `${parent}[${JSON.stringify(segment)}]`;
}

function sameJsonValue(left, right) {
  if (left === right) return true;
  if (Number.isNaN(left) || Number.isNaN(right)) return false;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  if (Array.isArray(left)) {
    return left.length === right.length && left.every((item, index) => sameJsonValue(item, right[index]));
  }
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key) => Object.prototype.hasOwnProperty.call(right, key) && sameJsonValue(left[key], right[key]));
}

function matchesType(value, type) {
  switch (type) {
    case 'object': return isObject(value);
    case 'array': return Array.isArray(value);
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'null': return value === null;
    default: return false;
  }
}

function auditSchemaNode(schema, path, problems) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    problems.push({ path, message: 'must be a JSON Schema object' });
    return;
  }
  for (const key of Object.keys(schema)) {
    if (!VALIDATION_KEYWORDS.has(key) && !ANNOTATION_KEYWORDS.has(key)) {
      problems.push({ path: joinPath(path, key), message: `uses unsupported validation keyword ${JSON.stringify(key)}` });
    }
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (types.length === 0 || types.some((type) => !JSON_TYPES.has(type))) {
      problems.push({ path: joinPath(path, 'type'), message: 'must name one or more supported JSON types' });
    }
  }
  if (schema.pattern !== undefined) {
    if (typeof schema.pattern !== 'string') {
      problems.push({ path: joinPath(path, 'pattern'), message: 'must be a string regular expression' });
    } else {
      try { new RegExp(schema.pattern); }
      catch { problems.push({ path: joinPath(path, 'pattern'), message: 'must be a valid regular expression' }); }
    }
  }
  if (schema.items !== undefined) {
    auditSchemaNode(schema.items, joinPath(path, 'items'), problems);
  }
  if (schema.additionalProperties !== undefined && schema.additionalProperties !== true && schema.additionalProperties !== false) {
    auditSchemaNode(schema.additionalProperties, joinPath(path, 'additionalProperties'), problems);
  }
  for (const [key, child] of Object.entries(schema.properties || {})) {
    auditSchemaNode(child, joinPath(joinPath(path, 'properties'), key), problems);
  }
  for (const keyword of ['allOf', 'anyOf', 'oneOf']) {
    if (schema[keyword] === undefined) continue;
    if (!Array.isArray(schema[keyword])) {
      problems.push({ path: joinPath(path, keyword), message: 'must be an array of JSON Schema objects' });
      continue;
    }
    schema[keyword].forEach((child, index) => auditSchemaNode(child, joinPath(joinPath(path, keyword), index), problems));
  }
}

function anthropicSchemaComplexity(schema) {
  let optionalParameters = 0;
  let unionParameters = 0;
  const visit = (node) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return;
    // The SDK normalizes oneOf into anyOf before sending, so both consume the
    // same Anthropic union-parameter budget at grammar-compilation time.
    if (Array.isArray(node.type) || Array.isArray(node.anyOf) || Array.isArray(node.oneOf)) unionParameters += 1;
    if (node.properties && typeof node.properties === 'object' && !Array.isArray(node.properties)) {
      const required = new Set(Array.isArray(node.required) ? node.required : []);
      for (const [key, child] of Object.entries(node.properties)) {
        if (!required.has(key)) optionalParameters += 1;
        visit(child);
      }
    }
    visit(node.items);
    if (node.additionalProperties && typeof node.additionalProperties === 'object') visit(node.additionalProperties);
    for (const keyword of ['allOf', 'anyOf', 'oneOf']) {
      for (const child of Array.isArray(node[keyword]) ? node[keyword] : []) visit(child);
    }
  };
  visit(schema);
  return { optionalParameters, unionParameters };
}

/**
 * Anthropic's compiled grammar has request-wide limits that are easy to exceed
 * accidentally with generated schemas. We only send one response schema per
 * app request today, so the schema's own totals are the request totals.
 */
export function assertAnthropicStructuredOutputLimits(schema, { task = null } = {}) {
  const { optionalParameters, unionParameters } = anthropicSchemaComplexity(schema);
  const taskLabel = task ? ` for task '${task}'` : '';
  if (optionalParameters > ANTHROPIC_MAX_OPTIONAL_PARAMETERS) {
    const error = new Error(`Structured-output schema configuration error${taskLabel}: ${optionalParameters} optional parameters exceeds Anthropic's ${ANTHROPIC_MAX_OPTIONAL_PARAMETERS}-parameter limit.`);
    error.code = 'STRUCTURED_OUTPUT_SCHEMA_TOO_COMPLEX';
    throw error;
  }
  if (unionParameters > ANTHROPIC_MAX_UNION_PARAMETERS) {
    const error = new Error(`Structured-output schema configuration error${taskLabel}: ${unionParameters} union parameters exceeds Anthropic's ${ANTHROPIC_MAX_UNION_PARAMETERS}-parameter limit.`);
    error.code = 'STRUCTURED_OUTPUT_SCHEMA_TOO_COMPLEX';
    throw error;
  }
}

/**
 * Return configuration problems for response-schema features this small local
 * validator cannot enforce. Kept separate for a deterministic repository-wide
 * schema vocabulary test.
 */
export function auditResponseSchemaVocabulary(schema) {
  const problems = [];
  auditSchemaNode(schema, '$', problems);
  return problems;
}

/**
 * Fail before a provider request is built when this local validator cannot
 * enforce part of the original response contract. This protects both billed
 * Messages calls and the otherwise-free token-count preflight from accepting a
 * schema whose constraints would be only partially enforced.
 */
export function assertResponseSchemaVocabularySupported(schema, { task = null } = {}) {
  const unsupported = auditResponseSchemaVocabulary(schema);
  if (unsupported.length === 0) return;
  const shown = unsupported.slice(0, 5).map(({ path, message }) => `${path} ${message}`).join('; ');
  const remainder = unsupported.length > 5 ? ` (${unsupported.length - 5} more)` : '';
  const taskLabel = task ? ` for task '${task}'` : '';
  const error = new Error(`Structured-output schema configuration error${taskLabel}: ${shown}${remainder}. Add support for this keyword before using it.`);
  error.code = 'STRUCTURED_OUTPUT_SCHEMA_UNSUPPORTED_KEYWORD';
  error.schemaErrors = unsupported;
  throw error;
}

function canonicalEnumValue(value, schema) {
  if (typeof value !== 'string') return value;
  const candidates = [
    ...(Array.isArray(schema.enum) ? schema.enum : []),
    ...(Object.prototype.hasOwnProperty.call(schema, 'const') ? [schema.const] : []),
  ].filter((candidate) => typeof candidate === 'string');
  const matches = candidates.filter((candidate) => candidate.toLowerCase() === value.toLowerCase());
  // Anthropic documents a narrow enum/const casing exception. Canonicalize it
  // before handing output to application code, but never guess where a schema
  // itself has ambiguous case-only variants.
  return matches.length === 1 ? matches[0] : value;
}

/**
 * Canonicalize Anthropic's documented enum/const casing exception without
 * weakening the original schema contract. All other values are untouched.
 */
export function canonicalizeResponseSchemaEnums(value, schema) {
  if (!schema || typeof schema !== 'object') return value;
  let normalized = canonicalEnumValue(value, schema);
  if (Array.isArray(normalized) && schema.items && typeof schema.items === 'object') {
    normalized = normalized.map((item) => canonicalizeResponseSchemaEnums(item, schema.items));
  } else if (isObject(normalized) && schema.properties && typeof schema.properties === 'object') {
    normalized = Object.fromEntries(Object.entries(normalized).map(([key, item]) => [
      key,
      Object.prototype.hasOwnProperty.call(schema.properties, key)
        ? canonicalizeResponseSchemaEnums(item, schema.properties[key])
        : item,
    ]));
  }
  // Composition/union branches may carry the enum below their own object
  // wrapper. Retain a branch only when its canonicalized value actually
  // validates, avoiding a guess across ambiguous alternatives.
  if (Array.isArray(schema.allOf)) {
    for (const part of schema.allOf) normalized = canonicalizeResponseSchemaEnums(normalized, part);
  }
  for (const keyword of ['anyOf', 'oneOf']) {
    if (!Array.isArray(schema[keyword])) continue;
    const matching = schema[keyword]
      .map((part) => ({ part, value: canonicalizeResponseSchemaEnums(normalized, part) }))
      .filter(({ part, value: candidate }) => validateResponseSchema(candidate, part).length === 0);
    if (matching.length === 1) normalized = matching[0].value;
  }
  return normalized;
}

function validate(value, schema, path, errors) {
  if (!schema || typeof schema !== 'object') return;

  // These combinators are not currently used by aiSchemas.js, but supporting
  // them keeps this validator honest if a response contract gains a modest
  // union/composition before we adopt a declared full JSON-Schema package.
  if (Array.isArray(schema.allOf)) {
    for (const part of schema.allOf) validate(value, part, path, errors);
  }
  if (Array.isArray(schema.anyOf)) {
    const matches = schema.anyOf.some((part) => {
      const branchErrors = [];
      validate(value, part, path, branchErrors);
      return branchErrors.length === 0;
    });
    if (!matches) errors.push({ path, message: 'must match at least one allowed schema variant' });
  }
  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter((part) => {
      const branchErrors = [];
      validate(value, part, path, branchErrors);
      return branchErrors.length === 0;
    }).length;
    if (matches !== 1) errors.push({ path, message: `must match exactly one allowed schema variant (matched ${matches})` });
  }

  if (schema.type !== undefined) {
    const accepted = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!accepted.some((type) => matchesType(value, type))) {
      errors.push({ path, message: `must be ${accepted.join(' or ')} (received ${Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value})` });
      return;
    }
  }

  if (schema.enum && !schema.enum.some((candidate) => sameJsonValue(value, candidate))) {
    errors.push({ path, message: `must be one of: ${schema.enum.map((candidate) => JSON.stringify(candidate)).join(', ')}` });
  }
  if (Object.prototype.hasOwnProperty.call(schema, 'const') && !sameJsonValue(value, schema.const)) {
    errors.push({ path, message: `must equal ${JSON.stringify(schema.const)}` });
  }

  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push({ path, message: `must contain at least ${schema.minLength} character${schema.minLength === 1 ? '' : 's'}` });
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push({ path, message: `must contain at most ${schema.maxLength} character${schema.maxLength === 1 ? '' : 's'}` });
    }
    if (schema.pattern !== undefined && !(new RegExp(schema.pattern)).test(value)) {
      errors.push({ path, message: `must match pattern ${JSON.stringify(schema.pattern)}` });
    }
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push({ path, message: `must be greater than or equal to ${schema.minimum}` });
    if (schema.maximum !== undefined && value > schema.maximum) errors.push({ path, message: `must be less than or equal to ${schema.maximum}` });
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) errors.push({ path, message: `must be greater than ${schema.exclusiveMinimum}` });
    if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) errors.push({ path, message: `must be less than ${schema.exclusiveMaximum}` });
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push({ path, message: `must contain at least ${schema.minItems} item${schema.minItems === 1 ? '' : 's'}` });
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push({ path, message: `must contain at most ${schema.maxItems} item${schema.maxItems === 1 ? '' : 's'}` });
    if (schema.items && typeof schema.items === 'object') {
      value.forEach((item, index) => validate(item, schema.items, joinPath(path, index), errors));
    }
  }

  if (isObject(value)) {
    for (const key of schema.required || []) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) {
        errors.push({ path, message: `is missing required property ${JSON.stringify(key)}` });
      }
    }
    const properties = schema.properties || {};
    for (const [key, child] of Object.entries(properties)) {
      if (Object.prototype.hasOwnProperty.call(value, key)) validate(value[key], child, joinPath(path, key), errors);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.prototype.hasOwnProperty.call(properties, key)) {
          errors.push({ path: joinPath(path, key), message: 'is not an allowed property' });
        }
      }
    } else if (isObject(schema.additionalProperties)) {
      for (const key of Object.keys(value)) {
        if (!Object.prototype.hasOwnProperty.call(properties, key)) {
          validate(value[key], schema.additionalProperties, joinPath(path, key), errors);
        }
      }
    }
  }
}

/**
 * Validate a JSON-compatible value against the response schema passed by the
 * caller. Returns every error so the thrown provider message identifies the
 * field(s) that need attention rather than looking like a generic JSON error.
 */
export function validateResponseSchema(value, schema) {
  const errors = [];
  validate(value, schema, '$', errors);
  return errors;
}

export function assertResponseMatchesSchema(value, schema, { provider = 'AI', task = null } = {}) {
  assertResponseSchemaVocabularySupported(schema, { task });
  const errors = validateResponseSchema(value, schema);
  if (errors.length === 0) return;
  const shown = errors.slice(0, 5).map(({ path, message }) => `${path} ${message}`).join('; ');
  const remainder = errors.length > 5 ? ` (${errors.length - 5} more)` : '';
  const taskLabel = task ? ` for task '${task}'` : '';
  const error = new Error(`${provider} returned a structured response that violates its required schema${taskLabel}: ${shown}${remainder}. Please retry; no partial result was used.`);
  error.code = 'STRUCTURED_OUTPUT_SCHEMA_INVALID';
  error.schemaErrors = errors;
  throw error;
}
