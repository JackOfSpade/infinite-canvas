import {
  assert,
  __resetSkillOpportunityHistogramCacheForTests,
  buildResumeDocument,
  createEmptySkillOpportunityHistogram,
  JSDOM,
  fs,
  loadSkillOpportunityHistogram,
  mergeSkillOpportunityAnalysis,
  normalizeOpportunityName,
  recordSkillOpportunityAnalysis,
  skillOpportunityHistogramFilePath,
} from '../test-dependencies.js';

function item(overrides = {}) {
  return {
    id: 'skill-1',
    canonicalSkillName: 'Django ORM',
    matchedSkillId: '',
    kind: 'verify',
    jobImportance: 'critical',
    jobEvidence: 'Required for the primary data layer.',
    candidateEvidence: 'Built database-backed Django applications.',
    adjacencyReason: 'Models and migrations are a close but unverified subsystem.',
    suggestedResumeText: 'Django ORM',
    resumeCategory: 'Backend',
    verificationQuestion: 'Have you created Django models or migrations?',
    learningAction: 'Complete the official models-and-migrations tutorial.',
    ...overrides,
  };
}

function analysis(role, items) {
  return {
    role: { canonicalName: role, matchedRoleId: '', sourceTitle: role },
    items,
  };
}

// Matches the design system's convention (resume_design_system/resume.html:258-273):
// a <dl class="skills"> of <dt>/<dd> pairs, each <dd> bare text joined by
// <span class="sep">.
function resumeWithSkills(dlInner) {
  return `<main class="page"><h1 class="name">Jane</h1><section class="section"><dl class="skills">${dlInner}</dl></section></main>`;
}

// Mirrors what a browser would actually paint: text under a `hidden` element
// (or any hidden ancestor) contributes nothing, unlike raw `.textContent`
// which reads straight through the `hidden` attribute.
function renderedText(node) {
  if (!node) return '';
  let out = '';
  node.childNodes.forEach((child) => {
    if (child.nodeType === 3) { out += child.textContent; return; }
    if (child.nodeType === 1) {
      if (child.hidden) return;
      out += renderedText(child);
    }
  });
  return out;
}

function findDtByText(document, text) {
  return Array.prototype.find.call(document.querySelectorAll('dl.skills dt'), (dt) => dt.textContent === text);
}

export default [
  {
    name: 'skill opportunity histogram: canonical demand counts are per job, role-scoped, and alias-safe',
    run: () => {
      assert(normalizeOpportunityName('Node.js / API') === 'nodejs api', 'punctuation/case normalization drifted');

      const empty = createEmptySkillOpportunityHistogram();
      const first = mergeSkillOpportunityAnalysis(empty, analysis('Backend Engineer', [
        item(),
        // A provider duplicate must count once; the closer verify classification wins.
        item({ id: 'skill-2', kind: 'learn', learningAction: 'Build a model.', suggestedResumeText: '', verificationQuestion: '' }),
      ]), '2026-08-14T10:00:00.000Z');
      assert(empty.roles.length === 0, 'merge mutates its input snapshot');
      assert(first.roles.length === 1 && first.roles[0].generationCount === 1, 'first role generation not recorded exactly once');
      assert(first.roles[0].skills.length === 1, 'same semantic skill duplicated within one generation');
      assert(first.roles[0].skills[0].demandCount === 1 && first.roles[0].skills[0].verifyCount === 1 && first.roles[0].skills[0].learnCount === 0,
        'duplicate resolution/count split is wrong');

      const roleId = first.roles[0].id;
      const skillId = first.roles[0].skills[0].id;
      const second = mergeSkillOpportunityAnalysis(first, {
        role: { canonicalName: 'Backend Engineering', matchedRoleId: roleId, sourceTitle: 'Senior Backend Developer' },
        items: [item({ canonicalSkillName: 'Django models', matchedSkillId: skillId, kind: 'learn', suggestedResumeText: '', verificationQuestion: '', learningAction: 'Complete the official ORM tutorial.' })],
      }, '2026-08-15T10:00:00.000Z');
      const backend = second.roles[0];
      assert(backend.generationCount === 2, 'AI-matched role alias should increment the existing role');
      assert(backend.skills.length === 1 && backend.skills[0].demandCount === 2, 'AI-matched skill alias should increment the existing skill');
      assert(backend.skills[0].verifyCount === 1 && backend.skills[0].learnCount === 1, 'verify/learn demand breakdown lost');
      assert(backend.aliases.includes('Backend Engineering') && backend.aliases.includes('Senior Backend Developer'), 'role aliases not preserved');
      assert(backend.skills[0].aliases.includes('Django models'), 'skill alias not preserved');

      const third = mergeSkillOpportunityAnalysis(second, analysis('Data Scientist', [
        item({ canonicalSkillName: 'Django ORM', matchedSkillId: skillId, kind: 'learn', suggestedResumeText: '', verificationQuestion: '', learningAction: 'Build a small app.' }),
      ]), '2026-08-16T10:00:00.000Z');
      assert(third.roles.length === 2, 'different role family was incorrectly merged');
      assert(third.roles[1].skills.length === 1 && third.roles[1].skills[0].demandCount === 1,
        'matchedSkillId from another role must create/count a role-local skill record');
      assert(third.roles[0].skills[0].demandCount === 2,
        'a matchedSkillId hint from another role must not increment that other role');
      return { roles: third.roles.length, backendDemand: backend.skills[0].demandCount };
    },
  },
  {
    name: 'skill opportunity store: demand survives reload and external corruption fails loudly',
    run: () => {
      const stored = recordSkillOpportunityAnalysis(analysis('Platform Engineer', [
        item({ canonicalSkillName: 'Kubernetes', kind: 'learn', suggestedResumeText: '', verificationQuestion: '', learningAction: 'Deploy one service.' }),
      ]));
      assert(stored.roles[0]?.skills[0]?.demandCount === 1, 'record did not persist the first demand observation');
      __resetSkillOpportunityHistogramCacheForTests();
      const reloaded = loadSkillOpportunityHistogram();
      assert(reloaded.roles[0]?.name === 'Platform Engineer' && reloaded.roles[0]?.skills[0]?.name === 'Kubernetes',
        'histogram did not survive a cold reload');

      const filePath = skillOpportunityHistogramFilePath();
      fs.writeFileSync(filePath, '{ broken', 'utf8');
      __resetSkillOpportunityHistogramCacheForTests();
      let failedLoudly = false;
      try { loadSkillOpportunityHistogram(); } catch (error) { failedLoudly = /corrupt/i.test(error.message); }
      assert(failedLoudly, 'a corrupt permanent histogram was silently reset');
      fs.unlinkSync(filePath);
      __resetSkillOpportunityHistogramCacheForTests();
      return { persisted: true, corruptDetected: true };
    },
  },
  {
    name: 'résumé workspace: review gates Sync, verified skills enter print DOM, learn skills stay private, histogram is horizontal',
    run: () => {
      const html = buildResumeDocument({
        resumeMainHtml: '<main class="page"><h1 class="name">Jane</h1><section class="section"><dl class="skills"><dt>Languages</dt><dd>Python</dd></dl></section></main>',
        docId: 'workspace-test',
        jobContext: { title: 'Backend Engineer', company: 'Acme' },
        downloadBundle: {
          company: 'Acme', candidateName: 'Jane', jobMarkdown: '# Role',
          sync: { endpoint: 'http://127.0.0.1:43192/application-sync', token: 'e'.repeat(64) },
        },
        skillInsights: {
          role: { canonicalName: 'Backend Engineer', matchedRoleId: 'role_backend', sourceTitle: 'Senior Backend Developer' },
          items: [
            item(),
            item({
              id: 'skill-2', canonicalSkillName: 'Ruby <script>', kind: 'learn', jobImportance: 'high',
              jobEvidence: 'Required by the service team.', candidateEvidence: 'Python is the nearest foundation.',
              adjacencyReason: 'A different language ecosystem.', suggestedResumeText: '', verificationQuestion: '',
              learningAction: 'Build one small service before claiming it.',
            }),
          ],
        },
        skillHistogram: {
          version: 1,
          roles: [{
            id: 'role_backend', name: 'Backend Engineer', aliases: [], generationCount: 4,
            skills: [{ id: 'django', name: 'Django ORM', aliases: [], demandCount: 3, verifyCount: 2, learnCount: 1, firstSeenAt: 'x', lastSeenAt: 'y' }],
          }],
        },
      });
      assert(html.includes('grid-template-columns: minmax(88px, 38%)'), 'histogram is not a horizontal label/bar/count layout');
      assert(html.includes('ic-hist-verify') && html.includes('ic-hist-learn'), 'horizontal bar does not preserve near/learn breakdown');
      assert(html.includes('4 applications analyzed'), 'role-level sample size is missing');
      assert(html.includes('Ruby &lt;script&gt;'), 'workspace advice is not HTML-escaped');
      assert(!html.includes('id="ic-export-btn"'), 'the removed print/export button must not be present in generated markup');

      const fitHtml = buildResumeDocument({
        resumeMainHtml: '<main class="page"><h1 class="name">Jane</h1><section class="section"><dl class="skills"><dt>Languages</dt><dd>Python</dd></dl></section></main>',
        docId: 'workspace-fit-test',
        skillInsights: { items: [item()] },
        showAllVerifySkills: true,
      });
      const fitDom = new JSDOM(fitHtml);
      assert(!fitDom.window.document.querySelector('[data-ic-inferred-skill="skill-1"]')?.hidden
        && !fitDom.window.document.querySelector('[data-ic-inferred-group]')?.hidden,
      'page-fit mode must measure the largest all-verified résumé state');
      fitDom.window.close();

      const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'https://workspace.test/' });
      const { document } = dom.window;
      assert(!document.getElementById('ic-export-btn'), 'the removed print/export button must not be present in the rendered DOM');
      const syncButton = document.getElementById('ic-sync-btn');
      const inferred = document.querySelector('[data-ic-inferred-skill="skill-1"]');
      assert(syncButton.disabled, 'Sync should start gated while a verify item is unresolved');
      assert(inferred?.hidden, 'unverified adjacent skill leaked into the résumé');
      assert(!document.querySelector('main.page')?.textContent.includes('Ruby <script>'), 'learn-first skill leaked into the résumé main');

      document.querySelector('[data-ic-skill-action="verified"][data-ic-skill-id="skill-1"]').click();
      assert(!syncButton.disabled, 'resolving every review item should unlock Sync');
      assert(!inferred.hidden && document.querySelector('main.page')?.textContent.includes('Django ORM'), 'verified skill was not deterministically added to the résumé');
      document.querySelector('[data-ic-skill-action="not_mine"][data-ic-skill-id="skill-1"]').click();
      assert(inferred.hidden, 'Not mine must remove the inferred skill from the résumé');
      assert(!document.querySelector('[data-ic-not-mine-plan]').hidden, 'Not mine should reveal the bounded learning fallback');
      dom.window.close();
      return { ok: true };
    },
  },
  {
    name: 'résumé workspace: verify skill merges into an existing skills category with no new row and no Role-fit label',
    run: () => {
      const resumeMainHtml = resumeWithSkills(
        '<dt>Safety &amp; Response</dt><dd>Conflict De-escalation<span class="sep">·</span>Emergency Procedures</dd>'
        + '<dt>Languages</dt><dd>Python</dd>'
      );
      const html = buildResumeDocument({
        resumeMainHtml,
        docId: 'merge-basic-test',
        skillInsights: { items: [item({ id: 'skill-1', canonicalSkillName: 'CPR', suggestedResumeText: 'CPR', resumeCategory: 'Safety & Response' })] },
      });
      const { document } = new JSDOM(html).window;
      // NOTE: checked against the parsed DOM, not html.includes() — the literal
      // attribute-name string 'data-ic-inferred-label' also appears inside the
      // always-injected chrome <script> source (as a quoted hasAttribute() arg),
      // so a raw substring check would false-fail on every document.
      assert(!document.querySelector('[data-ic-inferred-label]'), 'a merge must not create a new <dt> row');
      assert(document.querySelectorAll('dl.skills dt').length === 2, 'the <dl> gained a row it should not have');
      const dt = findDtByText(document, 'Safety & Response');
      assert(dt, 'the original category row must survive untouched');
      assert(dt.nextElementSibling?.querySelector('[data-ic-inferred-skill="skill-1"]'), 'merged skill did not land inside the matched <dd>');
      assert(!html.includes('Role-fit'), 'the retired "Role-fit (verified)" wording leaked back into the output');
      return { ok: true };
    },
  },
  {
    name: 'résumé workspace: skillLabelKey merge matching ignores entities/case/punctuation but not different words',
    run: () => {
      const resumeMainHtml = resumeWithSkills(
        '<dt>Safety &amp; Response</dt><dd>Conflict De-escalation<span class="sep">·</span>Emergency Procedures</dd>'
      );
      const html = buildResumeDocument({
        resumeMainHtml,
        docId: 'merge-key-test',
        skillInsights: {
          items: [
            item({ id: 'skill-1', canonicalSkillName: 'CPR', suggestedResumeText: 'CPR', resumeCategory: 'SAFETY & RESPONSE' }),
            item({ id: 'skill-2', canonicalSkillName: 'First Aid', suggestedResumeText: 'First Aid', resumeCategory: 'safety and response' }),
          ],
        },
      });
      const { document } = new JSDOM(html).window;
      assert(document.querySelectorAll('dl.skills dt').length === 2, 'expected exactly one merge and one create');
      const mergedDt = findDtByText(document, 'Safety & Response');
      assert(mergedDt?.nextElementSibling?.querySelector('[data-ic-inferred-skill="skill-1"]'),
        '"SAFETY & RESPONSE" (case/entity variant) must merge into "Safety &amp; Response"');
      const created = document.querySelector('[data-ic-inferred-label]');
      assert(created?.textContent === 'safety and response', '"safety and response" is a different word sequence and must create its own row, not merge');
      assert(created.nextElementSibling?.querySelector('[data-ic-inferred-skill="skill-2"]'), 'created group did not receive the non-matching skill');
      return { ok: true };
    },
  },
  {
    name: 'résumé workspace: verify skill creates a new category row inside the existing skills list when nothing matches',
    run: () => {
      const resumeMainHtml = resumeWithSkills('<dt>Languages</dt><dd>Python</dd>');
      const html = buildResumeDocument({
        resumeMainHtml,
        docId: 'create-basic-test',
        skillInsights: { items: [item({ id: 'skill-1', canonicalSkillName: 'Security+', suggestedResumeText: 'Security+', resumeCategory: 'Certifications' })] },
      });
      const { document } = new JSDOM(html).window;
      assert(document.querySelectorAll('dl.skills').length === 1, 'a created category must not spawn a second skills list');
      // Checked against the parsed DOM for the same reason as above: the chrome
      // <script> source also references 'data-ic-inferred-section' by name.
      assert(!document.querySelector('[data-ic-inferred-section]'), 'a created category must not fall back to the synthesized-section path when a real <dl class="skills"> exists');
      const dt = document.querySelector('dt[data-ic-inferred-label]');
      assert(dt?.textContent === 'Certifications', 'created row label must be the model category, not a hardcoded string');
      const dd = dt.nextElementSibling;
      assert(dd?.hasAttribute('data-ic-inferred-group') && dd.querySelector('[data-ic-inferred-skill="skill-1"]'), 'created skill did not land in the new <dd>');
      return { ok: true };
    },
  },
  {
    name: 'résumé workspace: one generation can merge into an existing category and create a new one at the same time',
    run: () => {
      const resumeMainHtml = resumeWithSkills(
        '<dt>Safety &amp; Response</dt><dd>Conflict De-escalation<span class="sep">·</span>Emergency Procedures</dd>'
        + '<dt>Languages</dt><dd>Python</dd>'
      );
      const html = buildResumeDocument({
        resumeMainHtml,
        docId: 'merge-and-create-test',
        skillInsights: {
          items: [
            item({ id: 'skill-1', canonicalSkillName: 'CPR', suggestedResumeText: 'CPR', resumeCategory: 'Safety & Response' }),
            item({ id: 'skill-2', canonicalSkillName: 'Security+', suggestedResumeText: 'Security+', resumeCategory: 'Certifications' }),
          ],
        },
      });
      const { document } = new JSDOM(html).window;
      assert(document.querySelectorAll('dl.skills').length === 1, 'both outcomes must land in the same skills list');
      assert(document.querySelectorAll('dl.skills dt').length === 3, 'expected the 2 original rows plus exactly 1 created row');
      const mergedDt = findDtByText(document, 'Safety & Response');
      assert(mergedDt?.nextElementSibling?.querySelector('[data-ic-inferred-skill="skill-1"]'), 'merge half of the pair failed');
      const createdDt = document.querySelector('dt[data-ic-inferred-label]');
      assert(createdDt?.textContent === 'Certifications' && createdDt.nextElementSibling?.querySelector('[data-ic-inferred-skill="skill-2"]'),
        'create half of the pair failed');
      return { ok: true };
    },
  },
  {
    name: 'résumé workspace: a created group toggles per skill and hides its row again once every skill is not mine',
    run: () => {
      const resumeMainHtml = resumeWithSkills('<dt>Languages</dt><dd>Python</dd>');
      const html = buildResumeDocument({
        resumeMainHtml,
        docId: 'create-toggle-test',
        skillInsights: {
          items: [
            item({ id: 'skill-1', canonicalSkillName: 'Security+', suggestedResumeText: 'Security+', resumeCategory: 'Certifications' }),
            item({ id: 'skill-2', canonicalSkillName: 'CISSP', suggestedResumeText: 'CISSP', resumeCategory: 'Certifications' }),
          ],
        },
      });
      const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'https://workspace.test/' });
      const { document } = dom.window;
      const label = document.querySelector('[data-ic-inferred-label]');
      const group = document.querySelector('[data-ic-inferred-group]');
      const between = document.querySelector('[data-ic-inferred-separator="between"]');
      assert(label?.hidden && group?.hidden, 'created row must start hidden');

      document.querySelector('[data-ic-skill-action="verified"][data-ic-skill-id="skill-2"]').click();
      assert(!label.hidden && !group.hidden, 'verifying one skill in a created group must reveal the row');
      assert(!document.querySelector('[data-ic-inferred-skill="skill-2"]').hidden, 'verified skill itself must be visible');
      assert(between.hidden, 'the "between" separator must stay hidden with no earlier verified skill to join');

      document.querySelector('[data-ic-skill-action="verified"][data-ic-skill-id="skill-1"]').click();
      assert(!between.hidden, 'the "between" separator must appear once an earlier skill in the group is also verified');

      document.querySelector('[data-ic-skill-action="not_mine"][data-ic-skill-id="skill-1"]').click();
      document.querySelector('[data-ic-skill-action="not_mine"][data-ic-skill-id="skill-2"]').click();
      assert(label.hidden && group.hidden, 'marking every skill in a created group not mine must re-hide the whole row, including its <dt>');
      dom.window.close();
      return { ok: true };
    },
  },
  {
    name: 'résumé workspace: a merged single-skill <dd> shows its join separator once verified, without hiding the real skill',
    run: () => {
      const resumeMainHtml = resumeWithSkills('<dt>Certifications</dt><dd>Access Control</dd>');
      const html = buildResumeDocument({
        resumeMainHtml,
        docId: 'merge-toggle-test',
        skillInsights: { items: [item({ id: 'skill-1', canonicalSkillName: 'CPR', suggestedResumeText: 'CPR', resumeCategory: 'Certifications' })] },
      });
      const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'https://workspace.test/' });
      const { document } = dom.window;
      const dt = findDtByText(document, 'Certifications');
      const dd = dt.nextElementSibling;
      assert(dd.children.length === 2, 'the merged <dd> should hold exactly the appended separator + skill as its only elements (the real skill is bare text)');
      assert(renderedText(dd) === 'Access Control', 'unverified merged skill must not render into the existing row yet');

      document.querySelector('[data-ic-skill-action="verified"][data-ic-skill-id="skill-1"]').click();
      assert(renderedText(dd) === 'Access Control·CPR', 'verified merge must render with its separator between the real and inferred skill, not run the text together');
      assert(!dt.hidden && !dd.hidden, 'the pre-existing category row must never be hidden by an inferred-skill decision');

      document.querySelector('[data-ic-skill-action="not_mine"][data-ic-skill-id="skill-1"]').click();
      assert(renderedText(dd) === 'Access Control', 'not-mine must hide the inferred skill and its separator, reverting to the real corpus content');
      assert(!dt.hidden && !dd.hidden, 'not-mine on a merged skill must not hide the real, pre-existing skill row');
      dom.window.close();
      return { ok: true };
    },
  },
  {
    name: 'résumé workspace: a malicious resumeCategory is escaped in the created label, never rendered as markup',
    run: () => {
      const maliciousCategory = '<script>x</script> & "Ops"';
      const resumeMainHtml = resumeWithSkills('<dt>Languages</dt><dd>Python</dd>');
      const html = buildResumeDocument({
        resumeMainHtml,
        docId: 'escape-test',
        skillInsights: { items: [item({ id: 'skill-1', canonicalSkillName: 'Weird Cert', suggestedResumeText: 'Weird Cert', resumeCategory: maliciousCategory })] },
      });
      assert(!html.includes(maliciousCategory), 'the raw category string must never appear unescaped in the generated HTML');
      assert(html.includes('&lt;script&gt;x&lt;/script&gt; &amp; &quot;Ops&quot;'), 'the category must be escaped exactly like every other model string');
      const { document } = new JSDOM(html).window;
      const dt = document.querySelector('[data-ic-inferred-label]');
      assert(dt?.textContent === maliciousCategory, 'once parsed back, the escaped label must round-trip to the original text');
      assert(!dt.querySelector('script'), 'a malicious category must not materialize a live <script> element inside the created <dt>');
      assert(!Array.prototype.some.call(document.querySelectorAll('script'), (s) => s.textContent.includes('x</script>')),
        'a malicious category must not escape its own tag boundary anywhere in the document');
      return { ok: true };
    },
  },
  {
    name: 'résumé workspace: an empty resumeCategory groups under Additional without producing an empty <dt>',
    run: () => {
      const resumeMainHtml = resumeWithSkills('<dt>Languages</dt><dd>Python</dd>');
      const html = buildResumeDocument({
        resumeMainHtml,
        docId: 'empty-category-test',
        skillInsights: { items: [item({ id: 'skill-1', canonicalSkillName: 'Some Skill', suggestedResumeText: 'Some Skill', resumeCategory: '' })] },
      });
      assert(!/<dt data-ic-inferred-label[^>]*>\s*<\/dt>/.test(html), 'an empty category must not produce an empty created <dt>');
      const { document } = new JSDOM(html).window;
      const dt = document.querySelector('[data-ic-inferred-label]');
      assert(dt?.textContent === 'Additional', 'a missing/empty resumeCategory must fall back to the "Additional" label');
      return { ok: true };
    },
  },
  {
    name: 'résumé workspace: showAllVerifySkills renders a merged skill and its separator already visible',
    run: () => {
      const resumeMainHtml = resumeWithSkills('<dt>Certifications</dt><dd>Access Control</dd>');
      const html = buildResumeDocument({
        resumeMainHtml,
        docId: 'fit-merge-test',
        skillInsights: { items: [item({ id: 'skill-1', canonicalSkillName: 'CPR', suggestedResumeText: 'CPR', resumeCategory: 'Certifications' })] },
        showAllVerifySkills: true,
      });
      const dom = new JSDOM(html);
      const { document } = dom.window;
      assert(!document.querySelector('[data-ic-inferred-skill="skill-1"]')?.hidden, 'page-fit mode must reveal a merged verify skill');
      assert(!document.querySelector('[data-ic-inferred-separator="join"]')?.hidden, 'page-fit mode must reveal the merged skill\'s join separator');
      dom.window.close();
      return { ok: true };
    },
  },
];
