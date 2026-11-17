// Offline replay of recorded cover-letter conversions through the per-paragraph
// source-grounding check, to measure a gate change before it ships.
//
//   node --import ./scripts/test-stubs/register.mjs scripts/application-grounding-replay.mjs <claude-runs dir> <out.json>
//
// <claude-runs dir> is a canvas folder's private .local-ai/claude-runs (one
// <jobId>.jsonl per job: every prompt, reply and host verdict). Run it on the
// old and the new code and compare the two outputs. SINCE=<date> limits the
// jobs by file time (default 2026-11-01). The employer-attribution check needs
// the frozen career authority, which a run log does not hold, so its findings
// ("attributes work to") are replay artifacts: leave them out of a comparison.
// Nothing is written but <out.json>, which holds letter prose: keep it private.
import fs from 'node:fs';
import path from 'node:path';
const repo = process.cwd();
const { __pasteUnitGroundingErrorsForTests: check } = await import(path.join(repo, 'electron/ipc/localAiApplication.js'));
const [dir, out] = process.argv.slice(2);
if (!dir || !out) { console.error('usage: application-grounding-replay.mjs <claude-runs dir> <out.json>'); process.exit(2); }
const since = Date.parse(process.env.SINCE || '2026-11-01');
const cases = [];
for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'))) {
  const full = path.join(dir, file);
  if (fs.statSync(full).mtimeMs < since) continue;
  const rows = fs.readFileSync(full, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const byRun = new Map();
  for (const r of rows) { if (!byRun.has(r.runId)) byRun.set(r.runId, {}); byRun.get(r.runId)[r.event] = r; }
  for (const run of byRun.values()) {
    const { started, response, submission } = run;
    if (!started || !response || !submission || started.stage !== 'convert') continue;
    const prompt = started.prompt;
    let parsed; try { parsed = JSON.parse(response.answer.replace(/^```json\s*/u, '').replace(/```\s*$/u, '')); } catch { continue; }
    const paragraphs = parsed?.coverLetter?.paragraphs; if (!Array.isArray(paragraphs)) continue;
    const catalogAt = prompt.indexOf('FULL APPROVED CATALOG'); const catalogEnd = prompt.indexOf('INDEX-ELIGIBLE SKILLS');
    const catalog = prompt.slice(catalogAt, catalogEnd);
    const acceptedEvidence = [];
    for (const m of catalog.matchAll(/^\[(host\.career\.[^\]]+)\] (.*)$/gmu)) acceptedEvidence.push({ id: m[1], sourceId: 'career-data', quote: m[2] });
    const postingAt = prompt.indexOf('FROZEN POSTING:'); const postingEnd = prompt.indexOf('FROZEN REQUIREMENTS AND LISTING QUOTES');
    const postingText = prompt.slice(postingAt + 15, postingEnd);
    const company = (postingText.match(/\*\*Company:\*\* (.*)/u) || [])[1] || '';
    const title = (postingText.match(/^# (.*)/mu) || [])[1] || '';
    let trusted = {}; try { const t = prompt.slice(prompt.indexOf('TRUSTED IDENTITY AND ROLE FIELDS:') + 33, prompt.indexOf('TRUSTED EDUCATION AND CREDENTIAL FIELDS')); trusted = JSON.parse(t); } catch { /* no trusted block in this prompt */ }
    const recorded = (submission.submit?.validationErrors || []).filter(e => /^unit-source-grounding: Cover-letter paragraph/u.test(e));
    const replayed = [];
    paragraphs.forEach((p, index) => {
      let errors;
      try { errors = check({ unitLabel: 'Cover-letter paragraph', unitId: p.id, finalText: p.text, evidenceIds: p.evidenceIds, acceptedEvidence,
        identityTokens: [], label: 'coverLetterParagraphs', sourceRoles: trusted.sourceRoles || [], targetCompany: company.replace(/\\/gu, ''), targetTitle: title, postingText, paragraphIndex: index }); }
      catch (error) { errors = [`THROW ${error.message}`]; }
      for (const e of errors) replayed.push(`unit-source-grounding: ${e}`.replace(/^unit-source-grounding: unit-source-grounding: /u, 'unit-source-grounding: '));
    });
    cases.push({ job: file.slice(0, 8), at: started.at, recorded, replayed, paragraphs: paragraphs.map(p => ({ id: p.id, text: p.text, evidenceIds: p.evidenceIds })) });
  }
}
fs.writeFileSync(out, JSON.stringify(cases, null, 1));
const norm = e => e.replace(/\s+/gu, ' ').slice(0, 140);
const graded = list => list.filter(e => !e.includes('attributes work to'));
let same = 0, rec = 0, rep = 0, failing = 0;
for (const c of cases) {
  const a = new Set(c.recorded.map(norm)); const b = new Set(graded(c.replayed).map(norm));
  rec += a.size; rep += b.size; if (b.size) failing += 1;
  for (const x of a) if (b.has(x)) same += 1;
}
console.log(`conversions ${cases.length} · recorded letter findings ${rec} · replayed ${rep} (of the recorded, ${same} reproduced) · conversions with a letter finding ${failing}`);
