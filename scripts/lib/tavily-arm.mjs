// Tavily as a measurement arm only. The app itself uses Parallel Search (electron/ipc/parallelSearch.js);
// the A/B scripts keep a Tavily arm so past results (docs/ai-test-runs.md) stay comparable.
// The key is read from the login keychain and only ever leaves here inside the MCP server URL.
import { execFile as nodeExecFile } from 'node:child_process';

export const TAVILY_KEYCHAIN_SERVICE = 'infinite-canvas-tavily-api-key';
export const TAVILY_MCP_URL = 'https://mcp.tavily.com/mcp/';
export const TAVILY_RESEARCH_TOOLS = Object.freeze(['mcp__tavily__tavily_search', 'mcp__tavily__tavily_extract']);
const SECURITY_BIN = '/usr/bin/security';

/** The key, or '' when none is stored. */
export function readTavilyKey({ execFile = nodeExecFile } = {}) {
  return new Promise((resolve) => {
    try {
      execFile(SECURITY_BIN, ['find-generic-password', '-s', TAVILY_KEYCHAIN_SERVICE, '-w'], { timeout: 10_000 }, (error, stdout) => {
        resolve(error ? '' : String(stdout ?? '').trim());
      });
    } catch { resolve(''); }
  });
}

/** The one MCP server a Tavily research arm is given. */
export function tavilyMcpServers(key) {
  return { tavily: { type: 'http', url: `${TAVILY_MCP_URL}?tavilyApiKey=${encodeURIComponent(key)}` } };
}
