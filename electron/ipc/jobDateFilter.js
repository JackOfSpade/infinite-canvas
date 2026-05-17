/**
 * Parses the wide variety of "posted" strings job sources return so we can
 * apply a max-age filter client-side for sources without a URL date param.
 *
 * Unparseable entries are KEPT — we'd rather over-show than silently drop a
 * relevant listing because the source uses some format we missed.
 */

export function parsePostedDate(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;

  const iso = Date.parse(s);
  if (!isNaN(iso)) return new Date(iso);

  const lower = s.toLowerCase();
  if (lower === 'today' || lower === 'just posted' || lower === 'just now' || lower.includes('active today')) {
    return new Date();
  }
  if (lower === 'yesterday') {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return d;
  }

  // "Nd ago" / "N days ago" / "Nh ago" / "N weeks ago" / "N months ago"
  // Note: bare "Nm" is treated as minutes (matches the LinkedIn/Twitter
  // convention); "Nmo" is months. Both are recent enough that any reasonable
  // maxAgeDays will keep them.
  const m = lower.match(/(\d+)\s*(mo|months?|d|days?|h|hours?|w|weeks?|m|mins?|minutes?)\b/);
  if (m) {
    const n = parseInt(m[1], 10);
    const unit = m[2];
    let days;
    if (/^mo|months?$/.test(unit)) days = n * 30;
    else if (/^w|weeks?$/.test(unit)) days = n * 7;
    else if (/^d|days?$/.test(unit)) days = n;
    else days = 0; // hours / minutes — same-day
    const d = new Date();
    d.setDate(d.getDate() - days);
    return d;
  }
  return null;
}

export function filterJobsByAge(jobs, maxAgeDays) {
  if (!maxAgeDays || maxAgeDays <= 0) return jobs;
  const cutoff = Date.now() - maxAgeDays * 86400000;
  return jobs.filter(j => {
    const d = parsePostedDate(j.posted);
    if (!d) return true;
    return d.getTime() >= cutoff;
  });
}
