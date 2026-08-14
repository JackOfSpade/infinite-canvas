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
    name: 'résumé workspace: review gates export, verified skills enter print DOM, learn skills stay private, histogram is horizontal',
    run: () => {
      const html = buildResumeDocument({
        resumeMainHtml: '<main class="page"><h1 class="name">Jane</h1><section class="section"><dl class="skills"><dt>Languages</dt><dd>Python</dd></dl></section></main>',
        docId: 'workspace-test',
        jobContext: { title: 'Backend Engineer', company: 'Acme' },
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
      const exportButton = document.getElementById('ic-export-btn');
      const inferred = document.querySelector('[data-ic-inferred-skill="skill-1"]');
      assert(exportButton.disabled, 'export should start gated while a verify item is unresolved');
      assert(inferred?.hidden, 'unverified adjacent skill leaked into the résumé');
      assert(!document.querySelector('main.page')?.textContent.includes('Ruby <script>'), 'learn-first skill leaked into the résumé main');

      document.querySelector('[data-ic-skill-action="verified"][data-ic-skill-id="skill-1"]').click();
      assert(!exportButton.disabled, 'resolving every review item should unlock export');
      assert(!inferred.hidden && document.querySelector('main.page')?.textContent.includes('Django ORM'), 'verified skill was not deterministically added to the résumé');
      document.querySelector('[data-ic-skill-action="not_mine"][data-ic-skill-id="skill-1"]').click();
      assert(inferred.hidden, 'Not mine must remove the inferred skill from the résumé');
      assert(!document.querySelector('[data-ic-not-mine-plan]').hidden, 'Not mine should reveal the bounded learning fallback');
      dom.window.close();
      return { ok: true };
    },
  },
];
