import { LOCAL_AI_APPLICATION_SNIPPET_MAX_CHARS } from './officialPostingFields.js';
import { isUnsafeControlCharacter } from './structuredResume.js';

const SOURCE_FIELDS = ['employer', 'hiringOrganization', 'description', 'locations', 'workMode', 'remote',
  'remoteCountry', 'remoteRegion', 'employmentType', 'seniority', 'jobLevel', 'identifier', 'requisitionId',
  'reqId', 'sourceUrl', 'provenance'];
const MAX_SOURCE_BYTES = 256 * 1024;

/** The same bounded original facts reach refresh, preparation and the final
 * queue projection. They remain untrusted evidence, never official authority. */
export function projectOfficialPostingSourceFields(raw = {}) {
  let nodes = 0;
  const seen = new Set();
  const copy = (value, key, depth = 0) => {
    if (++nodes > 2_048 || depth > 4) throw new TypeError('Official posting source facts exceed their structural limit.');
    if (value === undefined || value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
      const limit = key === 'description' ? LOCAL_AI_APPLICATION_SNIPPET_MAX_CHARS : 2_000;
      if (value.length > limit) throw new TypeError(`Official posting source ${key} exceeds its size limit.`);
      return Array.from(value, char => char === '\r' || isUnsafeControlCharacter(char) ? ' ' : char).join('').trim();
    }
    if (!value || typeof value !== 'object' || seen.has(value)
      || (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))) {
      throw new TypeError('Official posting source facts must be serializable data.');
    }
    seen.add(value);
    let result;
    if (Array.isArray(value)) {
      if (value.length > 64) throw new TypeError('Official posting source arrays exceed their size limit.');
      result = value.map(item => copy(item, key, depth + 1));
    } else {
      const entries = Object.entries(value);
      if (entries.length > 32 || entries.some(([name]) => name.length > 120)) throw new TypeError('Official posting source objects exceed their size limit.');
      result = Object.fromEntries(entries.map(([name, item]) => [name, copy(item, key, depth + 1)]));
    }
    seen.delete(value);
    return result;
  };
  const projected = {};
  for (const key of SOURCE_FIELDS) {
    if (raw[key] === undefined) continue;
    if (raw[key] !== null && (key === 'description' && typeof raw[key] !== 'string'
      || key === 'remote' && typeof raw[key] !== 'boolean')) throw new TypeError(`Official posting source ${key} has an invalid type.`);
    projected[key] = copy(raw[key], key);
  }
  if (Buffer.byteLength(JSON.stringify(projected)) > MAX_SOURCE_BYTES) throw new TypeError('Official posting source facts exceed their size limit.');
  return projected;
}
