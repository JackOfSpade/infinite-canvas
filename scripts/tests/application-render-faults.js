import { __writeVerifyRenderPhaseForTests, __setLocalAiRenderPdfForTests, PDFLib, __holdWriteVerifyRenderForTests, __readWriteVerifyRenderHoldForTests, fs, os, path, classifyRenderFaults, renderDocumentsWithHostRetry, fitRejectionMessage, hostOwnedPunctuationFaults, hostOwnedPunctuationMessage, fitMeasurement, sameFitMeasurement, recordPasteHandoffDiagnostic, getPasteHandoffDiagnosticsSnapshot, buildPasteHandoffDiagnosticsMarkdown, _resetPasteHandoffDiagnostics } from '../test-dependencies.js';
import { assert } from './testHelpers.js';
const clean = () => ({ pageCount: 1, fontsLoaded: true, bytes: new Uint8Array([1]), layout: { contentHeightPx: 640, typeAreaHeightPx: 800, horizontalOverflowCount: 0 } });
export default [
  { name: 'Application v2 held renders have explicit source-free diagnostics and stop before rejection bookkeeping', run() {
    _resetPasteHandoffDiagnostics();
    try {
      recordPasteHandoffDiagnostic({ stage: 'convert', outcome: 'held', reason: 'RENDER_UNAVAILABLE', revision: 7, logCount: 9 });
      const snapshot = getPasteHandoffDiagnosticsSnapshot();
      assert(snapshot.receipts[0].outcome === 'held' && snapshot.receipts[0].reason === 'RENDER_UNAVAILABLE', 'held is a distinct diagnostic outcome');
      const report = buildPasteHandoffDiagnosticsMarkdown();
      assert(report.includes('0 rejected') && report.includes('1 held') && report.includes('RENDER_UNAVAILABLE'), 'report counts a host hold separately');
      const source = fs.readFileSync(path.resolve('electron/ipc/localAiApplication.js'), 'utf8');
      const submit = source.slice(source.indexOf('async function submitWriteVerifyHandoff('));
      const holdAt = submit.indexOf('if (gate?.renderFault)');
      const acceptAt = submit.indexOf('if (!errors.length && gate && !hostFault)');
      const bookkeepingAt = submit.indexOf('if (!errors.length) work.lastCorrections');
      assert(holdAt >= 0 && holdAt < acceptAt && holdAt < bookkeepingAt && submit.slice(holdAt, acceptAt).includes('throw new ApplicationV2RenderUnavailableError'), 'host holds precede model rejection accounting');
      assert(submit.includes("type: 'write-verify-render-held'") && submit.includes("candidate.dropReason = ['fit-no-progress']") && submit.includes('...(measured ? { measured } : {})'), 'generation log includes holds and unchanged fit measurements stop the candidate');
    } finally { _resetPasteHandoffDiagnostics(); }
  } },

  { name: 'Application v2 default render phase converts actual layout issue objects into width measurements', async run() {
    const pdf = await PDFLib.PDFDocument.create(); pdf.addPage([612, 792]); const bytes = Buffer.from(await pdf.save());
    __setLocalAiRenderPdfForTests(async () => ({ bytes, pageCount: 1, fontsLoaded: true, missingFontFaces: [],
      layout: { contentHeightPx: 900, typeAreaHeightPx: 1000, lineHeightPx: 14, horizontalOverflowCount: 3, maxHorizontalOverflowPx: 12.4 } }));
    try {
      const result = await __writeVerifyRenderPhaseForTests({
        html: '<main class="page"><section class="section"><article class="role"><span class="title">Engineer</span><span class="company">Synthetic</span><ul class="highlights"><li>Built synthetic systems.</li></ul></article></section></main>',
        letter: { name: 'Synthetic', contact: [], salutation: 'Dear Hiring Team,', paragraphs: ['I built synthetic systems.'], closing: 'Sincerely,' },
        input: { job: { title: 'Engineer', company: 'Synthetic' }, sourceRoles: [] }, renderState: { selectedRoleIds: [] },
      });
      assert(result.kind === 'fit', 'real render path produces fit feedback');
      assert(result.fitErrors[0].includes('has text extending beyond the printable width by up to 12.4px') && !result.fitErrors[0].includes('[object Object]'), 'format layout issue objects');
    } finally { __setLocalAiRenderPdfForTests(null); }
  } },

  { name: 'Application v2 host retry stops at the first good render and never retries punctuation', async run() {
    for (const succeeds of [true, false]) {
      let calls = 0;
      const result = await renderDocumentsWithHostRetry(async () => { calls++; return { resumeFit: calls === 3 && succeeds ? clean() : { renderError: 'synthetic failure' }, letterFit: clean() }; });
      assert(calls === 3 && result.hostRenders === 3, 'at most three host render attempts');
      assert(result.transient.length === (succeeds ? 0 : 1), 'retain unresolved fault');
    }
    let calls = 0;
    const phase = await __writeVerifyRenderPhaseForTests({ render: async () => { calls++; return { resumeFit: { renderError: 'Résumé copy contains a semicolon.' }, letterFit: clean() }; } });
    assert(calls === 1 && phase.kind === 'host-fault', 'punctuation stops without re-rendering');
  } },
  { name: 'Application v2 render faults distinguish unavailable fonts page counts and exceptions', run() {
    for (const [fit, expected] of [[{ renderError: 'synthetic failure' }, 'render-error'], [{ fontsLoaded: false }, 'fonts-not-loaded'], [{ fontsLoaded: true, pageCount: null }, 'page-count-unavailable']]) {
      const result = classifyRenderFaults({ resumeFit: fit, letterFit: clean() });
      assert(result.transient[0].code === expected, 'stable render fault code');
    }
  } },
  { name: 'Application v2 fit feedback omits unsupported overflow claims and detects unchanged measurements', run() {
    const resumeFit = { ...clean(), pageCount: 2, layout: { contentHeightPx: 900, typeAreaHeightPx: 1000 } };
    const message = fitRejectionMessage({ resumeFit, letterFit: clean() });
    assert(message.includes('content spans 90%') && !message.includes('lines ('), 'screen ratio below one does not claim zero printed overflow');
    assert(!/fit-feedback|Local AI|revision|\[object Object\]/u.test(message), 'only measured facts and the operation');
    const measured = fitMeasurement({ resumeFit, letterFit: clean() });
    assert(sameFitMeasurement(measured, structuredClone(measured)), 'identical measurements cannot justify another round');
    const changed = structuredClone(measured); changed.resume.contentHeightPx += 2;
    assert(!sameFitMeasurement(measured, changed), 'a material height change is progress');
    changed.resume.contentHeightPx -= 1;
    assert(sameFitMeasurement(measured, changed), 'one pixel is measurement tolerance');
  } },
  { name: 'Application v2 host punctuation names paths and excludes source values', run() {
    const faults = hostOwnedPunctuationFaults({ sourceRoles: [{ id: 'role-1', title: 'Synthetic - title', company: 'Synthetic; company', location: `Synthetic${String.fromCharCode(0x2014)}location` }],
      identity: { name: 'Synthetic; name', subtitleRole: 'Synthetic - role', credential: 'Synthetic; credential', contact: ['Synthetic; contact'] },
      recordFields: [{ path: 'education[e1].institution', text: 'Synthetic; institution' }] });
    const message = hostOwnedPunctuationMessage(faults);
    assert(faults.length === 8 && message.includes('identity.credential') && message.includes('roles[role-1].title') && message.includes('education[e1].institution'), 'cover every host-owned rendered field');
    assert(!message.includes('Synthetic'), 'messages carry paths and mark names only');
  } },
  { name: 'Application v2 render hold round-trips and refuses stale or altered answers', async run() {
    const dir = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'application-hold-')));
    const state = { stage: 'convert', revision: 7, handoffCode: 'hold-code' };
    const args = { dir, jobId: path.basename(dir), state, stage: state.stage, candidateId: 'candidate-1', rawText: '{"synthetic":true}',
      renderFault: { faults: [{ document: 'resume', code: 'fonts-not-loaded', detail: 'synthetic' }], hostRenders: 3 } };
    try {
      await __holdWriteVerifyRenderForTests(args);
      assert((await __readWriteVerifyRenderHoldForTests(dir, state)).response === args.rawText, 'held response is exact');
      for (const changed of [{ ...state, revision: 8 }, { ...state, handoffCode: 'new-code' }]) {
        await __holdWriteVerifyRenderForTests(args);
        assert(await __readWriteVerifyRenderHoldForTests(dir, changed) === null, 'stale envelope invalidates hold');
        assert(!fs.existsSync(path.join(dir, 'render-hold.json')), 'stale hold removed');
      }
      await __holdWriteVerifyRenderForTests(args);
      const hold = JSON.parse(await fs.promises.readFile(path.join(dir, 'render-hold.json'), 'utf8')); hold.response = 'altered';
      await fs.promises.writeFile(path.join(dir, 'render-hold.json'), JSON.stringify(hold));
      assert(await __readWriteVerifyRenderHoldForTests(dir, state) === null, 'response hash protects replay');
    } finally { await fs.promises.rm(dir, { recursive: true, force: true }); }
  } },

  { name: 'Application v2 fit correction states measured overflow without object coercion or importer instructions', async run() {
    const result = await __writeVerifyRenderPhaseForTests({ render: async () => ({ resumeFit: { ...clean(), pageCount: 2,
      layout: { contentHeightPx: 1200, typeAreaHeightPx: 1000, lineHeightPx: 14 },
      layoutIssues: [{ id: 'horizontal-overflow', count: 3, maxOverflowPx: 12.4 }] }, letterFit: clean() }) });
    assert(!result.fitErrors[0].includes('[object Object]'), 'layout objects must become measured feedback');
    assert(!result.fitErrors[0].includes('fit-feedback.json'), 'fit correction must not name importer files');
    assert(result.fitErrors[0].includes('résumé measured 2 pages (target 1), content spans 120% of the type area on screen, about 15 lines (200px) over'), 'give the measured operation size');
  } },
  { name: 'Application v2 unavailable renderer is a host fault instead of a model fit rejection', async run() {
    const result = await __writeVerifyRenderPhaseForTests({ render: async () => ({ resumeFit: { pageCount: null, fontsLoaded: false }, letterFit: clean() }) });
    assert(result.kind === 'render-fault', 'host unavailable must not consume a model correction');
  } },
];
