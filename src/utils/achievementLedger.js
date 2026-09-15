// Pure deterministic checks for the résumé Achievement Ledger (design doc
// docs/resume-achievement-mining-design.md §3.4). The miner (Opus, job-
// independent) proposes joins across the career-data corpus; this module
// verifies and annotates them with code, never gates on the result, and never
// deletes an item. "Nothing gates" is a hard rule from the design — a failed
// check demotes confidence and appends a machine-readable flag, that's all.
//
// Kept dependency-free (no electron/fs/network) so scripts/test-runner.js can
// exercise it directly, matching src/utils/bundlePricing.js and
// src/utils/jobIdentity.js.

export const LEDGER_VERSION = 1;
// Post-refute cap (§3.5) — applied in applyRefuteVerdicts, AFTER verdicts are
// applied, never at mining time. Mining is asked for more than this (see
// MINING_TARGET) so the refute pass has room to drop items without thinning
// the ledger below what a tailored résumé can draw on.
export const LEDGER_CAP = 30;
// What the mining prompt is instructed to return (§3.3) — informational here;
// the prompt-construction code (electron/ipc side) is the actual consumer.
export const MINING_TARGET = 40;

// ---------------------------------------------------------------------------
// Corpus splitting
// ---------------------------------------------------------------------------

// Matches a delimiter line of the form "===== FILE: <name> =====", tolerant
// of the variation career-file-extract's own output and hand-edited corpora
// can introduce: any run length of '=', optional spacing around "FILE:", and
// case ("FILE" / "File" / "file"). `\r?$` absorbs Windows line endings so a
// corpus round-tripped through Notepad doesn't stop matching.
const FILE_DELIMITER_RE = /^[ \t]*=+[ \t]*FILE[ \t]*:[ \t]*(.+?)[ \t]*=+[ \t]*\r?$/gim;

/**
 * Split concatenated multi-file career data into per-file sections, keyed by
 * the file name each `===== FILE: <name> =====` delimiter names. Text before
 * the first delimiter (or the whole corpus, if there are no delimiters at
 * all — e.g. a single-file drop, or a corpus assembled before this delimiter
 * convention existed) is kept under the '' key so evidence-file matching
 * still has something to check against instead of silently finding nothing.
 *
 * @param {string} careerData
 * @returns {Map<string, string>} fileName -> section text (trimmed)
 */
export function splitCareerDataByFile(careerData) {
  const text = typeof careerData === 'string' ? careerData : '';
  const sections = new Map();
  if (!text) return sections;

  const matches = [...text.matchAll(FILE_DELIMITER_RE)];
  if (matches.length === 0) {
    sections.set('', text.trim());
    return sections;
  }

  const firstStart = matches[0].index;
  if (firstStart > 0) {
    const preamble = text.slice(0, firstStart).trim();
    if (preamble) sections.set('', preamble);
  }

  for (let i = 0; i < matches.length; i += 1) {
    const match = matches[i];
    const name = match[1].trim();
    const contentStart = match.index + match[0].length;
    const contentEnd = i + 1 < matches.length ? matches[i + 1].index : text.length;
    const content = text.slice(contentStart, contentEnd).trim();
    // A repeated file name (e.g. career-file-extract re-run on the same file
    // within one corpus) appends rather than overwrites, so evidence matching
    // still sees the earlier half instead of losing it silently.
    sections.set(name, sections.has(name) ? `${sections.get(name)}\n${content}` : content);
  }
  return sections;
}

// Case-insensitive fallback lookup: the model occasionally emits a file name
// that differs from the delimiter only in case. Falling back here keeps a
// harmless case mismatch from being misreported as evidence-wrong-file.
function getNamedSection(sections, fileName) {
  if (!fileName) return null;
  if (sections.has(fileName)) return sections.get(fileName);
  const lower = fileName.toLowerCase();
  for (const [name, text] of sections) {
    if (name.toLowerCase() === lower) return text;
  }
  return null;
}

/**
 * Whitespace normalization used for the evidence substring check. Case is
 * deliberately preserved (NOT lowercased) — evidence quotes are supposed to
 * be VERBATIM spans (§3.2), so folding case would let a quote that merely
 * resembles the source text pass as a match. Only collapsing whitespace
 * absorbs the harmless variation a model round-trip introduces (a wrapped
 * line, a doubled space, a trailing newline).
 */
export function normalizeQuoteText(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Date sanity (§3.4 item 3) — light and advisory, never demotes confidence.
// ---------------------------------------------------------------------------

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_YEAR_RE = /^([A-Za-z]{3,9})\.?\s+(\d{4})$/;
const YEAR_ONLY_RE = /^(\d{4})$/;
const MONTH_NAMES = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11,
};
// Same three shapes as the anchored parser above, unanchored, for scanning a
// whole corpus to find its overall date span.
const DATE_SCAN_RE = /\b\d{4}-\d{2}-\d{2}\b|\b[A-Za-z]{3,9}\.?\s+(?:19|20)\d{2}\b|\b(?:19|20)\d{2}\b/g;

// Handles 4-digit years, "Mon YYYY" / "Month YYYY", and ISO dates. Anything
// else (quarters, fiscal years, "present", free text) gives up quietly and
// returns null rather than guessing — this check is advisory, not a parser
// the rest of the ledger depends on.
function parseLooseDate(label) {
  const s = String(label || '').trim();
  if (!s) return null;

  let m = s.match(ISO_DATE_RE);
  if (m) {
    const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    return Number.isNaN(d.getTime()) ? null : d;
  }

  m = s.match(MONTH_YEAR_RE);
  if (m) {
    const month = MONTH_NAMES[m[1].slice(0, 3).toLowerCase()];
    if (month === undefined) return null;
    return new Date(Date.UTC(Number(m[2]), month, 1));
  }

  m = s.match(YEAR_ONLY_RE);
  if (m) return new Date(Date.UTC(Number(m[1]), 0, 1));

  return null;
}

// Approximate [min, max] date span the corpus itself spans, from every
// parseable date found anywhere in the text (not just metric labels). Used
// only to sanity-check that a metric's dates plausibly belong to this
// candidate's history, not to validate individual documents.
function extractDateSpan(text) {
  if (!text) return null;
  const found = text.match(DATE_SCAN_RE) || [];
  let min = null;
  let max = null;
  for (const raw of found) {
    const d = parseLooseDate(raw);
    if (!d) continue;
    if (min === null || d < min) min = d;
    if (max === null || d > max) max = d;
  }
  return min && max ? { min, max } : null;
}

// A year of slack absorbs "as of" / partial-year labels landing just outside
// the scanned span (e.g. a fiscal year label the scanner didn't pick up)
// without flagging every edge date as bogus — this check is advisory.
const DATE_SPAN_SLACK_MS = 366 * 24 * 60 * 60 * 1000;

function checkDateSanity(metric, corpusSpan) {
  const baselineDate = parseLooseDate(metric?.baselineLabel);
  const endpointDate = parseLooseDate(metric?.endpointLabel);
  if (!baselineDate && !endpointDate) return true; // nothing parseable — nothing to check

  let ok = true;
  if (baselineDate && endpointDate && metric?.direction !== 'flat' && baselineDate > endpointDate) {
    ok = false; // endpoint dated chronologically before baseline
  }
  if (corpusSpan) {
    const lo = corpusSpan.min.getTime() - DATE_SPAN_SLACK_MS;
    const hi = corpusSpan.max.getTime() + DATE_SPAN_SLACK_MS;
    if (baselineDate && (baselineDate.getTime() < lo || baselineDate.getTime() > hi)) ok = false;
    if (endpointDate && (endpointDate.getTime() < lo || endpointDate.getTime() > hi)) ok = false;
  }
  return ok;
}

// ---------------------------------------------------------------------------
// Arithmetic (§3.4 item 1) — mirrors the bundle-pricing discipline at
// bundlePricing.js:397-434: the model returns attributable factors (here,
// raw metric endpoints), code derives every number and the final
// human-readable string. The model NEVER supplies delta/pct/display.
// ---------------------------------------------------------------------------

const COMPACT_CURRENCY_FORMATTER = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  notation: 'compact',
  maximumFractionDigits: 1,
});

function formatCompactCurrency(value) {
  return COMPACT_CURRENCY_FORMATTER.format(value);
}

function formatPlainNumber(value) {
  const rounded = Math.round(value * 100) / 100;
  return rounded.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

// Whole-number percentages read naturally on a résumé ("74%"); a genuinely
// small change (e.g. 0.4%) would otherwise round away to "0%", which reads as
// "no change", so fall back to one decimal only in that case.
function formatPercentMagnitude(value) {
  const magnitude = Math.abs(value);
  const whole = Math.round(magnitude);
  if (whole > 0 || magnitude === 0) return `${whole}%`;
  return `${Math.round(magnitude * 10) / 10}%`;
}

// '%' and other free-form units (ms, people, ...) "render naturally" per the
// design; only USD gets compact notation ($4.2M). An unrecognized unit falls
// through to "<number> <unit>" rather than throwing.
function formatUnitValue(value, unit) {
  if (unit === 'USD') return formatCompactCurrency(value);
  if (unit === '%') return `${formatPlainNumber(value)}%`;
  if (unit === 'ms') return `${formatPlainNumber(value)}ms`;
  const plain = formatPlainNumber(value);
  return unit ? `${plain} ${unit}` : plain;
}

function isNumericMetric(metric) {
  // Schema-forced output should always be a real boolean; tolerate the
  // string 'true' defensively rather than trusting the model's JSON shape.
  return metric?.isNumeric === true || metric?.isNumeric === 'true';
}

/**
 * Derive computed.delta/pct/display from a raw `metric` object. Three edge
 * cases are handled explicitly because each one otherwise reaches the résumé
 * as a wrong number (design §3.4 item 1):
 *  - isNumeric === false: skip arithmetic entirely (metric's numeric fields
 *    are 0 by schema convention — computing blindly here yields 0 and NaN).
 *  - baselineValue === 0: percentage change is undefined; pct stays null and
 *    display shows the absolute delta only.
 *  - metric.direction disagreeing with the sign of the derived delta: trust
 *    the numbers, flag it, and let the caller demote confidence to 'low'
 *    rather than silently "fixing" the direction.
 */
function computeMetricArithmetic(metric) {
  if (!isNumericMetric(metric)) {
    return { isNumeric: false, delta: null, pct: null, display: '', directionMismatch: false };
  }

  const rawBaseline = Number(metric.baselineValue);
  const rawEndpoint = Number(metric.endpointValue);
  const baseline = Number.isFinite(rawBaseline) ? rawBaseline : 0;
  const endpoint = Number.isFinite(rawEndpoint) ? rawEndpoint : 0;
  const delta = endpoint - baseline;
  const unit = typeof metric.unit === 'string' ? metric.unit : '';

  const pct = baseline !== 0 ? (delta / Math.abs(baseline)) * 100 : null;

  const deltaSign = delta > 0 ? 'increase' : delta < 0 ? 'decrease' : 'flat';
  const declaredDirection = ['increase', 'decrease', 'flat'].includes(metric.direction) ? metric.direction : null;
  const directionMismatch = declaredDirection !== null && declaredDirection !== deltaSign;

  const journey = `${formatUnitValue(baseline, unit)} → ${formatUnitValue(endpoint, unit)}`;
  const display = pct !== null
    ? `${formatPercentMagnitude(pct)} (${journey})`
    : `${formatUnitValue(Math.abs(delta), unit)} (${journey})`;

  return { isNumeric: true, delta, pct, display, directionMismatch };
}

// ---------------------------------------------------------------------------
// Claim/figure separation (§3.2) — telemetry only, NOT one of the four §3.4
// checks. §3.2's whole trust model is "the model authors prose, code authors
// every number" — a `claim` that already contains the derived figure makes an
// arithmetic slip structurally UNABLE to reach the output, because the model
// never gets to write a number the résumé will print. But nothing downstream
// of computeLedger enforces that separation: if the miner disobeys and writes
// the figure into `claim` anyway (exactly what a model trained on résumé
// prose drifts toward), that model-authored number flows into the résumé
// prompt as claim text, gets copied to the output, and — because it didn't
// come through `computed.display` — carries no data-achievement-id and so no
// receipt/tooltip. Under Jack's stated review model (a light wording glance,
// not a numbers audit), a plausible-looking wrong number with no tooltip is
// invisible. This is the one place that failure can be caught, so it is
// measured here even though — per the design's "nothing gates" rule, which
// applies to this check exactly like the four in §3.4 — it must never demote
// confidence, edit `claim`, or drop the item. A false positive only costs one
// misleading telemetry line (cheap); a chatty detector trains the reader to
// ignore the signal, so every candidate below is built to be conservative.
// ---------------------------------------------------------------------------

// Digit-only candidates need at least two digits to count as "reasonably
// distinctive" — a bare "0" or "1" shows up in ordinary claim prose for
// reasons that have nothing to do with the derived figure (a single hire, "a
// culture initiative", list markers), so flagging on those would be pure
// noise rather than signal.
function isDistinctiveDigitToken(s) {
  return (s.match(/[0-9]/g) || []).length >= 2;
}

function buildFigureCandidates(metric, arithmetic) {
  const candidates = new Set();
  const unit = typeof metric?.unit === 'string' ? metric.unit : '';

  const addNumeric = (value) => {
    if (!Number.isFinite(value)) return;
    const plain = formatPlainNumber(Math.abs(value)); // raw baseline/endpoint/delta, e.g. "40"
    if (isDistinctiveDigitToken(plain)) candidates.add(plain);
    if (unit === 'USD') {
      const compact = formatCompactCurrency(Math.abs(value)); // "$4.2M"
      if (isDistinctiveDigitToken(compact)) {
        candidates.add(compact);
        candidates.add(compact.replace(/^\$/, '')); // "4.2M" — prose often drops the '$'
      }
    }
  };
  addNumeric(Number(metric?.baselineValue));
  addNumeric(Number(metric?.endpointValue));
  if (arithmetic.delta !== null) addNumeric(arithmetic.delta);

  if (arithmetic.pct !== null) {
    const whole = String(Math.round(Math.abs(arithmetic.pct)));
    if (isDistinctiveDigitToken(whole)) {
      candidates.add(whole); // "74"
      candidates.add(`${whole}%`); // "74%"
    }
  }

  // A year already present in the metric's own baseline/endpoint label (e.g.
  // baselineLabel "2019") is normal prose ("...since 2019") if it happens to
  // numerically collide with a candidate above — it's the claim quoting its
  // own timeframe, not the forbidden derived figure, so it must not count as
  // a leak.
  for (const label of [metric?.baselineLabel, metric?.endpointLabel]) {
    const m = String(label || '').match(/\b(?:19|20)\d{2}\b/);
    if (m) candidates.delete(m[0]);
  }

  return candidates;
}

// Only computed here (not in computeMetricArithmetic) because this is a
// prompt-compliance signal on `item.claim`, not part of the arithmetic
// derivation itself — keeping it separate keeps computeMetricArithmetic pure
// over `metric` alone, with no knowledge of the achievement it's attached to.
function checkClaimFigureLeak(item, metric, arithmetic) {
  if (!arithmetic.isNumeric) return false; // no derived figure exists to leak
  const claim = normalizeQuoteText(item?.claim);
  if (!/[0-9]/.test(claim)) return false; // nothing digit-bearing to collide with
  const candidates = buildFigureCandidates(metric, arithmetic);
  for (const candidate of candidates) {
    if (claim.includes(candidate)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Evidence presence (§3.4 item 2)
// ---------------------------------------------------------------------------

function checkEvidence(item, sections, fullText) {
  const evidenceList = Array.isArray(item?.evidence)
    ? item.evidence.filter((ev) => ev && typeof ev === 'object')
    : [];
  if (evidenceList.length === 0) {
    return { evidenceOk: false, flags: ['evidence-miss'], hasMiss: true };
  }

  let evidenceOk = true;
  let hasMiss = false;
  const flags = [];
  for (const ev of evidenceList) {
    const quote = normalizeQuoteText(ev.quote);
    const fileName = typeof ev.file === 'string' ? ev.file.trim() : '';
    if (!quote) {
      evidenceOk = false;
      hasMiss = true;
      flags.push('evidence-miss');
      continue;
    }
    const namedSection = getNamedSection(sections, fileName);
    if (namedSection && normalizeQuoteText(namedSection).includes(quote)) continue; // strongest case: named file matches

    evidenceOk = false;
    if (normalizeQuoteText(fullText).includes(quote)) {
      if (fileName) {
        // Real quote, wrong document — a mis-derivation worth catching, which
        // is what makes `file` load-bearing rather than decorative (design
        // §3.4.2).
        flags.push('evidence-wrong-file');
      } else {
        // Real quote, but no file was named at all — distinct from the case
        // above: nothing was actually asserted wrong, so don't accuse a
        // specific (nonexistent) document of being the wrong one.
        flags.push('evidence-file-missing');
      }
    } else {
      flags.push('evidence-miss');
      hasMiss = true;
    }
  }
  return { evidenceOk, flags, hasMiss };
}

function dedupeFlags(flags) {
  return [...new Set(flags)];
}

// ---------------------------------------------------------------------------
// Public: computeLedger
// ---------------------------------------------------------------------------

/**
 * Run every deterministic check over the miner's raw output and attach
 * `computed` + `flags` to each achievement. Never deletes an item — checks
 * demote confidence and annotate, they do not gate (design §3.4, "nothing
 * gates" is a hard rule stated three separate times in the source doc).
 *
 * @param {{achievements: Array, gaps: Array}} raw  the miner's forced-JSON output
 * @param {string} careerData
 * @returns {{ledger: Array, gaps: Array, stats: {mined:number, demotedByCheck:number, evidenceMisses:number, dateMisses:number, directionMisses:number, claimFigureLeaks:number}}}
 */
export function computeLedger(raw, careerData) {
  const sections = splitCareerDataByFile(careerData);
  const fullText = typeof careerData === 'string' ? careerData : '';
  const corpusSpan = extractDateSpan(fullText);

  const achievements = Array.isArray(raw?.achievements) ? raw.achievements : [];
  const gaps = (Array.isArray(raw?.gaps) ? raw.gaps : []).filter((g) => g && typeof g === 'object');

  // claimFigureLeaks: telemetry for the §3.2 claim/figure-separation check
  // above — deliberately NOT folded into demotedByCheck, because (per the
  // "nothing gates" rule that applies to this signal too) a hit never demotes
  // confidence, so counting it there would misreport how many items were
  // actually weakened.
  const stats = { mined: 0, demotedByCheck: 0, evidenceMisses: 0, dateMisses: 0, directionMisses: 0, claimFigureLeaks: 0 };
  const ledger = [];

  for (const item of achievements) {
    if (!item || typeof item !== 'object') continue;

    const flags = [];
    let confidence = ['high', 'medium', 'low'].includes(item.confidence) ? item.confidence : 'medium';
    let demoted = false;

    // 1. Arithmetic
    const metric = item.metric && typeof item.metric === 'object' ? item.metric : {};
    const arithmetic = computeMetricArithmetic(metric);
    if (arithmetic.directionMismatch) {
      flags.push('direction-mismatch');
      confidence = 'low';
      demoted = true;
      stats.directionMisses += 1;
    }

    // 2. Evidence presence
    const evidenceCheck = checkEvidence(item, sections, fullText);
    flags.push(...evidenceCheck.flags);
    if (evidenceCheck.hasMiss) {
      confidence = 'low';
      demoted = true;
      stats.evidenceMisses += 1;
    }

    // 3. Date sanity — advisory only, never demotes confidence.
    const datesOk = checkDateSanity(metric, corpusSpan);
    if (!datesOk) {
      flags.push('date-out-of-range');
      stats.dateMisses += 1;
    }

    // 4. Attribution consistency — `context` items pass through untouched
    // (via the spread below); the résumé prompt reads `attribution` directly
    // to phrase them as context rather than a personal win (design §3.4.4).
    // No additional flag/demotion: this is a phrasing instruction downstream,
    // not a failed check.

    // 5. Claim/figure separation (§3.2, telemetry only — see the doc comment
    // on checkClaimFigureLeak above for the full silent-failure chain this
    // guards against). Deliberately does NOT set `demoted` or touch
    // `confidence`/`claim`/the item itself: it is a prompt-compliance signal
    // on the miner's output, not a correctness verdict on the achievement.
    if (checkClaimFigureLeak(item, metric, arithmetic)) {
      flags.push('claim-contains-figure');
      stats.claimFigureLeaks += 1;
    }

    if (demoted) stats.demotedByCheck += 1;

    ledger.push({
      ...item,
      confidence,
      computed: {
        isNumeric: arithmetic.isNumeric,
        delta: arithmetic.delta,
        pct: arithmetic.pct,
        display: arithmetic.display,
        checks: { evidenceOk: evidenceCheck.evidenceOk, datesOk },
      },
      flags: dedupeFlags(flags),
    });
  }

  stats.mined = ledger.length;
  return { ledger, gaps, stats };
}

// ---------------------------------------------------------------------------
// Public: refute pass application
// ---------------------------------------------------------------------------

function demoteConfidenceOneStep(confidence) {
  if (confidence === 'high') return 'medium';
  if (confidence === 'medium') return 'low';
  return 'low';
}

const ATTRIBUTION_VALUES = ['sole', 'led', 'contributed', 'context'];

/**
 * Apply the refuter's verdicts to a checked ledger, then sort by strength and
 * truncate to `opts.cap`. The cap is applied HERE, after refutation — never
 * at mining time (§3.3/§3.5): mining is asked for MINING_TARGET (~40) so the
 * refute pass has room to drop weak items without thinning the ledger below
 * what a tailored résumé can draw on.
 *
 * An id with no verdict (missing, or the refuter emitted an unrecognized
 * `verdict` value) is treated as 'stands' — the refuter attacking every item
 * is best-effort, not a contract, and a silently-dropped id must not read as
 * a silently-dropped achievement.
 *
 * @param {Array} ledger    output of computeLedger().ledger
 * @param {Array} verdicts  the refuter's raw { id, verdict, suggestedAttribution, suggestedCaveat }[]
 * @param {{cap?: number}} opts
 * @returns {{ledger: Array, stats: {droppedByRefute:number, weakened:number}}}
 */
export function applyRefuteVerdicts(ledger, verdicts, opts = {}) {
  const { cap = LEDGER_CAP } = opts || {};
  const safeCap = Number.isFinite(cap) && cap >= 0 ? cap : LEDGER_CAP;

  const verdictById = new Map();
  for (const v of Array.isArray(verdicts) ? verdicts : []) {
    if (v && typeof v === 'object' && typeof v.id === 'string') verdictById.set(v.id, v);
  }

  const stats = { droppedByRefute: 0, weakened: 0 };
  const kept = [];

  for (const item of Array.isArray(ledger) ? ledger : []) {
    if (!item || typeof item !== 'object') continue;
    const verdict = verdictById.get(item.id);
    const verdictType = verdict?.verdict === 'drop' || verdict?.verdict === 'weaken' || verdict?.verdict === 'stands'
      ? verdict.verdict
      : 'stands';

    if (verdictType === 'drop') {
      stats.droppedByRefute += 1;
      continue;
    }

    if (verdictType === 'weaken') {
      stats.weakened += 1;
      const suggestedAttribution = ATTRIBUTION_VALUES.includes(verdict.suggestedAttribution)
        ? verdict.suggestedAttribution
        : item.attribution; // 'unchanged' (or anything else unrecognized) leaves attribution as-is
      const suggestedCaveat = typeof verdict.suggestedCaveat === 'string' ? verdict.suggestedCaveat.trim() : '';
      const caveats = suggestedCaveat
        ? [item.caveats, suggestedCaveat].filter(Boolean).join(' ')
        : (item.caveats || '');
      kept.push({
        ...item,
        attribution: suggestedAttribution,
        caveats,
        confidence: demoteConfidenceOneStep(item.confidence),
        flags: dedupeFlags([...(Array.isArray(item.flags) ? item.flags : []), 'refute-weakened']),
      });
      continue;
    }

    kept.push(item); // 'stands'
  }

  kept.sort((a, b) => (Number(b?.strength) || 0) - (Number(a?.strength) || 0));
  return { ledger: kept.slice(0, safeCap), stats };
}

// ---------------------------------------------------------------------------
// Public: lookups + receipts
// ---------------------------------------------------------------------------

export function ledgerById(ledger) {
  const map = new Map();
  for (const item of Array.isArray(ledger) ? ledger : []) {
    if (item && typeof item.id === 'string') map.set(item.id, item);
  }
  return map;
}

/**
 * The receipt string the résumé post-process (resumeHtml.js, §4.3 step 3)
 * injects into `data-derivation` when it resolves a model-emitted
 * `data-achievement-id`. Combines the code-derived figure, the human-readable
 * join, and any caveat — everything a hover panel needs to make the number
 * trustworthy without a click-through.
 */
export function derivationTooltip(item) {
  if (!item || typeof item !== 'object') return '';
  const computed = item.computed && typeof item.computed === 'object' ? item.computed : null;
  const figure = computed?.isNumeric && computed.display ? computed.display : '';
  const derivation = String(item.derivation || '').trim();
  const caveats = String(item.caveats || '').trim();
  return [figure, derivation, caveats].filter(Boolean).join(' — ');
}

