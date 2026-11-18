// The only module-level mutable state of the manual scraper. Importers share these
// objects and assign to their fields; no importer may rebind the exports.

export const manualScraperTelemetry = {
  active: null,
  events: [],
  // Detail-recovery outcomes need a retention guarantee independent of normal
  // scrape progress. A busy later source can otherwise evict an early detail
  // miss or a provider-confirmed closed listing from the 30-event phase ring
  // before the user opens a FULL report.
  fieldAnomalies: [],
  // This run's Apply-on reads, carried into the durable run receipt.
  googleApplyCapture: null,
  paused: false,  // survives page navigations — source of truth is Node.js, not the page
  consoleLogs: [],   // last 60 browser-side console errors/warnings from the stealth page
  networkErrors: [], // last 30 network failures / 4xx-5xx responses from the stealth page
  // The phase ring is a 30-slot RECENCY window, so on a long walk the rows that
  // establish what this run even is — source-start, query-start, the location
  // resolution/redirect trail — are evicted by per-job anomaly chatter before a
  // reader ever opens the report. These are emitted at most once per source, so
  // retaining them separately costs almost nothing and keeps a report readable.
  origins: [],
  // Last observed sign of life from the scrape loop, refreshed by every overlay
  // paint (see updateOverlay below). Distinct from `active`, which only moves on
  // telemetry PHASES — and Glassdoor's per-card description walk emits no phase
  // on its success path, so `active` legitimately sits on `page-extract` for
  // minutes while the walk is healthy. Without this, a healthy walk and a wedged
  // renderer are the same observation: silence.
  beat: null,
  // What the scrape loop is awaiting right now, and since when. A bug report
  // written mid-walk otherwise names the last COMPLETED phase and leaves the
  // in-flight operation — the one that is actually slow — unnamed.
  inFlight: null,
  // The Chrome the manual scraper launched for itself. scrapeManualSources
  // closes the shared stealthBrowser singleton and spawns its own process, so
  // the singleton-derived "scrape browser" line in a bug report reads "not
  // running" while this one is very much running on the same profile.
  browser: null,
  // Per-source "scrape pace": WHERE a slow run's wall time went, keyed by
  // sourceId. A real ZipRecruiter run (2026-11-10) took 15 minutes to open 16
  // detail pages because Cloudflare served a verification check on 9 of them, and
  // the only way to see that was counting individual log lines by hand. Counts
  // and durations only — no URL, no job title. Reset per source at source start.
  pace: {},
};

// Renderer sink for mid-walk progress, installed per run by scrapeManualSources.
// The module never imports Electron or reaches for a webContents itself — the
// orchestrator owns which node the events belong to.
export const activitySinkState = { sink: null, lastEmitAt: 0, lastEmitKey: null };
