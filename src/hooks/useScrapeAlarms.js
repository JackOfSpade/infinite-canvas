import { useEffect } from 'react';

export const scrapeAlarmToast = alarm => ({
  title: `${alarm.site} ${alarm.surface} look broken`,
  description: `${alarm.what} (${alarm.bad} of ${alarm.attempts}). This scraper may need a fix, so these results may be incomplete. Send a bug report.`,
  type: 'error',
  duration: 0,
  dedupeKey: `scrape-alarm:${alarm.key}:${alarm.at}`,
});

/** Saved alarms show on launch and new ones as they happen. Each stays on record until that scraper next reads cleanly. */
export function useScrapeAlarms(addToast) {
  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.getScrapeAlarms) return undefined;
    let active = true;
    const show = alarms => { for (const alarm of Array.isArray(alarms) ? alarms : []) addToast(scrapeAlarmToast(alarm)); };
    api.getScrapeAlarms().then(result => { if (active) show(result?.alarms); }).catch(() => {});
    const stop = api.onScrapeAlarmsChanged?.(show);
    return () => { active = false; stop?.(); };
  }, [addToast]);
}
