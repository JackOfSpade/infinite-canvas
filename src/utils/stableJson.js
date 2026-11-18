// JSON text with object keys sorted at every depth, so equal values always
// give equal text. Kept dependency-free so the renderer and the main process
// can both import it. An undefined input gives undefined, as JSON.stringify does.
export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
