// A disposable renderer needs public presentation headers for framework data
// requests. Authentication, cookies, origin, host and server-action headers
// never cross this boundary.
const clean = (value, max) => typeof value === 'string' && value.length <= max
  && ![...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
export function officialPostingResourceHeaders(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const input = Object.fromEntries(Object.entries(value).map(([key, entry]) => [key.toLowerCase(), entry]));
  const result = {};
  if (input.rsc === '1') {
    result.rsc = '1'; result.accept = 'text/x-component';
    if (clean(input['next-router-state-tree'], 16_384)) result['next-router-state-tree'] = input['next-router-state-tree'];
    if (clean(input['next-url'], 2_000) && input['next-url'].startsWith('/') && !input['next-url'].startsWith('//')
      && !input['next-url'].includes('\\')) result['next-url'] = input['next-url'];
  }
  if (input['x-nextjs-data'] === '1') result['x-nextjs-data'] = '1';
  if (clean(input['accept-language'], 160) && /^[a-z0-9,;=*. -]*$/iu.test(input['accept-language'])) result['accept-language'] = input['accept-language'];
  return result;
}
