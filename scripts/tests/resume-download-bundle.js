import {
  assert,
  __captureApplicationSyncWorkspaceIdentityForTests,
  __normaliseApplicationSyncWorkspaceForTests,
  __readApplicationSyncWorkspaceHtmlForTests,
  __verifyApplicationSyncWorkspaceIdentityForTests,
  __withApplicationSyncWorkspaceLockForTests,
  buildResumeDocument,
  embedApplicationSyncConfig,
  extractVariantAttrs,
  fs,
  formatOriginalJobListingMarkdown,
  inspectApplicationSyncRevision,
  isDualMode,
  JSDOM,
  normaliseResumeDownloadBundle,
  path,
  PDFLib,
  sanitizeApplicationBundlePart,
} from '../test-dependencies.js';

export default [
  {
    name: 'application bundle: hardened names and pretty source-faithful job Markdown',
    run: () => {
      assert(sanitizeApplicationBundlePart('../CON. ', 'Company') === 'Company', 'traversal/reserved company name must fall back');
      assert(sanitizeApplicationBundlePart('  Café / North  ', 'Company') === 'Café North', 'portable Unicode company name must be retained');
      assert(normaliseResumeDownloadBundle({ company: 'NUL' }).company === 'Company', 'standalone and backend reserved-name policies must agree');

      const scraped = '<script>alert("x")</script>\nBuild `systems` and preserve ``` evidence.';
      const markdown = formatOriginalJobListingMarkdown({
        title: '# Platform Engineer', company: 'A * B', location: 'Toronto, ON',
        salary: '$120k-$140k', posted: '2 days ago', source: 'linkedin', language: 'en',
        url: 'javascript:alert(1)', snippet: scraped,
      });
      assert(markdown.includes('# \\# Platform Engineer'), 'title Markdown syntax must be escaped');
      assert(markdown.includes('**Source:** linkedin') && markdown.includes('**Language:** en'), 'scraper provenance must be printed');
      assert(!markdown.includes('Listing URL'), 'unsafe non-HTTP URL must not become a Markdown link');
      assert(markdown.includes(scraped), 'captured listing text must remain byte-for-byte present');
      assert(markdown.includes('````text'), 'description fence must exceed the longest backtick run in source text');
      return { markdownBytes: Buffer.byteLength(markdown) };
    },
  },
  {
    name: 'application workspace: bounded cover-letter audit persists through Sync configuration injection',
    run: () => {
      const overlong = `unsafe </script>\n${'x'.repeat(900)}`;
      const rawAudit = {
        version: 99,
        rankedNeeds: Array.from({ length: 20 }, () => ({ need: overlong, quote: overlong, source: 'untrusted', decisiveness: 101, kind: overlong })),
        finalPlan: {
          roleThesis: overlong,
          mappings: Array.from({ length: 8 }, () => ({ needIndex: 1001, need: overlong, evidence: overlong, evidenceRole: overlong, achievementIds: Array.from({ length: 20 }, () => overlong), resumeStatus: overlong, inference: overlong })),
          companyHook: { detail: overlong, source: overlong, whyItMattersToCandidate: overlong },
          logistics: overlong,
          droppedNeeds: Array.from({ length: 20 }, () => ({ needIndex: -1, reason: overlong })),
        },
        checks: Array.from({ length: 30 }, () => ({ id: overlong, passed: 'yes', detail: overlong })),
      };
      const normalized = normaliseResumeDownloadBundle({ company: 'Acme', coverLetterAudit: rawAudit });
      const audit = normalized.coverLetterAudit;
      assert(audit.version === 1 && audit.readiness === 'review-required'
        && audit.note.includes('not a persuasive-quality score'),
      'audit normalizer must own version/readiness/note rather than trust raw metadata');
      assert(audit.rankedNeeds.length === 12 && audit.finalPlan.mappings.length === 4
        && audit.finalPlan.droppedNeeds.length === 12 && audit.checks.length === 24,
      'audit arrays must remain bounded before HTML serialization');
      assert(audit.rankedNeeds[0].need.length === 320 && !/[\r\n]/.test(audit.rankedNeeds[0].need)
        && audit.rankedNeeds[0].source === '' && audit.finalPlan.mappings[0].needIndex === null
        && audit.rankedNeeds[0].decisiveness === null && audit.finalPlan.mappings[0].achievementIds.length === 12
        && audit.finalPlan.mappings[0].achievementIds[0].length === 120 && audit.checks[0].passed === false,
      'audit strings and enum/index/boolean fields must be safely normalized');
      const passedAudit = normaliseResumeDownloadBundle({
        coverLetterAudit: {
          rankedNeeds: [{ need: 'Run incident response', quote: 'Run incident response', source: 'posting', decisiveness: 92, kind: 'capability', emphasisReason: 'Repeated in the opening and ownership sections.' }],
          finalPlan: { mappings: [{ needIndex: 0, achievementIds: ['receipt-1'] }] },
          checks: [{ id: 'plan-availability', passed: true, detail: 'available' }],
        },
      }).coverLetterAudit;
      assert(passedAudit.readiness === 'checks-passed' && passedAudit.rankedNeeds[0].decisiveness === 92
        && passedAudit.rankedNeeds[0].emphasisReason === 'Repeated in the opening and ownership sections.'
        && passedAudit.finalPlan.mappings[0].achievementIds[0] === 'receipt-1',
      'valid schema fields must survive normalization and all-passing final checks must be explicit');
      let doc = buildResumeDocument({
        docId: 'cover-audit-persistence',
        resumeMainHtml: '<main class="page"><h1 class="name">Maya</h1></main>',
        coverLetter: { name: 'Maya', paragraphs: ['Cover copy.'] },
        downloadBundle: { company: 'Acme', candidateName: 'Maya', jobMarkdown: '# Role', coverLetterAudit: rawAudit },
      });
      const embeddedBeforeSync = /<script id="ic-application-bundle-data" type="application\/json"[^>]*>([\s\S]*?)<\/script>/.exec(doc)?.[1] || '';
      assert(!embeddedBeforeSync.includes('</script>') && embeddedBeforeSync.includes('\\u003c/script\\u003e'),
        'inert audit JSON must escape a script terminator before embedding');
      doc = embedApplicationSyncConfig(doc, { endpoint: 'http://127.0.0.1:43192/application-sync', token: 'd'.repeat(64) });
      const payload = JSON.parse(/<script id="ic-application-bundle-data" type="application\/json"[^>]*>([\s\S]*?)<\/script>/.exec(doc)?.[1] || '{}');
      assert(payload.coverLetterAudit?.version === 1
        && payload.coverLetterAudit?.finalPlan?.roleThesis === audit.finalPlan.roleThesis
        && payload.sync?.token === 'd'.repeat(64),
      'Sync config injection must update only its capability while preserving the bounded inert audit');
      return { needs: audit.rankedNeeds.length, checks: audit.checks.length, syncPreserved: true };
    },
  },
  {
    name: 'application workspace: Sync replaces download and submits only the selected document to its saved bridge',
    run: async () => {
      let doc = buildResumeDocument({
        docId: 'sync-interaction-test',
        resumeMainHtml: '<main class="page"><h1 class="name">Maya Chen</h1><p id="resume-copy">Original résumé</p></main>',
        coverLetter: { name: 'Maya Chen', paragraphs: ['Original cover letter.'] },
        downloadBundle: { company: 'Acme', candidateName: 'Maya Chen', jobMarkdown: '# Role' },
      });
      doc = embedApplicationSyncConfig(doc, { endpoint: 'http://127.0.0.1:43192/application-sync', token: 'a'.repeat(64) });
      assert(!doc.includes('Download application bundle') && !doc.includes('storedZip'), 'saved workspace must not ship a browser ZIP downloader');
      const dom = new JSDOM(doc, { runScripts: 'dangerously', url: 'file:///tmp/Acme/Application.html' });
      const { document } = dom.window;
      const sync = document.getElementById('ic-sync-btn');
      const calls = [];
      dom.window.fetch = async (endpoint, options) => {
        calls.push({ endpoint, payload: JSON.parse(options.body) });
        return { ok: true, json: async () => ({ success: true }) };
      };
      assert(!sync.disabled && sync.textContent.includes('résumé'), 'a configured saved HTML enables Sync without manually attaching a PDF');
      document.getElementById('ic-cover-tab').click();
      document.getElementById('ic-edit-toggle').click();
      const cover = document.getElementById('ic-cover-panel').querySelector('main');
      cover.querySelector('.letter-body p').textContent = 'Edited cover letter.';
      cover.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
      sync.click();
      await new Promise(resolve => dom.window.setTimeout(resolve, 0));
      assert(calls.length === 1 && calls[0].endpoint === 'http://127.0.0.1:43192/application-sync', 'Sync must use the fixed local bridge endpoint');
      assert(calls[0].payload.token === 'a'.repeat(64) && calls[0].payload.document === 'cover', 'Sync must use its capability and selected document only');
      assert(calls[0].payload.html.includes('Edited cover letter.'), 'Sync must send the current editable HTML to Electron for rendering');
      assert(document.getElementById('ic-pdf-bundle-note').textContent.includes('Synced cover letter'), 'success should confirm the replaced sibling document');
      dom.window.close();
      return { selectedDocument: 'cover', capabilityScoped: true };
    },
  },
  {
    name: 'application workspace: legacy localStorage HTML is sanitized before entering the live editor',
    run: () => {
      const docId = 'runtime-sanitizer-test';
      const doc = buildResumeDocument({
        docId,
        resumeMainHtml: '<main class="page"><h1 class="name">Original</h1><p>Cut debt <span data-achievement-id="a1">74%</span></p></main>',
        ledger: [{
          id: 'a1', claim: 'Cut debt', caveats: '', derivation: 'debt $4.2M to $1.1M',
          computed: { isNumeric: true, display: '74% ($4.2M → $1.1M)' },
        }],
        coverLetter: { name: 'Maya Chen', paragraphs: ['Original cover letter.'] },
      });
      // Autosaved edits only restore against the revision they were typed over,
      // so the saved entry has to carry this file's stamp to reach the editor at
      // all. Without it the payload is dropped as stale and this test would pass
      // for the wrong reason, never exercising the sanitizer.
      const savedFingerprint = /var RESUME_MARKUP_FINGERPRINT = "([^"]*)"/.exec(doc)?.[1] || '';
      assert(savedFingerprint, 'the generated workspace must stamp a résumé markup fingerprint');
      const hostileMarkup = '<h1 class="name" onclick="window.__owned=1">Restored safely</h1><p><span data-achievement-id="a1" data-derivation="forged local tooltip">74%</span><span data-achievement-id="a1" data-derivation="borrowed tooltip">75%</span></p><img src="https://evil.test/pixel" onerror="window.__owned=2"><script>window.__owned=3</script><a href="javascript:window.__owned=4">bad link</a>';
      const dom = new JSDOM(doc, {
        runScripts: 'dangerously',
        url: 'https://application-runtime-sanitizer.local/',
        beforeParse(window) {
          window.localStorage.setItem(`ic-edit:${docId}`, hostileMarkup);
          window.localStorage.setItem(`ic-edit:${docId}:fingerprint`, savedFingerprint);
        },
      });
      try {
        const main = dom.window.document.querySelector('[data-ic-document-panel="resume"] main.page');
        assert(main?.textContent.includes('Restored safely') && !main.querySelector('script,img')
          && !main.querySelector('[onclick],[onerror]') && !main.querySelector('a[href]')
          && dom.window.__owned === undefined,
        'saved rich HTML must be cleaned in a detached template before it reaches the connected résumé main');
        const receipts = main.querySelectorAll('[data-achievement-id="a1"]');
        assert(receipts[0]?.getAttribute('data-derivation')?.includes('debt $4.2M')
          && !receipts[0].getAttribute('data-derivation').includes('forged')
          && !receipts[1]?.hasAttribute('data-derivation'),
        'localStorage may restore a receipt tooltip only from the initial ledger-authored page with matching id and visible text');
        assert(doc.includes("target.addEventListener('paste'") && doc.includes("target.addEventListener('drop'"),
          'the generated contenteditable surface must force paste/drop input through plain text');
        // An entry saved before this stamp existed cannot be shown to belong to
        // this revision, so it is dropped rather than sanitized-and-restored.
        const legacy = new JSDOM(doc, {
          runScripts: 'dangerously',
          url: 'https://application-runtime-sanitizer.local/',
          beforeParse(window) { window.localStorage.setItem(`ic-edit:${docId}`, hostileMarkup); },
        });
        try {
          const legacyMain = legacy.window.document.querySelector('[data-ic-document-panel="resume"] main.page');
          assert(!legacyMain?.textContent.includes('Restored safely') && legacyMain?.textContent.includes('Original')
            && legacy.window.__owned === undefined,
          'an unstamped localStorage entry must be discarded, leaving the generated markup in place');
          assert(legacy.window.localStorage.getItem(`ic-edit:${docId}`) === null,
            'a discarded entry must be purged so it cannot be replayed on the next load');
          assert(legacy.window.localStorage.getItem(`ic-edit:${docId}:superseded`) === hostileMarkup,
            'a superseded entry must be moved aside, not destroyed: this slot is only written by a real edit, and an unsynced one exists nowhere else');
        } finally {
          legacy.window.close();
        }
        return { legacyMarkupInert: true, richPasteDisabled: true, unstampedDiscarded: true };
      } finally {
        dom.window.close();
      }
    },
  },
  {
    // Regression: a regenerated application reused its docId, so the browser
    // replayed the PREVIOUS generation's cover letter over the new one. The
    // reader saw a superseded draft that appeared nowhere in the file, and Sync
    // would have written that draft back over the freshly generated letter.
    name: 'application workspace: a regenerated document beats a stale autosaved draft',
    run: () => {
      const docId = 'regenerated-application';
      const build = (paragraph) => buildResumeDocument({
        docId,
        resumeMainHtml: '<main class="page"><h1 class="name">Maya Chen</h1></main>',
        coverLetter: { name: 'Maya Chen', paragraphs: [paragraph] },
      });
      const first = build('The letter this application originally shipped with.');
      const second = build('The letter the generator produced on the second run.');
      const fingerprintOf = (doc) => /var COVER_MARKUP_FINGERPRINT = "([^"]*)"/.exec(doc)?.[1] || '';
      const firstStamp = fingerprintOf(first);
      const secondStamp = fingerprintOf(second);
      assert(firstStamp && secondStamp, 'both generations must stamp a cover fingerprint');
      assert(firstStamp !== secondStamp, 'regenerating with a different letter must change the cover fingerprint');
      assert(/var RESUME_MARKUP_FINGERPRINT = "([^"]*)"/.exec(first)?.[1]
        === /var RESUME_MARKUP_FINGERPRINT = "([^"]*)"/.exec(second)?.[1],
      'an unchanged résumé must keep its fingerprint so a letter edit cannot discard résumé edits');

      const staleDraft = '<div class="letter-body"><p>A superseded draft the reader kept editing.</p></div>';
      const open = (doc) => new JSDOM(doc, {
        runScripts: 'dangerously',
        url: 'https://application-regenerated.local/',
        beforeParse(window) {
          window.localStorage.setItem(`ic-edit:${docId}:cover`, staleDraft);
          window.localStorage.setItem(`ic-edit:${docId}:cover:fingerprint`, firstStamp);
        },
      });

      const sameRevision = open(first);
      try {
        const letter = sameRevision.window.document.querySelector('[data-ic-document-panel="cover"] main');
        assert(letter?.textContent.includes('superseded draft'),
          'reopening the same generated file must still restore the reader\u2019s own edits');
      } finally {
        sameRevision.window.close();
      }

      const regenerated = open(second);
      try {
        const letter = regenerated.window.document.querySelector('[data-ic-document-panel="cover"] main');
        assert(letter?.textContent.includes('second run'),
          'a regenerated letter must render the markup the generator just wrote');
        assert(!letter?.textContent.includes('superseded draft'),
          'the previous generation\u2019s draft must not mask the regenerated letter');
        assert(regenerated.window.localStorage.getItem(`ic-edit:${docId}:cover`) === null,
          'the superseded draft must be purged, not left to reappear on the next load');
        assert(regenerated.window.localStorage.getItem(`ic-edit:${docId}:cover:superseded`) === staleDraft,
          'the superseded draft must remain recoverable: it may be unsynced work that exists nowhere else');
      } finally {
        regenerated.window.close();
      }
      return { staleDraftDiscarded: true, sameRevisionRestored: true };
    },
  },
  {
    // Regression: the decision replay ran BEFORE the autosave restore, and the
    // restore replaces the whole résumé main with a payload carrying its own
    // hidden-attribute state. Because a decision persists the decision map but
    // never schedules a markup save, the two drift apart — so a skill the user
    // rejected came back visible (and a verified one vanished) on reopen, while
    // the card and the review status said the opposite. Sync then wrote that
    // résumé, and its PDF, to disk.
    name: 'application workspace: skill decisions govern a restored résumé, not the payload',
    run: () => {
      const docId = 'skill-decision-reconcile';
      const doc = buildResumeDocument({
        docId,
        resumeMainHtml: '<main class="page"><h1 class="name">Maya Chen</h1><dl class="skills"><dt>Core</dt><dd>Node.js</dd></dl></main>',
        coverLetter: { name: 'Maya Chen', paragraphs: ['Cover copy.'] },
        skillInsights: { items: [{ id: 'skill-1', kind: 'verify', canonicalSkillName: 'Django', suggestedResumeText: 'Django ORM', resumeCategory: 'Core' }] },
      });
      const stamp = /var RESUME_MARKUP_FINGERPRINT = "([^"]*)"/.exec(doc)?.[1] || '';
      assert(stamp, 'the workspace must stamp a résumé fingerprint');
      const editKey = `ic-edit:${docId}`;
      const skillKey = `ic-skill-review:${docId}`;
      const open = (seed) => new JSDOM(doc, {
        runScripts: 'dangerously',
        url: 'https://skill-reconcile.local/',
        beforeParse(window) { seed(window.localStorage); },
      });
      const resumeMainOf = (dom) => dom.window.document.querySelector('[data-ic-document-panel="resume"] main');
      const inferredOf = (dom) => resumeMainOf(dom).querySelector('[data-ic-inferred-skill="skill-1"]');

      // Capture the two payloads the way a user actually produces them: the
      // résumé markup as it stands before any decision, and as it stands after
      // clicking Verified. Neither is written by a decision — only by typing.
      const base = open(() => {});
      const payloadHidden = resumeMainOf(base).innerHTML;
      base.window.document.querySelector('[data-ic-skill-action="verified"]').click();
      const payloadVisible = resumeMainOf(base).innerHTML;
      base.window.close();
      assert(/data-ic-inferred-skill="skill-1"[^>]*hidden/.test(payloadHidden)
        && !/data-ic-inferred-skill="skill-1"[^>]*hidden/.test(payloadVisible),
      'the two payloads must differ in the inferred skill visibility this test turns on');

      // Rejected after the last keystroke: the payload still shows the skill.
      const rejected = open((ls) => {
        ls.setItem(editKey, payloadVisible);
        ls.setItem(`${editKey}:fingerprint`, stamp);
        ls.setItem(skillKey, JSON.stringify({ 'skill-1': 'not_mine' }));
      });
      try {
        assert(rejected.window.document.getElementById('ic-restore-note').hidden === false,
          'the restore must actually have run, or this test proves nothing');
        assert(inferredOf(rejected)?.hidden === true,
          'a skill the user marked Not mine must stay out of the résumé even when the restored payload shows it');
      } finally {
        rejected.window.close();
      }

      // Verified after the last keystroke: the payload still hides the skill.
      const verified = open((ls) => {
        ls.setItem(editKey, payloadHidden);
        ls.setItem(`${editKey}:fingerprint`, stamp);
        ls.setItem(skillKey, JSON.stringify({ 'skill-1': 'verified' }));
      });
      try {
        assert(verified.window.document.getElementById('ic-restore-note').hidden === false,
          'the restore must actually have run, or this test proves nothing');
        assert(inferredOf(verified)?.hidden === false,
          'a skill the user marked Verified must be present when the review status says it is included');
        assert(verified.window.document.getElementById('ic-review-status').textContent.includes('1 verified skill'),
          'the review status must agree with what the résumé actually shows');
      } finally {
        verified.window.close();
      }
      return { rejectedStaysOut: true, verifiedStaysIn: true };
    },
  },
  {
    name: 'application workspace: review gates résumé Sync but not cover Sync',
    run: () => {
      const doc = buildResumeDocument({
        docId: 'bundle-review-test',
        resumeMainHtml: '<main class="page"><h1 class="name">Maya</h1><dl class="skills"><dt>Core</dt><dd>Node.js</dd></dl></main>',
        coverLetter: { name: 'Maya', paragraphs: ['Cover copy.'] },
        skillInsights: {
          items: [{ id: 'skill-1', kind: 'verify', canonicalSkillName: 'Django', suggestedResumeText: 'Django ORM' }],
        },
        downloadBundle: {
          company: 'Acme', candidateName: 'Maya', jobMarkdown: '# Role',
          sync: { endpoint: 'http://127.0.0.1:43192/application-sync', token: 'b'.repeat(64) },
        },
      });
      assert(!doc.includes('id="ic-export-btn"'), 'the removed print/export button must not be present in generated markup');
      const dom = new JSDOM(doc, { runScripts: 'dangerously', url: 'https://application-review.local/' });
      const { document } = dom.window;
      assert(!document.getElementById('ic-export-btn'), 'the removed print/export button must not be present in the rendered DOM');
      const sync = document.getElementById('ic-sync-btn');
      assert(sync.disabled, 'unresolved résumé claim must gate résumé Sync');
      document.getElementById('ic-cover-tab').click();
      assert(!sync.disabled, 'cover-letter Sync stays available while résumé review is unresolved');
      document.querySelector('[data-ic-skill-action="not_mine"]').click();
      document.getElementById('ic-resume-tab').click();
      assert(!sync.disabled, 'Not mine allows résumé Sync without a manually attached PDF');
      document.querySelector('[data-ic-skill-action="verified"]').click();
      assert(!sync.disabled, 'adding a verified skill is rendered fresh by Electron during Sync');
      dom.window.close();
      return { coverIndependent: true, renderOnSync: true };
    },
  },
  {
    // The AI-selected variant is intentionally not user-editable, but it must
    // not be invisible: a deliberate ink-only PDF otherwise looks like a
    // broken dual-mode render. The workspace explains both the visible result
    // and the recipient-profile rationale while leaving the canonical root
    // attribute untouched for Sync.
    name: 'application workspace: explains the read-only AI paper decision without changing the OCG gate',
    run: () => {
      const doc = buildResumeDocument({
        docId: 'bundle-variant-test',
        resumeMainHtml: '<main class="page" data-print="ink-only"><h1 class="name">Maya</h1></main>',
        variantAttrs: 'data-print="ink-only"',
        coverLetter: { name: 'Maya', paragraphs: ['Cover copy.'] },
        jobContext: { company: 'Acme', title: 'Platform Engineer' },
        downloadBundle: {
          company: 'Acme', candidateName: 'Maya', jobMarkdown: '# Role',
          sync: { endpoint: 'http://127.0.0.1:43192/application-sync', token: 'c'.repeat(64) },
        },
      });
      assert(isDualMode(extractVariantAttrs(doc)) === false, 'an ink-only application must not be re-read as dual');
      const dom = new JSDOM(doc, { runScripts: 'dangerously', url: 'https://application-variant.local/' });
      const { document } = dom.window;
      assert(!document.getElementById('ic-print-variant'), 'the manual paper selector must not be present');
      const note = document.getElementById('ic-print-variant-note');
      assert(note && note.textContent.includes('AI paper decision: Flat white PDF'), 'ink-only must be named as the AI-selected flat-white PDF mode');
      assert(note.textContent.includes('analysis for Acme — Platform Engineer indicates'), 'paper decision must name the company and role it analyzed exactly once (not "for for")');
      assert(note.textContent.includes('white in viewers and print'), 'ink-only must make both resulting PDF states explicit');
      assert(note.textContent.includes('ATS-heavy, enterprise, regulated, or otherwise conservative recipient profile'), 'ink-only must explain the inferred recipient-profile rationale');
      assert(document.documentElement.getAttribute('data-print') === 'ink-only', 'the read-only explanation must not rewrite the selected root variant');
      assert(isDualMode(extractVariantAttrs('<!doctype html>\n' + document.documentElement.outerHTML)) === false, 'the explained ink-only choice must still gate the OCG cream layer OFF');
      dom.window.close();

      const dualDoc = buildResumeDocument({
        docId: 'bundle-variant-dual-test',
        resumeMainHtml: '<main class="page" data-print="dual-pdf"><h1 class="name">Maya</h1></main>',
        variantAttrs: 'data-print="dual-pdf"',
        coverLetter: { name: 'Maya', paragraphs: ['Cover copy.'] },
      });
      const dualDom = new JSDOM(dualDoc, { runScripts: 'dangerously', url: 'https://application-variant-dual.local/' });
      const dualNote = dualDom.window.document.getElementById('ic-print-variant-note');
      assert(dualNote && dualNote.textContent.includes('Dual-mode PDF — cream in viewers, white in print'), 'dual-pdf must explain its two visible states');
      assert(dualNote.textContent.includes('design-conscious, startup-oriented, or craft-focused recipient profile'), 'dual-pdf must explain the inferred recipient-profile rationale');
      assert(isDualMode(extractVariantAttrs(dualDoc)) === true, 'the explained dual-pdf choice must still gate the OCG cream layer ON');
      dualDom.window.close();
      return { variantsExplained: 2, manualOverride: false };
    },
  },
  {
    name: 'application workspace: unsaved or legacy HTML clearly disables Sync',
    run: () => {
      const legacyResumePdf = Buffer.from('%PDF-1.4\nlegacy-resume');
      const migrated = normaliseResumeDownloadBundle({
        company: 'Acme', candidateName: 'Maya', jobMarkdown: '# Role', pdfBase64: legacyResumePdf.toString('base64'),
      });
      assert(migrated.resumePdfBase64 === legacyResumePdf.toString('base64'), 'legacy pdfBase64 must migrate to the résumé field');
      assert(migrated.coverLetterPdfBase64 === '', 'legacy résumé bytes must never be fabricated as a cover-letter PDF');
      const doc = buildResumeDocument({
        docId: 'bundle-legacy-payload-test',
        resumeMainHtml: '<main class="page"><h1 class="name">Maya</h1></main>',
        coverLetter: { name: 'Maya', paragraphs: ['Cover copy.'] },
        downloadBundle: migrated,
      });
      const dom = new JSDOM(doc, { runScripts: 'dangerously', url: 'https://application-legacy.local/' });
      const sync = dom.window.document.getElementById('ic-sync-btn');
      const note = dom.window.document.getElementById('ic-pdf-bundle-note');
      assert(sync.disabled, 'legacy HTML without an Electron capability must not claim it can overwrite files');
      assert(note.textContent.includes('Save this application from Infinite Canvas'), 'legacy HTML must explain how to make Sync available');
      dom.window.close();
      return { legacyResumeRetained: true, syncRequiresSave: true };
    },
  },
  {
    name: 'application Sync readback verifies exact HTML, parsed PDF, and the retained capability',
    run: async () => {
      const dir = await fs.promises.mkdtemp('/tmp/infinite-canvas-sync-readback-');
      const applicationPath = path.join(dir, 'Application.html');
      const pdfPath = path.join(dir, 'Resume.pdf');
      const token = 'd'.repeat(64);
      const html = `<!doctype html><html><body><section data-ic-document-panel="resume"><main class="page">Resume</main></section><section data-ic-document-panel="cover"><main class="page">Cover</main></section><script id="ic-application-bundle-data" type="application/json">{"sync":{"endpoint":"http://127.0.0.1:43192/application-sync","token":"${token}"}}</script></body></html>`;
      const pdf = await PDFLib.PDFDocument.create();
      pdf.addPage([612, 792]);
      const pdfBytes = Buffer.from(await pdf.save());
      try {
        await Promise.all([
          fs.promises.writeFile(applicationPath, html),
          fs.promises.writeFile(pdfPath, pdfBytes),
        ]);
        const manifest = await inspectApplicationSyncRevision({ applicationPath, pdfPath, html, pdf: pdfBytes, token });
        assert(manifest.every(item => item.integrityVerified && item.matchesSource)
          && manifest.find(item => item.name === 'Resume.pdf')?.pdfParsed,
        'a Sync revision passes only after exact-byte readback and structural PDF parsing');

        const alteredHtml = html.replace(token, 'e'.repeat(64));
        await fs.promises.writeFile(applicationPath, alteredHtml);
        let wrongCapabilityRejected = false;
        try {
          await inspectApplicationSyncRevision({ applicationPath, pdfPath, html: alteredHtml, pdf: pdfBytes, token });
        } catch (error) {
          wrongCapabilityRejected = /readback failed/.test(error.message)
            && error.syncManifest?.some(item => item.name === 'Application.html' && item.syncConfigValid === false);
        }
        assert(wrongCapabilityRejected,
          'an incoming shell may not replace the capability that authorized this workspace');
        return { verified: manifest.length, wrongCapabilityRejected };
      } finally {
        await fs.promises.rm(dir, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'application Sync serializes edits within one workspace while allowing unrelated workspaces to proceed',
    run: async () => {
      const order = [];
      let releaseFirst;
      const firstGate = new Promise(resolve => { releaseFirst = resolve; });
      const first = __withApplicationSyncWorkspaceLockForTests('/tmp/company/application', async () => {
        order.push('first:start');
        await firstGate;
        order.push('first:end');
      });
      const second = __withApplicationSyncWorkspaceLockForTests('/tmp/company/application', async () => {
        order.push('second:start');
        order.push('second:end');
      });
      const unrelated = __withApplicationSyncWorkspaceLockForTests('/tmp/company/other-application', async () => {
        order.push('other:start');
        order.push('other:end');
      });
      await Promise.resolve();
      await Promise.resolve();
      assert(order.includes('first:start') && order.includes('other:start') && !order.includes('second:start'),
        'a same-workspace Sync waits behind the active edit while a different workspace is not globally blocked');
      releaseFirst();
      await Promise.all([first, second, unrelated]);
      assert(order.indexOf('first:end') < order.indexOf('second:start'),
        'same-workspace Sync operations must complete in FIFO order');
      return { order };
    },
  },
  {
    name: 'application Sync capabilities reconstruct only canonical sibling paths and retain directory identity',
    run: async () => {
      const workspace = __normaliseApplicationSyncWorkspaceForTests({
        token: 'c'.repeat(64), workspaceDir: '/tmp/company/application',
        applicationPath: '/tmp/attacker.html', resumePdfPath: '/tmp/attacker.pdf',
      });
      assert(workspace?.applicationPath === '/tmp/company/application/Application.html', 'persisted state must never select a caller-provided HTML path');
      assert(workspace?.resumePdfPath === '/tmp/company/application/Resume.pdf', 'resume destination must be a canonical sibling');
      assert(workspace?.coverLetterPdfPath === '/tmp/company/application/Cover Letter.pdf', 'cover destination must be a canonical sibling');
      assert(__normaliseApplicationSyncWorkspaceForTests({ token: 'not-a-token', workspaceDir: '/tmp/company/application' }) === null, 'invalid capabilities must be discarded before serving sync');

      const tempRoot = await fs.promises.mkdtemp('/tmp/infinite-canvas-sync-identity-');
      // /tmp itself is a platform symlink on macOS. Start from its real path
      // so the fixture exercises a link introduced *after* capture.
      const root = await fs.promises.realpath(tempRoot);
      const trustedParent = path.join(root, 'trusted-parent');
      const workspaceDir = path.join(trustedParent, 'application');
      const movedParent = path.join(root, 'moved-parent');
      const redirectParent = path.join(root, 'redirect-parent');
      try {
        await fs.promises.mkdir(workspaceDir, { recursive: true });
        await fs.promises.writeFile(path.join(workspaceDir, 'Application.html'), '<!doctype html>');
        const captured = await __captureApplicationSyncWorkspaceIdentityForTests({
          token: 'd'.repeat(64), workspaceDir,
        });
        const verified = await __verifyApplicationSyncWorkspaceIdentityForTests(captured);
        assert(verified.identity?.dev === captured.identity?.dev && verified.identity?.ino === captured.identity?.ino,
          'an unchanged regular workspace must retain its captured directory identity');
        assert(await __readApplicationSyncWorkspaceHtmlForTests(captured) === '<!doctype html>',
          'Sync must read an unchanged workspace through its identity-bound file handle');

        const applicationPath = path.join(workspaceDir, 'Application.html');
        const originalApplicationPath = path.join(workspaceDir, 'Application.original.html');
        const outsideHtmlPath = path.join(root, 'outside.html');
        await fs.promises.writeFile(outsideHtmlPath, '<!doctype html>outside');
        await fs.promises.rename(applicationPath, originalApplicationPath);
        await fs.promises.symlink(outsideHtmlPath, applicationPath);
        let linkedHtmlRejected = false;
        try { await __readApplicationSyncWorkspaceHtmlForTests(captured); }
        catch (error) { linkedHtmlRejected = /regular file|symbolic link|ELOOP/.test(error.message); }
        assert(linkedHtmlRejected, 'Sync must never follow a swapped Application.html symlink while reading its trusted shell');
        await fs.promises.unlink(applicationPath);
        await fs.promises.rename(originalApplicationPath, applicationPath);

        await fs.promises.rename(trustedParent, movedParent);
        await fs.promises.mkdir(path.join(redirectParent, 'application'), { recursive: true });
        await fs.promises.writeFile(path.join(redirectParent, 'application', 'Application.html'), '<!doctype html>attacker replacement');
        await fs.promises.symlink(redirectParent, trustedParent, 'dir');
        let redirectRejected = false;
        try { await __verifyApplicationSyncWorkspaceIdentityForTests(captured); }
        catch (error) { redirectRejected = /symbolic link|replaced/.test(error.message); }
        assert(redirectRejected,
          'replacing an ancestor with a symlink must revoke Sync before it reads or writes canonical sibling names');
        return { fixedWorkspacePaths: true, identityBound: true, linkedHtmlRejected, redirectRejected };
      } finally {
        await fs.promises.unlink(trustedParent).catch(() => {});
        await fs.promises.rm(root, { recursive: true, force: true });
      }
    },
  },
];
