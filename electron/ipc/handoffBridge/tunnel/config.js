import { TUNNEL_CONSTANTS } from './constants.js';
import { validateTunnelConfig, validateTunnelHostname, validateTunnelId } from './validate.js';

const CONTROL = new RegExp(`[${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]`);
const isSafeConfigPath = value => typeof value === 'string' && value.startsWith('/') && value.length <= 512 && !CONTROL.test(value) && !value.includes('/../');

export function renderTunnelConfig(input) {
  const value = validateTunnelConfig(input);
  if (!value) return null;
  return `tunnel: ${value.tunnelId}\ncredentials-file: ${JSON.stringify(value.credentialsPath)}\ningress:\n  - hostname: ${value.hostname}\n    service: ${JSON.stringify(`unix:${value.socketPath}`)}\n    originRequest:\n      httpHostHeader: ${value.hostname}\n      connectTimeout: 5s\n      keepAliveConnections: 8\n      keepAliveTimeout: 30s\n  - service: http_status:404\n`;
}

export function buildRunArgv({ configPath, tunnelId, metricsPort } = {}) {
  if (!Number.isInteger(metricsPort) || metricsPort < TUNNEL_CONSTANTS.METRICS_PORT_MIN || metricsPort > TUNNEL_CONSTANTS.METRICS_PORT_MAX) return null;
  if (!isSafeConfigPath(configPath) || !validateTunnelId(tunnelId)) return null;
  return Object.freeze(['tunnel', '--config', configPath, '--no-autoupdate', '--loglevel', 'info', '--metrics', `127.0.0.1:${metricsPort}`, '--grace-period', TUNNEL_CONSTANTS.TUNNEL_GRACE_PERIOD, '--label', TUNNEL_CONSTANTS.TUNNEL_LABEL, '--management-diagnostics=false', 'run', tunnelId]);
}

export function buildDryRunArgv({ configPath, hostname } = {}) {
  if (!isSafeConfigPath(configPath) || !validateTunnelHostname(hostname)) return null;
  return Object.freeze([
    ['tunnel', '--config', configPath, '--no-autoupdate', '--grace-period', TUNNEL_CONSTANTS.TUNNEL_GRACE_PERIOD, '--management-diagnostics=false', 'ingress', 'validate'],
    ['tunnel', '--config', configPath, '--no-autoupdate', '--grace-period', TUNNEL_CONSTANTS.TUNNEL_GRACE_PERIOD, '--management-diagnostics=false', 'ingress', 'rule', `https://${hostname}/mcp`],
    ['tunnel', '--config', configPath, '--no-autoupdate', '--grace-period', TUNNEL_CONSTANTS.TUNNEL_GRACE_PERIOD, '--management-diagnostics=false', 'ingress', 'rule', 'https://not-the-bridge.invalid/'],
  ]);
}

export function buildChildEnv({ HOME, TMPDIR } = {}) {
  return Object.freeze({ PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: HOME || '', TMPDIR: TMPDIR || '' });
}

export function validateDryRunOutput({ configPath, hostname, socketPath, validationOutput, matchingRuleOutput, fallbackRuleOutput } = {}) {
  const service = `unix:${socketPath}`;
  return validationOutput === `Validating rules from ${configPath}\nOK`
    && matchingRuleOutput?.includes('rule #0')
    && matchingRuleOutput.includes(service)
    && fallbackRuleOutput?.includes('rule #1')
    && fallbackRuleOutput.includes('http_status:404')
    && matchingRuleOutput.includes(`https://${hostname}/mcp`)
    && typeof hostname === 'string' && typeof configPath === 'string';
}
