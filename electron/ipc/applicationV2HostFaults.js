import { forbiddenPunctuationKinds } from './candidatePunctuation.js';
export const WRITE_VERIFY_HOST_RENDER_RETRIES = 2;
const labels = { resume: 'résumé', coverLetter: 'cover letter' };
const codes = { 'render-error': 'render failed', 'fonts-not-loaded': 'fonts did not load', 'page-count-unavailable': 'page count unavailable' };
export function classifyRenderFaults({ resumeFit, letterFit }) {
  const transient = [], punctuation = [];
  for (const [document, fit] of [['resume', resumeFit], ['coverLetter', letterFit]]) {
    const detail = String(fit?.renderError || '').slice(0, 200);
    if (/^(?:Résumé|Cover-letter) copy contains /u.test(detail)) { punctuation.push({ document, detail }); continue; }
    const code = fit?.renderError ? 'render-error' : fit?.fontsLoaded !== true ? 'fonts-not-loaded'
      : !Number.isInteger(fit?.pageCount) || fit.pageCount < 1 ? 'page-count-unavailable' : null;
    if (code) transient.push({ document, code, detail });
  }
  return { transient, punctuation };
}
export async function renderDocumentsWithHostRetry(renderBoth, retries = WRITE_VERIFY_HOST_RENDER_RETRIES) {
  for (let hostRenders = 1; hostRenders <= retries + 1; hostRenders++) {
    let rendered;
    try { rendered = await renderBoth(); }
    catch (error) { rendered = { resumeFit: { renderError: String(error?.message || error) }, letterFit: { renderError: String(error?.message || error) } }; }
    const faults = classifyRenderFaults(rendered);
    const result = { ...rendered, ...faults, hostRenders };
    if (faults.punctuation.length || !faults.transient.length || hostRenders === retries + 1) return result;
  }
}
export function fitRejectionMessage({ resumeFit, letterFit, layoutIssueMessages = [] }) {
  const facts = [];
  for (const [document, fit] of [['resume', resumeFit], ['coverLetter', letterFit]]) {
    if (!(fit?.pageCount > 1)) continue;
    let fact = `${labels[document]} measured ${fit.pageCount} pages (target 1)`;
    const { contentHeightPx, typeAreaHeightPx, lineHeightPx } = fit.layout || {};
    const ratio = contentHeightPx / typeAreaHeightPx;
    if (Number.isFinite(ratio) && ratio > 0) fact += `, content spans ${Math.round(ratio * 1000) / 10}% of the type area on screen`;
    const over = contentHeightPx - typeAreaHeightPx;
    if (Number.isFinite(over) && over > 0 && Number.isFinite(lineHeightPx) && lineHeightPx > 0) fact += `, about ${Math.max(1, Math.ceil(over / lineHeightPx))} lines (${Math.round(over)}px) over`;
    facts.push(fact);
  }
  facts.push(...layoutIssueMessages);
  return facts.length ? `measured-one-page-fit: ${facts.join('; ')}. Shorten or remove units; do not add new content.` : null;
}
export function renderUnavailableMessage({ faults, hostRenders }) {
  return `Application v2 could not verify page layout: ${faults.map(row => `${labels[row.document]} ${codes[row.code]}`).join('; ')} (${hostRenders} renders). The draft passed every content check and is held unchanged; no AI call is needed. Retry when PDF rendering is available.`.slice(0, 280);
}
export class ApplicationV2RenderUnavailableError extends Error {
  constructor({ faults, hostRenders }) {
    super(renderUnavailableMessage({ faults, hostRenders })); this.name = 'ApplicationV2RenderUnavailableError';
    this.code = 'APPLICATION_V2_RENDER_UNAVAILABLE'; this.faults = faults.map(({ document, code }) => ({ document, code })); this.hostRenders = hostRenders;
  }
}
export function hostOwnedPunctuationFaults({ sourceRoles = [], identity, recordFields = [] }) {
  const fields = [...recordFields];
  for (const role of sourceRoles) for (const field of ['title', 'company', 'location']) fields.push({ path: `roles[${role.id}].${field}`, text: role[field] });
  for (const field of ['name', 'subtitleRole', 'credential']) fields.push({ path: `identity.${field}`, text: identity?.[field] });
  for (const [index, text] of (identity?.contact || []).entries()) fields.push({ path: `identity.contact[${index}]`, text });
  return fields.flatMap(({ path, text }) => { const marks = forbiddenPunctuationKinds(text); return marks.length ? [{ path, marks }] : []; });
}
export function hostOwnedPunctuationMessage(faults) {
  return `Application v2 stopped: host-owned text cannot satisfy the punctuation rule and no rewrite can change it: ${faults.map(row => `${row.path} (${row.marks.map(mark => mark.replace(/-/g, ' ')).join(', ')})`).join(', ')}. Edit the career data to remove the mark.`;
}
export function fitMeasurement({ resumeFit, letterFit }) {
  return Object.fromEntries([['resume', resumeFit], ['coverLetter', letterFit]].map(([key, fit]) => [key, {
    pageCount: fit.pageCount, contentHeightPx: Number.isFinite(fit.layout?.contentHeightPx) ? fit.layout.contentHeightPx : null,
    horizontalOverflowCount: Number.isFinite(fit.layout?.horizontalOverflowCount) ? fit.layout.horizontalOverflowCount : (fit.layoutIssues || []).reduce((sum, row) => sum + (Number.isFinite(row.count) ? row.count : 0), 0),
  }]));
}
export function sameFitMeasurement(previous, current) {
  return !!previous && !!current && ['resume', 'coverLetter'].every(key => previous[key]?.pageCount === current[key]?.pageCount
    && previous[key]?.horizontalOverflowCount === current[key]?.horizontalOverflowCount
    && Number.isFinite(previous[key]?.contentHeightPx) && Number.isFinite(current[key]?.contentHeightPx) && Math.abs(previous[key].contentHeightPx - current[key].contentHeightPx) <= 1);
}
