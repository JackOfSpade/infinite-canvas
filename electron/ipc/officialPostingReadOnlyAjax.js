// Some first-party careers templates POST public job reads even though their
// endpoint also supports GET. The caller must first require a POST xhr/fetch
// initiated by the owned main frame. No POST or network I/O happens here.
import { parseFragment } from 'parse5';

const MAX_BYTES = 3 * 1024 * 1024;
const numericId = value => typeof value === 'string' && /^[1-9]\d{0,15}$/u.test(value);
function https(value) {
  try {
    const u = new URL(value);
    if (typeof value !== 'string' || u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')
      || [...value].some(char => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127) || u.hostname.endsWith('.')) return null;
    u.hash = ''; return u;
  } catch { return null; }
}
function careersDirectory(url) {
  const parts = url.pathname.split('/'); const index = parts.indexOf('careers');
  return index >= 1 ? `${parts.slice(0, index + 1).join('/')}/` : '';
}
function oneHeader(headers, name) {
  const entries = Object.entries(headers || {}).filter(([key]) => key.toLowerCase() === name);
  return entries.length === 1 && typeof entries[0][1] === 'string' ? entries[0][1] : '';
}

export function deriveOfficialPostingReadOnlyAjaxRequest({ url: value, documentUrl, headers, body } = {}) {
  const url = https(value); const document = https(documentUrl);
  if (!url || !document || url.origin !== document.origin || url.search || typeof body !== 'string'
    || Buffer.byteLength(body, 'utf8') > 2_048 || body.includes('\0')) return null;
  const directory = careersDirectory(document);
  if (!directory || !url.pathname.startsWith(directory)) return null;
  if (!/^application\/x-www-form-urlencoded(?:\s*;\s*charset=(?:utf-8|"utf-8"))?$/iu.test(oneHeader(headers, 'content-type'))) return null;
  const fields = new URLSearchParams(body); const keys = [...fields.keys()];
  if (keys.length !== 1 || fields.getAll(keys[0]).length !== 1) return null;
  const endpoint = url.pathname.slice(directory.length);
  if (endpoint === 'greenhouse_api.php' && keys[0] === 'limit' && fields.get('limit') === '-1') {
    url.searchParams.set('limit', '-1'); return { url: url.href, type: 'board', jobId: '' };
  }
  if (endpoint === 'fetch-single-job.php' && keys[0] === 'job_id' && numericId(fields.get('job_id'))) {
    const jobId = fields.get('job_id'); url.searchParams.set('job_id', jobId);
    return { url: url.href, type: 'detail', jobId };
  }
  return null;
}

function boardMarkupValid(body, source) {
  const nodes = [parseFragment(body)]; let seen = 0; let wrapper = false; let row = false; let jobLink = false;
  const directory = careersDirectory(source);
  while (nodes.length) {
    const node = nodes.pop(); const nested = node.childNodes || [];
    if (++seen + nodes.length + nested.length > 32_768 || ['script', 'iframe', 'form', 'input', 'button', 'object', 'embed', 'meta', 'base', 'link'].includes(node.tagName)) return false;
    const attrs = new Map((node.attrs || []).map(item => [item.name, item.value]));
    if ([...attrs.keys()].some(name => /^on/iu.test(name) || name === 'srcdoc')) return false;
    const classes = (attrs.get('class') || '').split(/\s+/u);
    wrapper ||= classes.includes('jobs_wrapper'); row ||= classes.includes('single_job_wrapper');
    if (node.tagName === 'a' && attrs.get('href')) {
      let link; try { link = https(new URL(attrs.get('href'), source).href); } catch { return false; }
      if (!link || link.origin !== source.origin || link.pathname !== `${directory}single-job.html`
        || [...link.searchParams.keys()].length !== 1 || link.searchParams.getAll('job_id').length !== 1
        || !numericId(link.searchParams.get('job_id'))) return false;
      jobLink = true;
    }
    for (let at = nested.length - 1; at >= 0; at--) nodes.push(nested[at]);
  }
  return wrapper && row && jobLink;
}
function exactGreenhouseDetail(value, jobId) {
  const url = https(value);
  return url && /^(?:boards|job-boards(?:\.[a-z]{2})?)\.greenhouse\.io$/u.test(url.hostname)
    && new RegExp(`^/[a-z0-9][a-z0-9_-]{0,119}/jobs/${jobId}/?$`, 'iu').test(url.pathname);
}

export function validateOfficialPostingReadOnlyAjaxResponse(plan, response) {
  const source = https(plan?.url); const responseUrl = https(response?.url || response?.sourceUrl);
  const body = response?.body;
  if (!source || !responseUrl || responseUrl.href !== source.href || response.statusCode !== 200
    || typeof body !== 'string' || body.includes('\0') || Buffer.byteLength(body, 'utf8') > MAX_BYTES
    || !['text/html', 'application/json'].includes(response.contentType)) return null;
  let data; try { data = JSON.parse(body); } catch { return null; }
  if (!data || Array.isArray(data) || data.success !== true) return null;
  if (plan.type === 'board') {
    if (!source.pathname.endsWith('/careers/greenhouse_api.php') || source.searchParams.get('limit') !== '-1'
      || [...source.searchParams.keys()].length !== 1 || typeof data.jobs !== 'string' || !boardMarkupValid(data.jobs, source)) return null;
  } else if (plan.type === 'detail') {
    if (!numericId(plan.jobId) || !source.pathname.endsWith('/careers/fetch-single-job.php')
      || source.searchParams.get('job_id') !== plan.jobId || [...source.searchParams.keys()].length !== 1
      || typeof data.title !== 'string' || !data.title.trim() || data.title.length > 500
      || typeof data.content !== 'string' || !data.content.trim() || typeof data.location !== 'string' || data.location.length > 500
      || !exactGreenhouseDetail(data.link, plan.jobId)) return null;
  } else return null;
  // Preserve the template's content type. It explicitly JSON.parse()s the
  // string result; changing text/html to application/json would parse twice.
  return { ...response, body, contentType: response.contentType };
}
