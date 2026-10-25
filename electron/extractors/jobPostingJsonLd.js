// Pure JSON-LD traversal shared by host-only resolution and scrape extraction.
const htmlSpace = character => character === ' ' || character === '\t' || character === '\n' || character === '\r' || character === '\f';

// Each opening tag is consumed once, including malformed unterminated tags.
// A backtracking `<script...>` expression retries the entire remaining page
// for every `<script ` prefix when an untrusted page omits its closing `>`.
function scriptTagEnd(source, start) {
  let quote = '';
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (quote) { if (character === quote) quote = ''; }
    else if (character === '"' || character === "'") quote = character;
    else if (character === '>') return index;
  }
  return -1;
}

function isJsonLdTag(source, start, end) {
  let index = start;
  while (index < end) {
    while (index < end && (htmlSpace(source[index]) || source[index] === '/')) index += 1;
    const nameStart = index;
    while (index < end && !htmlSpace(source[index]) && source[index] !== '=' && source[index] !== '/') index += 1;
    const name = source.slice(nameStart, index).toLowerCase();
    while (index < end && htmlSpace(source[index])) index += 1;
    if (source[index] !== '=') { if (index === nameStart) index += 1; continue; }
    index += 1;
    while (index < end && htmlSpace(source[index])) index += 1;
    const quote = source[index] === '"' || source[index] === "'" ? source[index++] : '';
    const valueStart = index;
    while (index < end && (quote ? source[index] !== quote : !htmlSpace(source[index]))) index += 1;
    const value = source.slice(valueStart, index);
    if (quote && index < end) index += 1;
    if (name === 'type') return /^application\/ld\+json(?:\s*;[^]*)?$/iu.test(value.trim());
  }
  return false;
}

/**
 * Walk every JSON-LD `<script>` block in a page's HTML looking for
 * `JobPosting` nodes (handles `@graph` wrappers and array `@type`), calling
 * `visit(node)` for each one found. The first call whose return value is not
 * `undefined` short-circuits the walk and becomes the return value. Never
 * throws on malformed JSON-LD — a bad block is just skipped.
 *
 * Shared by extractJobPostingDescription (harvests `.description`) and
 * extractJobPostingBaseSalary (harvests `.baseSalary`) so the traversal
 * itself — the actual source of truth for "how do we find a JobPosting node
 * in this page" — lives in exactly one place.
 * @param {string} html
 * Without a visitor, returns every posting's structured identity, location,
 * salary and description fields. A visitor keeps the historical raw-node,
 * first-non-undefined return contract used by the two extraction helpers.
 * @param {(node: object) => any} [visit]
 * @returns {any} — visit's first non-undefined return, or all normalized nodes
 */
export function walkJsonLdJobPostings(html, visit) {
  const postings = [];
  const source = String(html || '');
  const opening = /<script(?=[\t\n\f\r />])/gi;
  const closing = /<\/script\s*>/gi;
  while (opening.exec(source)) {
    const tagEnd = scriptTagEnd(source, opening.lastIndex);
    if (tagEnd < 0) break;
    const jsonLd = isJsonLdTag(source, opening.lastIndex, tagEnd);
    opening.lastIndex = tagEnd + 1;
    if (!jsonLd) continue;
    closing.lastIndex = tagEnd + 1;
    const end = closing.exec(source);
    if (!end) break;
    opening.lastIndex = closing.lastIndex;
    let data;
    try { data = JSON.parse(source.slice(tagEnd + 1, end.index).trim()); } catch { continue; }
    const stack = [data];
    for (let index = 0; index < stack.length; index += 1) {
      const node = stack[index];
      if (!node || typeof node !== 'object') continue;
      if (Array.isArray(node)) {
        for (const value of node) stack.push(value);
        continue;
      }
      const type = node['@type'];
      const isJob = (Array.isArray(type) ? type : [type])
        .some(value => typeof value === 'string' && /(?:^|[/#])JobPosting$/u.test(value));
      if (isJob) {
        if (typeof visit === 'function') {
          const result = visit(node);
          if (result !== undefined) return result;
        } else {
          const organization = Array.isArray(node.hiringOrganization) ? node.hiringOrganization[0] : node.hiringOrganization;
          const sameAs = organization?.sameAs;
          postings.push({
            title: typeof node.title === 'string' ? node.title : '',
            hiringOrganization: {
              name: typeof organization?.name === 'string' ? organization.name : typeof organization === 'string' ? organization : '',
              sameAs: Array.isArray(sameAs) ? sameAs.filter(value => typeof value === 'string') : typeof sameAs === 'string' ? sameAs : '',
            },
            jobLocation: node.jobLocation ?? null,
            baseSalary: node.baseSalary && typeof node.baseSalary === 'object' ? node.baseSalary : null,
            identifier: node.identifier ?? null,
            validThrough: typeof node.validThrough === 'string' ? node.validThrough : '',
            description: typeof node.description === 'string' ? node.description : '',
            url: typeof node.url === 'string' ? node.url : '',
            jobLocationType: typeof node.jobLocationType === 'string' ? node.jobLocationType : '',
            applicantLocationRequirements: node.applicantLocationRequirements ?? null,
          });
        }
      }
      for (const value of Object.values(node)) if (value && typeof value === 'object') stack.push(value);
    }
  }
  return typeof visit === 'function' ? undefined : postings;
}
