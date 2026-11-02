import { withDom } from './mountComponent.js';

export async function withConsoleCollector(fn) {
  const original = { warn: console.warn, error: console.error };
  const entries = [];
  console.warn = (...args) => entries.push({ level: 'warn', args });
  console.error = (...args) => entries.push({ level: 'error', args });
  try {
    return await fn(entries);
  } finally {
    console.warn = original.warn;
    console.error = original.error;
  }
}

export async function mountInStrictMode({ React, createRoot, act, Component, props = {} }) {
  return withDom(async window => withConsoleCollector(async entries => {
    const root = createRoot(window.document.getElementById('root'));
    let html = '';
    try {
      await act(async () => root.render(React.createElement(React.StrictMode, null, React.createElement(Component, props))));
      html = window.document.body.innerHTML;
    } finally {
      await act(async () => root.unmount());
    }
    if (entries.length) throw new Error(`render emitted console output: ${entries.map(entry => entry.level).join(', ')}`);
    return html;
  }));
}
