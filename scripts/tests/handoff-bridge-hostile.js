import { assert } from './testHelpers.js';
import {
  buildResumeDocument,
  fs,
  getLocalApplicationHandoff,
  importLocalApplicationJob,
  JSDOM,
  os,
  path,
  PDFDocument,
  queueLocalApplicationJob,
  sanitizeDocumentMainHtml,
} from '../test-dependencies.js';
import {
  APPLICATION_QUALITY_CHECKLIST_VERSION,
  APPLICATION_QUALITY_CRITERIA,
  __setLocalAiRenderPdfForTests,
  LOCAL_AI_GENERATION_AUDIT_VERSION,
} from '../../electron/ipc/localAiApplication.js';
import { createApplicationSource } from '../../electron/ipc/handoffBridge/sources/application.js';
import { createHandoffCodeGuard } from '../../electron/ipc/handoffBridge/lanes.js';
import { makeRejectedBody, REJECTED_CAUTION } from '../../electron/ipc/handoffBridge/framing.js';

const HOSTILE_DOCUMENT_TEXT = 'Maintained reliable internal systems for users. <script>x()</script><img src=https://example.com/x>javascript:x()url(https://example.com/x)';
const HOSTILE_REJECTED_TEXT = `<script>x()</script><img src=https://example.com/x>javascript:x()url(https://example.com/x) ${'q'.repeat(260)}`;
const HOSTILE_REJECTED_TEXT_TWO = `<script>x()</script><img src=https://example.com/x>javascript:x()url(https://example.com/x) ${'r'.repeat(260)}`;
const HOSTILE_MARKERS = Object.freeze([
  '<script>', '<img src=https://example.com/x>', 'javascript:x()', 'url(https://example.com/x)',
]);
const IDENTITY = Object.freeze({
  name: 'Ada Lovelace', contact: Object.freeze(['ada@example.com']), subtitleRole: 'Engineer', credential: '',
});
const LETTER_SENTENCES = Object.freeze([
  'My experience delivering supported systems is a relevant capability.',
  'In my engineering role at Example Co, I updated supported systems for internal users.',
  'I would apply my experience delivering supported systems to reliable system delivery this role requires.',
]);
const LETTER_TEXT = LETTER_SENTENCES.join(' ');
const CAREER_DATA = [
  'Ada Lovelace', 'ada@example.com', 'Engineer', HOSTILE_DOCUMENT_TEXT, LETTER_TEXT,
].join('\n');
const codeGuard = createHandoffCodeGuard();

function reply(handoff, fields) {
  return {
    protocol: 1,
    jobId: handoff.jobId,
    stage: handoff.stage,
    handoffCode: handoff.handoffCode,
    baseHashes: handoff.baseHashes,
    ...fields,
  };
}

function qualityCriteria() {
  return APPLICATION_QUALITY_CRITERIA.map(({ id, requirement }) => ({ id, status: 'pass', evidence: requirement }));
}

function qualityChecklist() {
  return APPLICATION_QUALITY_CRITERIA.map(({ id }) => ({ id, status: 'pass', detail: `Reviewed ${id} against the final documents.` }));
}

function generationAudit(paragraph, thesis) {
  return {
    version: LOCAL_AI_GENERATION_AUDIT_VERSION,
    jobPriorities: [{
      requirement: 'Reliable system delivery', priority: 'highest', disposition: 'addressed-both',
      justification: 'The selected systems evidence directly addresses the stated delivery requirement.',
    }],
    resumePlan: {
      strategy: 'Lead with the strongest supported systems evidence for the role.',
      selectionRationale: 'The retained role preserves direct factual support and concise relevance.',
    },
    coverLetterPlan: {
      controllingThesis: thesis,
      paragraphs: [{
        paragraph,
        argumentativeJob: 'Establish the controlling evidence-to-need connection.',
        relationToThesis: 'Connect the source-supported proof to reliable system delivery.',
        relationToPreviousParagraph: 'opening',
        sentences: LETTER_SENTENCES.map((sentence, index) => ({
          sentence,
          function: index === 0
            ? 'States the general candidate capability.'
            : (index === 1 ? 'Supplies the source-supported candidate proof.' : 'Connects the proof to the target responsibility.'),
          relationToPreviousSentence: index === 0 ? 'opening' : 'Develops the preceding argument step.',
        })),
        argumentMapping: {
          claim: LETTER_SENTENCES[0], proof: LETTER_SENTENCES[1], relevance: LETTER_SENTENCES[2],
          jobNeedQuote: 'reliable system delivery',
        },
      }],
    },
    finalDecisionSummary: 'The final documents use the strongest supported evidence without introducing a second cover-letter argument.',
  };
}

function hostileMainHtml() {
  return `<main class="page" onclick="x()"><section class="section" style="background-image:url(https://example.com/style.css)"><p onmouseover="x()">${HOSTILE_DOCUMENT_TEXT}</p><script>window.bad=true</script><img src=https://example.com/pixel onerror="x()"><a href="javascript:x()">bad link</a></section></main>`;
}

function withDom(html, fn) {
  const dom = new JSDOM(html);
  try { return fn(dom.window.document); } finally { dom.window.close(); }
}

function activeRemoteReferences(document) {
  const references = [];
  for (const element of document.querySelectorAll('script[src], link[href], img[src], iframe[src], frame[src], object[data], embed[src], source[src], video[src], audio[src], track[src]')) {
    const value = element.getAttribute('src') || element.getAttribute('href') || element.getAttribute('data') || '';
    if (/^https?:\/\//i.test(value)) references.push(value);
  }
  for (const element of document.querySelectorAll('[style], style')) {
    const css = element.getAttribute('style') || element.textContent || '';
    for (const match of css.matchAll(/url\(\s*['"]?\s*(https?:\/\/[^\s'"()]+)\s*['"]?\s*\)/gi)) references.push(match[1]);
  }
  return references;
}

function assertNoActiveHostileMarkup(html, label, { finalDocument = false } = {}) {
  withDom(html, document => {
    const scripts = [...document.querySelectorAll('script')];
    if (finalDocument) {
      assert(scripts.length > 0 && scripts.every(script => script.hasAttribute('nonce') && !script.hasAttribute('src')),
        `${label} must allow only nonce-bound inline host scripts`);
    } else {
      assert(scripts.length === 0, `${label} must contain no script element`);
    }
    const modelSurfaces = finalDocument
      ? [...document.querySelectorAll('.ic-page-stage main.page')]
      : [...document.querySelectorAll('main.page')];
    assert(modelSurfaces.length > 0, `${label} must contain a model document surface`);
    for (const surface of modelSurfaces) {
      assert(surface.querySelectorAll('img, picture, source, iframe, frame, object, embed, form, input, button, textarea, select, svg, math, canvas').length === 0,
        `${label} must contain no model-controlled active element`);
    }
    for (const element of document.querySelectorAll('*')) {
      for (const attribute of element.attributes) {
        assert(!/^on/i.test(attribute.name), `${label} must remove every event-handler attribute`);
        assert(!/^javascript:/i.test(attribute.value), `${label} must remove javascript URLs`);
      }
    }
    const remote = activeRemoteReferences(document);
    assert(remote.every(value => /^https:\/\/(?:fonts\.googleapis\.com|fonts\.gstatic\.com)\//i.test(value)),
      `${label} must not contain non-font remote resource URLs: ${remote.join(', ')}`);
  });
}

function assertHostileMarkers(value, label) {
  for (const marker of HOSTILE_MARKERS) assert(value.includes(marker), `${label} must contain ${marker}`);
}

function assertNoHostileMarkers(value, label) {
  for (const marker of HOSTILE_MARKERS) assert(!value.includes(marker), `${label} must not contain ${marker}`);
}

function modelSurfaceText(html, { finalDocument = false } = {}) {
  return withDom(html, document => {
    const selector = finalDocument ? '.ic-page-stage main.page' : 'main.page';
    const surfaces = [...document.querySelectorAll(selector)];
    assert(surfaces.length > 0, 'saved document must keep a model document surface');
    return surfaces.map(surface => surface.textContent || '').join('\n');
  });
}

function assertQuotedSpansClipped(value, rawSpans, label) {
  for (const raw of rawSpans) {
    const clipped = `${raw.slice(0, 200)}…`;
    assert(value.includes(`"${clipped}"`), `${label} must retain the clipped quoted span`);
    assert(!value.includes(`"${raw}"`), `${label} must not retain the complete quoted span`);
  }
}

function assertCsp(policy) {
  assert(policy.includes("default-src 'none'")
    && /script-src 'nonce-[^']+'/.test(policy)
    && !policy.includes("script-src 'unsafe-inline'")
    && policy.includes("img-src 'none'")
    && policy.includes('connect-src http://127.0.0.1:43192')
    && policy.includes("style-src 'unsafe-inline' https://fonts.googleapis.com")
    && policy.includes('font-src https://fonts.gstatic.com'),
  'print CSP must remain default-deny, nonce-only for scripts, and allow only its font and loopback exceptions');
}

function cspFromDocument(html) {
  return withDom(html, document => document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content') || '');
}

async function makeScratchCanvas() {
  const root = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ic-b-hostile-')));
  const canvasFilePath = path.join(root, 'Canvas.json');
  await fs.promises.writeFile(canvasFilePath, '{}', 'utf8');
  return { root, canvasFilePath };
}

async function queueScratchApplication(canvasFilePath) {
  return queueLocalApplicationJob({
    transport: 'paste',
    canvasFilePath,
    careerData: CAREER_DATA,
    job: { title: 'Engineer', company: 'Example Co', snippet: 'Engineer role focused on reliable system delivery.' },
    resumeProfile: { workHistory: [{ id: 'role-1', title: 'Engineer', employer: 'Example Co', startDate: '', endDate: '' }] },
  });
}

async function adapterSubmit(adapter, lane, fields) {
  const [raw, read] = await Promise.all([
    getLocalApplicationHandoff({ jobId: lane.jobId, canvasFilePath: lane.canvasFilePath }),
    adapter.read(lane),
  ]);
  assert(raw.handoff && read.kind === 'open' && read.handoff.code === raw.handoff.handoffCode,
    'the adapter must read the same current app handoff it submits');
  const text = JSON.stringify(reply(raw.handoff, fields));
  return { text, result: await adapter.submit(lane, { code: raw.handoff.handoffCode, text }) };
}

function hostileEvidencePlan() {
  return {
    identity: IDENTITY,
    evidence: [
      { id: 'hostile-proof', sourceId: 'career-data', quote: HOSTILE_DOCUMENT_TEXT, requirement: 'Reliable system delivery', priority: 'highest' },
      { id: 'letter-proof', sourceId: 'career-data', quote: LETTER_TEXT, requirement: 'Reliable system delivery', priority: 'highest' },
      { id: 'job-proof', sourceId: 'job-listing', quote: 'reliable system delivery', requirement: 'Reliable system delivery', priority: 'highest' },
    ],
    requirements: [{ id: 'need-1', text: 'Reliable system delivery', priority: 'highest', evidenceIds: ['hostile-proof', 'job-proof'] }],
  };
}

function hostileResume() {
  return {
    schemaVersion: 'structured-resume.v1',
    identity: IDENTITY,
    roles: [{
      id: 'role-1', title: 'Engineer', company: 'Example Co', dates: '', location: '',
      bullets: [{ id: 'bullet-1', text: HOSTILE_DOCUMENT_TEXT, evidenceIds: ['hostile-proof'] }],
    }],
    // The hostile quote spells "javascript:" in a URL scheme, which the host's
    // technology vocabulary reads as an attested name, so the résumé owes a block.
    skills: [{ id: 'skill-1', group: 'languages', items: ['JavaScript'], evidenceIds: ['hostile-proof'] }],
  };
}

function safeCoverLetter() {
  return {
    name: IDENTITY.name,
    contact: IDENTITY.contact,
    paragraphs: [{ id: 'paragraph-1', text: LETTER_TEXT, evidenceIds: ['letter-proof', 'job-proof'] }],
    roleThesis: 'Reliable system delivery is the supported capability this engineering role needs.',
    coverLetterArgument: {
      primaryEvidence: {
        evidence: HOSTILE_DOCUMENT_TEXT,
        evidenceRole: 'Engineer at Example Co',
        relationToThesis: 'The systems work establishes the delivery capability named in the thesis.',
      },
    },
  };
}

function passingReview(resume, coverLetter) {
  return {
    decision: 'pass',
    findings: [],
    checklist: qualityChecklist(),
    qualityReview: {
      checklistVersion: APPLICATION_QUALITY_CHECKLIST_VERSION,
      criteria: qualityCriteria(),
      resume: { decision: 'approved', rationale: 'The résumé preserves direct source-supported systems evidence with clear relevance.' },
      coverLetter: { decision: 'approved', rationale: 'One controlling argument uses minimum-sufficient evidence for target system delivery.' },
    },
    generationAudit: generationAudit(coverLetter.paragraphs[0].text, coverLetter.roleThesis),
  };
}

function hostileRejectedAnswer(handoff) {
  const answer = reply(handoff, {
    stage: HOSTILE_REJECTED_TEXT,
    identity: {
      name: HOSTILE_REJECTED_TEXT_TWO,
      contact: [HOSTILE_REJECTED_TEXT],
      subtitleRole: HOSTILE_REJECTED_TEXT_TWO,
      credential: HOSTILE_REJECTED_TEXT,
    },
    evidence: [{
      id: 'hostile-evidence', sourceId: 'career-data', quote: HOSTILE_REJECTED_TEXT_TWO,
      requirement: HOSTILE_REJECTED_TEXT, priority: 'highest',
    }],
    requirements: [{
      id: 'hostile-need', text: HOSTILE_REJECTED_TEXT_TWO, priority: 'highest', evidenceIds: ['hostile-evidence'],
    }],
  });
  for (const field of [
    answer.stage, answer.identity.name, answer.identity.contact[0], answer.identity.subtitleRole,
    answer.identity.credential, answer.evidence[0].quote, answer.evidence[0].requirement, answer.requirements[0].text,
  ]) {
    assert(typeof field === 'string' && field.length > 200, 'every synthetic rejected free-text field must carry a long hostile corpus');
    assertHostileMarkers(field, 'synthetic rejected free-text field');
  }
  return answer;
}

export default [
  {
    name: 'handoff bridge: hostile: synthetic corpus carries every required active-content shape',
    run: () => {
      assertHostileMarkers(HOSTILE_DOCUMENT_TEXT, 'saved hostile corpus');
      assertHostileMarkers(HOSTILE_REJECTED_TEXT, 'rejected hostile corpus');
      assertHostileMarkers(HOSTILE_REJECTED_TEXT_TWO, 'second rejected hostile corpus');
      assert(IDENTITY.name === 'Ada Lovelace' && IDENTITY.contact.length === 1 && IDENTITY.contact[0] === 'ada@example.com'
        && !/example\.test/iu.test(`${CAREER_DATA} ${HOSTILE_DOCUMENT_TEXT}`),
      'hostile corpus must use only the approved synthetic Ada/example.com fixture');
    },
  },
  {
    name: 'handoff bridge: hostile: every planted active-content shape fails the saved-markup assertion',
    run: () => {
      const controls = [
        ['script', '<main class="page"><script>x()</script></main>'],
        ['image', '<main class="page"><img src=https://example.com/x></main>'],
        ['javascript URL', '<main class="page"><a href="javascript:x()">bad</a></main>'],
        ['CSS URL', '<main class="page"><p style="background:url(https://example.com/x)">bad</p></main>'],
      ];
      for (const [kind, fixture] of controls) {
        let rejected = false;
        try { assertNoActiveHostileMarkup(fixture, `unsanitized ${kind} positive control`); } catch { rejected = true; }
        assert(rejected, `the active-markup assertion must fail a planted ${kind} fixture`);
      }
    },
  },
  {
    name: 'handoff bridge: hostile: sanitizer removes active tags handlers javascript and CSS URLs',
    run: () => {
      const sanitized = sanitizeDocumentMainHtml(hostileMainHtml());
      assertNoActiveHostileMarkup(sanitized, 'sanitized model main');
      assert(!sanitized.includes('<script') && !sanitized.includes('<img'),
        'sanitizeDocumentMainHtml must remove active hostile elements before final assembly');
    },
  },
  {
    name: 'handoff bridge: hostile: final document build retains only nonce-bound host scripts',
    run: () => {
      const built = buildResumeDocument({ resumeMainHtml: hostileMainHtml(), docId: 'hostile-synthetic' });
      assertNoActiveHostileMarkup(built, 'final built document', { finalDocument: true });
      assertCsp(cspFromDocument(built));
    },
  },
  {
    name: 'handoff bridge: hostile: CSP source pins the deliberate font and loopback allow-list',
    run: () => {
      const source = fs.readFileSync(new URL('../../electron/ipc/resumeHtml.js', import.meta.url), 'utf8');
      assert(source.includes("default-src 'none'")
        && source.includes("`script-src 'nonce-${scriptNonce}'`")
        && source.includes("style-src 'unsafe-inline' https://fonts.googleapis.com")
        && source.includes('font-src https://fonts.gstatic.com')
        && source.includes('connect-src http://127.0.0.1:43192')
        && source.includes("img-src 'none'"),
      'resume CSP source must pin every deliberate exception');
      assert(!source.includes("script-src 'unsafe-inline'"), 'resume CSP must never allow un-nonced scripts');
    },
  },
  {
    name: 'handoff bridge: hostile: print BrowserWindow source keeps sandbox enabled',
    run: () => {
      const source = fs.readFileSync(new URL('../../electron/ipc/resumeRender.js', import.meta.url), 'utf8');
      assert(source.includes(`webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,`),
        'the print BrowserWindow must retain sandbox: true (live request observation is manual M21)');
    },
  },
  {
    name: 'handoff bridge: hostile: application adapter saves escaped hostile free text through final import',
    run: async () => {
      const { root, canvasFilePath } = await makeScratchCanvas();
      try {
        const queued = await queueScratchApplication(canvasFilePath);
        const lane = { jobId: queued.id, canvasFilePath };
        const adapter = createApplicationSource({ codeGuard });
        const evidence = await adapterSubmit(adapter, lane, hostileEvidencePlan());
        assert(evidence.result.kind === 'accepted' && evidence.result.completed === false, 'hostile evidence plan must pass through the application adapter');
        assertHostileMarkers(evidence.text, 'submitted evidence answer');

        const resume = hostileResume();
        const resumeStep = await adapterSubmit(adapter, lane, { resume });
        assert(resumeStep.result.kind === 'accepted' && resumeStep.result.completed === false, 'hostile structured résumé must pass through the application adapter');
        assertHostileMarkers(resumeStep.text, 'submitted résumé answer');

        const coverLetter = safeCoverLetter();
        const letterStep = await adapterSubmit(adapter, lane, { coverLetter });
        assert(letterStep.result.kind === 'accepted' && letterStep.result.completed === false, 'cover-letter stage must preserve the saved hostile résumé evidence');

        const reviewStep = await adapterSubmit(adapter, lane, passingReview(resume, coverLetter));
        assert(reviewStep.result.kind === 'accepted' && reviewStep.result.completed === true, 'review must complete the scratch application through the adapter');

        const pdf = await PDFDocument.create();
        pdf.addPage([612, 792]);
        const bytes = Buffer.from(await pdf.save());
        __setLocalAiRenderPdfForTests(async () => ({
          bytes, pageCount: 1, fontsLoaded: true, missingFontFaces: [],
          layout: { contentHeightPx: 760, typeAreaHeightPx: 800 },
        }));
        const imported = await importLocalApplicationJob({ jobId: queued.id, canvasFilePath, senderId: 7101 });
        assert(imported.status === 'imported', 'the completed hostile fixture must build and save its final document');
        const saved = await fs.promises.readFile(imported.resumeHtmlPath, 'utf8');
        assert(saved.includes('&lt;script&gt;') && saved.includes('&lt;img src=https://example.com/x&gt;'),
          'saved hostile text must be inert escaped text rather than active elements');
        assertHostileMarkers(modelSurfaceText(saved, { finalDocument: true }), 'saved final application text');
        assertNoActiveHostileMarkup(saved, 'saved application HTML', { finalDocument: true });
        assertCsp(cspFromDocument(saved));
      } finally {
        __setLocalAiRenderPdfForTests(null);
        await fs.promises.rm(root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'handoff bridge: hostile: adapter rejects a hostile answer with every free-text field populated',
    run: async () => {
      const { root, canvasFilePath } = await makeScratchCanvas();
      try {
        const queued = await queueScratchApplication(canvasFilePath);
        const lane = { jobId: queued.id, canvasFilePath };
        const raw = (await getLocalApplicationHandoff({ jobId: queued.id, canvasFilePath })).handoff;
        const answer = hostileRejectedAnswer(raw);
        const result = await createApplicationSource({ codeGuard }).submit(lane, { code: raw.handoffCode, text: JSON.stringify(answer) });
        assert(result.kind === 'rejected' && result.handoff && result.validationErrors.some(item => item.includes(HOSTILE_REJECTED_TEXT)),
          'the real adapter must surface the hostile rejected answer only as app validation evidence');
        assertHostileMarkers(result.validationErrors.join('\n'), 'real adapter rejected validation evidence');
      } finally { await fs.promises.rm(root, { recursive: true, force: true }); }
    },
  },
  {
    name: 'handoff bridge: hostile: framed adapter rejection clips quoted hostile spans and keeps them out of directives',
    run: async () => {
      const { root, canvasFilePath } = await makeScratchCanvas();
      try {
        const queued = await queueScratchApplication(canvasFilePath);
        const lane = { jobId: queued.id, canvasFilePath };
        const raw = (await getLocalApplicationHandoff({ jobId: queued.id, canvasFilePath })).handoff;
        const result = await createApplicationSource({ codeGuard }).submit(lane, {
          code: raw.handoffCode,
          text: JSON.stringify(hostileRejectedAnswer(raw)),
        });
        assert(result.kind === 'rejected' && result.handoff, 'synthetic hostile response must reject through the real adapter');
        const framed = makeRejectedBody({
          handoffCode: result.handoff.code,
          validationErrors: result.validationErrors,
          correctionPrompt: result.handoff.correctionPrompt,
        });
        const framedValidation = framed.validationErrors.join('\n');
        assertQuotedSpansClipped(framedValidation, [HOSTILE_REJECTED_TEXT], 'framed validation errors');
        assertQuotedSpansClipped(framed.correctionPrompt, [HOSTILE_REJECTED_TEXT], 'supplied app correction prompt');
        assertHostileMarkers(framedValidation, 'framed validation errors');
        assertHostileMarkers(framed.correctionPrompt, 'framed correction prompt');
        const multiQuoted = makeRejectedBody({
          handoffCode: result.handoff.code,
          validationErrors: [`first "${HOSTILE_REJECTED_TEXT}" then "${HOSTILE_REJECTED_TEXT_TWO}"`],
          correctionPrompt: `first "${HOSTILE_REJECTED_TEXT}" then "${HOSTILE_REJECTED_TEXT_TWO}"`,
        });
        assertQuotedSpansClipped(multiQuoted.validationErrors.join('\n'), [HOSTILE_REJECTED_TEXT, HOSTILE_REJECTED_TEXT_TWO], 'multi-span framed validation errors');
        assertQuotedSpansClipped(multiQuoted.correctionPrompt, [HOSTILE_REJECTED_TEXT, HOSTILE_REJECTED_TEXT_TWO], 'multi-span supplied correction prompt');
        const { validationErrors: _validationErrors, correctionPrompt: _correctionPrompt, ...unquotedFields } = framed;
        assertNoHostileMarkers(JSON.stringify(unquotedFields), 'note, caution, and every other non-correction rejection field');
        assert(framed.caution === REJECTED_CAUTION && !Object.hasOwn(framed, 'instructions'),
          'rejection framing must retain fixed caution and no executable directive field');
      } finally { await fs.promises.rm(root, { recursive: true, force: true }); }
    },
  },
];
