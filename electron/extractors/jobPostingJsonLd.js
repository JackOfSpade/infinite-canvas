// Pure JSON-LD traversal shared by host-only resolution and scrape extraction.
import { parse as parseHtml } from 'parse5';

function* jsonLdScriptBodies(html) {
  // HTML context matters: script/comment-looking bytes in quoted attributes,
  // scripts, textarea and other raw-text elements are ordinary text. Use the
  // existing HTML parser instead of maintaining a second tokenizer here. Its
  // bounded linear scan also handles malformed tags without regex backtracking.
  const pending = [parseHtml(html)];
  while (pending.length) {
    const node = pending.pop();
    if (node.tagName === 'script') {
      const type = node.attrs?.find(attribute => attribute.name === 'type')?.value || '';
      if (/^application\/ld\+json(?:\s*;[^]*)?$/iu.test(type.trim())) {
        yield (node.childNodes || []).filter(child => child.nodeName === '#text').map(child => child.value).join('');
      }
      continue;
    }
    // Template contents are a separate inert document fragment, just as they
    // are for document.querySelectorAll in the browser. Do not enter .content.
    const children = node.childNodes || [];
    for (let index = children.length - 1; index >= 0; index -= 1) pending.push(children[index]);
  }
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
  for (const body of jsonLdScriptBodies(String(html || ''))) {
    let data;
    try { data = JSON.parse(body.trim()); } catch { continue; }
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
