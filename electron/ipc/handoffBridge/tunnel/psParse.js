export function parsePsRows(text) {
  return String(text || '').split('\n').map(line => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.{24})\s+(.+)$/);
    return match ? { pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), lstart: match[4].trim(), command: match[5], raw: line } : null;
  }).filter(Boolean);
}

export function isOwnedTunnelRow(row, { configPath, userData } = {}) {
  if (!row || !configPath || !userData) return false;
  const marker = ` tunnel --config ${configPath} --no-autoupdate `;
  const at = row.command.indexOf(marker);
  if (at < 0) return false;
  const before = row.command.slice(0, at);
  const copy = `${userData}/handoff-bridge/tunnel/bin/cloudflared-`;
  const hash = before.slice(-8);
  return /^[0-9a-f]{8}$/.test(hash) && before.endsWith(`${copy}${hash}`);
}
