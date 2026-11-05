import fs from 'node:fs';
import path from 'node:path';
import electronPkg from 'electron';
import logger from '../logger.js';
import { atomicWriteJson } from '../utils/pathSafety.js';

/**
 * A scraper breaking doesn't throw: it returns less, and whatever reads the result reports an honest-looking miss.
 * Surfaces that keep no per-source warning of their own report here. An alarm stays on disk until a later run of the
 * same scraper reads enough pages cleanly, so a restart can't lose it. Counts and fixed text only: never page text,
 * job identity or a URL with a query in it.
 */
const FILE_NAME = 'scrape-alarms.json';
const MAX_ALARMS = 64;
const MAX_TEXT = 300;
const EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;
export const SCRAPE_ALARMS_CHANGED_CHANNEL = 'scrape-alarms-changed';

/** True only when a share is high on a sample big enough to mean something, so a few bad pages never fire. */
export function scrapeShareBroken({ attempts, bad, minAttempts, minBad, maxShare }) {
  return attempts >= minAttempts && bad >= minBad && bad / attempts > maxShare;
}

const text = value => String(value ?? '').replace(/\s+/gu, ' ').trim().slice(0, MAX_TEXT);
const count = value => (Number.isSafeInteger(value) && value >= 0 ? value : 0);

function normalizeAlarm(value, now) {
  const key = text(value?.key);
  const at = Number(value?.at);
  if (!key || !Number.isFinite(at) || now - at >= EXPIRY_MS) return null;
  return { key, surface: text(value.surface), site: text(value.site), what: text(value.what), attempts: count(value.attempts),
    bad: count(value.bad), at, firstAt: Number.isFinite(Number(value.firstAt)) ? Number(value.firstAt) : at };
}

export function createScrapeAlarmStore(filePath, { now = Date.now, onChange = () => {} } = {}) {
  let alarms = null;
  let writes = Promise.resolve();
  const load = () => {
    if (alarms) return alarms;
    alarms = new Map();
    try {
      const saved = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      for (const item of Array.isArray(saved?.alarms) ? saved.alarms.slice(0, MAX_ALARMS) : []) {
        const alarm = normalizeAlarm(item, now());
        if (alarm) alarms.set(alarm.key, alarm);
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') logger.warn(`[ScrapeAlarms] Could not read saved alarms: ${error?.message || error}`);
    }
    return alarms;
  };
  const list = () => [...load().values()].sort((a, b) => b.at - a.at);
  const save = () => {
    const payload = { version: 1, alarms: list() };
    writes = writes.then(() => atomicWriteJson(filePath, payload, { ensureDir: true }))
      .catch(error => logger.warn(`[ScrapeAlarms] Could not save alarms: ${error?.message || error}`));
    return writes;
  };
  return {
    list,
    flush: () => writes,
    /** `failure` raises or refreshes the alarm. `failure: null` clears it, so call that only after a run with enough reads to count as healthy. */
    report({ key, surface, site, failure }) {
      const id = text(key);
      if (!id) return;
      const current = load().get(id);
      if (!failure) {
        if (!current) return;
        load().delete(id);
        logger.info(`[ScrapeAlarms] Cleared ${id}: its latest run read cleanly`);
      } else {
        const at = now();
        load().set(id, { key: id, surface: text(surface), site: text(site), what: text(failure.what), attempts: count(failure.attempts),
          bad: count(failure.bad), at, firstAt: current?.firstAt ?? at });
        for (const oldest of list().slice(MAX_ALARMS)) load().delete(oldest.key);
        logger.error(`[ScrapeAlarms] ${text(surface)} / ${text(site)}: ${text(failure.what)} (${count(failure.bad)} of ${count(failure.attempts)})`);
      }
      save();
      onChange(list());
    },
  };
}

let shared = null;
function sharedStore() {
  if (!shared) {
    shared = createScrapeAlarmStore(path.join(electronPkg.app.getPath('userData'), FILE_NAME), {
      onChange: alarms => {
        for (const window of electronPkg.BrowserWindow?.getAllWindows?.() || []) {
          if (!window.isDestroyed()) window.webContents.send(SCRAPE_ALARMS_CHANGED_CHANNEL, alarms);
        }
      },
    });
  }
  return shared;
}

/** Never lets alarm bookkeeping disturb the scrape that called it. */
export function reportScrapeHealth(report) {
  try { sharedStore().report(report); } catch (error) { logger.warn(`[ScrapeAlarms] Could not record ${report?.key}: ${error?.message || error}`); }
}

export function listScrapeAlarms() {
  try { return sharedStore().list(); } catch { return []; }
}

/** For the bug report. It states what is on record, not a diagnosis. */
export function scrapeAlarmsMarkdown(alarms = listScrapeAlarms()) {
  if (!alarms.length) return '\n## Scrape Alarms\n- None on record.\n';
  return `\n## Scrape Alarms\n${alarms.map(alarm => `- ${alarm.surface} / ${alarm.site}: ${alarm.what} (${alarm.bad} of ${alarm.attempts}) · last ${new Date(alarm.at).toISOString()} · first ${new Date(alarm.firstAt).toISOString()}`).join('\n')}\n`;
}
