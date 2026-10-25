import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { approvedCareerEvidenceCatalog, buildCareerSourceCorpus, CAREER_SNAPSHOT_SCHEMA_VERSION } from '../../electron/ipc/careerSnapshot.js';
import { __pinnedCareerSkillProjectionForTests, __snapshotCareerSkillEvidenceForTests } from '../../electron/ipc/localAiApplication.js';
import { initialWriteVerifyState, writeVerifyPrompt, writeVerifySourcePrompt } from '../../electron/ipc/applicationWriteVerify.js';

function snapshotFor(text, specs) {
  const corpus = buildCareerSourceCorpus([{ name: 'synthetic-r4-skills.md', text }]);
  const skills = specs.map(([name, line]) => {
    const segment = corpus.segments.find(item => item.text.trim() === line);
    assert.ok(segment, `fixture segment ${line}`);
    return { id: `skill-${name.toLowerCase()}`, name, capabilityKind: 'tool', supportMode: 'direct', indexEligible: true,
      directEvidenceSegmentIds: [segment.id], evidenceSegmentIds: [segment.id] };
  });
  return { schemaVersion: CAREER_SNAPSHOT_SCHEMA_VERSION, snapshotId: 'd'.repeat(64), status: 'approved',
    sources: corpus.sources, segments: corpus.segments, profile: { skills } };
}
const declarations = snapshot => __snapshotCareerSkillEvidenceForTests(snapshot).skills.map(item => [item.name, item.declaredInSkillsSection]);
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function authorityForProjection(authority, evidence) {
  return { ...authority, skillEvidence: { count: evidence.skills.length, sha256: createHash('sha256').update(canonical(evidence)).digest('hex') } };
}
function freezeTree(value) {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freezeTree(child); Object.freeze(value); }
  return value;
}

export default [
  {
    name: 'R4 bare label lines stay content inside Markdown and all-caps Skills sections',
    run() {
      for (const opener of ['## Skills', '## Technical Skills', 'SKILLS', 'TECHNICAL SKILLS']) {
        const snapshot = snapshotFor(`${opener}\nLanguages: Linden, Willow\nTools: Cedar\n## Experience\nBuilt Birch services.\n`, [
          ['Linden', 'Languages: Linden, Willow'], ['Willow', 'Languages: Linden, Willow'],
          ['Cedar', 'Tools: Cedar'], ['Birch', 'Built Birch services.'],
        ]);
        assert.deepEqual(declarations(snapshot), [['Linden', true], ['Willow', true], ['Cedar', true], ['Birch', false]], opener);
      }
    },
  },
  {
    name: 'R4 label all-caps and bare Skills openers close at any Markdown rank and a new all-caps heading',
    run() {
      for (const opener of ['Skills: Linden', 'Technical Skills: Linden', 'SKILLS\nLinden', 'Skills\nLinden']) {
        const firstLine = opener.includes(':') ? opener : 'Linden';
        for (const boundary of ['# Experience', '## Experience', '###### Experience', 'EXPERIENCE']) {
          const snapshot = snapshotFor(`${opener}\n${boundary}\nBuilt Willow services.\n`, [
            ['Linden', firstLine], ['Willow', 'Built Willow services.'],
          ]);
          assert.deepEqual(declarations(snapshot), [['Linden', true], ['Willow', false]], `${opener}: ${boundary}`);
        }
      }
    },
  },
  {
    name: 'R4 Skills section titles admit exact joined or ending titles and reject Skills gained prose',
    run() {
      for (const [heading, expected] of [
        ['## Skills', true], ['## Technical Skills', true], ['## Skills & Tools', true],
        ['## **Skills**', true], ['## __Technical Skills__', true], ['## Skills ###', true],
        ['#### Skills gained', false], ['## Skills gained through projects', false],
        ['## Experience with skills and delivery', false], ['## Skills review', false],
      ]) {
        const snapshot = snapshotFor(`${heading}\n- Linden\n`, [['Linden', '- Linden']]);
        assert.deepEqual(declarations(snapshot), [['Linden', expected]], heading);
      }
      const titleOnly = snapshotFor('## Linden Skills\n- Willow\n', [['Linden', '## Linden Skills'], ['Willow', '- Willow']]);
      assert.deepEqual(declarations(titleOnly), [['Linden', false], ['Willow', true]], 'the heading itself is never a declaration');
    },
  },
  {
    name: 'R4 common Skills heading forms open the section and prose or role-detail headings do not',
    run() {
      const openers = [
        '## Skills:', '## Technical Skills:', '## Skills & Technologies', '## Skills and Tools', '## Skills Summary', '## Skills / Tools',
        '## Skills & Expertise', '## Skills and Expertise', '## Skills (Languages & Tools)', '## Skills, Tools & Technologies',
        '## Technical Skills & Tools', '## Skills - Technical', '## Skills Profile', '## Skills & Certifications', '## **Skills & Tools**',
        '## __Technical Skills:__', '## Skills Overview ###', '### Core Skills and Competencies', '## Skills 🛠', '## 🛠 Technical Skills',
        'SKILLS SUMMARY', 'SKILLS AND TOOLS', 'SKILLS & EXPERTISE', 'TECHNICAL SKILLS & TOOLS', 'SKILLS / TECHNOLOGIES',
      ];
      for (const heading of openers) {
        const snapshot = snapshotFor(`${heading}\n- Linden\n## Experience\n- Built Willow services.\n`, [['Linden', '- Linden'], ['Willow', '- Built Willow services.']]);
        assert.deepEqual(declarations(snapshot), [['Linden', true], ['Willow', false]], heading);
      }
      for (const heading of ['## Skills gained', '## Skills Gained', '## Skills gained through projects', '## Skills developed', '## Skills used at Cedar Works',
        '## Skills at Cedar Works', '## Skills review', '## Skills for the role', '## Experience with skills and delivery', '## Skills Training Completed',
        'SKILLS GAINED', 'SKILLS USED AT CEDAR WORKS']) {
        const snapshot = snapshotFor(`${heading}\n- Linden\n`, [['Linden', '- Linden']]);
        assert.deepEqual(declarations(snapshot), [['Linden', false]], heading);
      }
      // A label-opened section with the same wider titles still ends at any Markdown heading.
      for (const label of ['Skills & Tools:', 'Skills and Technologies:', 'Technical Skills & Tools:']) {
        const snapshot = snapshotFor(`${label} Linden\n## Experience\n- Built Willow services.\n`, [['Linden', `${label} Linden`], ['Willow', '- Built Willow services.']]);
        assert.deepEqual(declarations(snapshot), [['Linden', true], ['Willow', false]], label);
      }
      // The wider heading forms keep the mixed-style rule: an all-caps or label opener is closed by every Markdown level.
      for (const opener of ['SKILLS AND TOOLS', 'SKILLS SUMMARY']) {
        for (const boundary of ['# Experience', '## Experience', '###### Experience', 'EXPERIENCE']) {
          const snapshot = snapshotFor(`${opener}\n- Linden\n${boundary}\n- Built Willow services.\n`, [['Linden', '- Linden'], ['Willow', '- Built Willow services.']]);
          assert.deepEqual(declarations(snapshot), [['Linden', true], ['Willow', false]], `${opener}: ${boundary}`);
        }
      }
    },
  },
  {
    name: 'R4 a label-opened Skills section alone ends at the next bare label',
    run() {
      const label = snapshotFor('Skills: Linden\nTools: Willow\n', [['Linden', 'Skills: Linden'], ['Willow', 'Tools: Willow']]);
      assert.deepEqual(declarations(label), [['Linden', true], ['Willow', false]]);
      const bare = snapshotFor('Skills\nLanguages: Linden\nTools: Willow\n## Experience\nBuilt Cedar services.\n', [
        ['Linden', 'Languages: Linden'], ['Willow', 'Tools: Willow'], ['Cedar', 'Built Cedar services.'],
      ]);
      assert.deepEqual(declarations(bare), [['Linden', true], ['Willow', true], ['Cedar', false]]);
    },
  },
  {
    name: 'R4 the real source structure keeps bulleted Skills labels declared and job-derived skills outside the section',
    run() {
      const snapshot = snapshotFor('# Career\n\n## Education\n\n### Degree at Cedar University\n\n---\n\n## Skills\n\n- Languages: Linden, Willow\n- Web & infrastructure: Cedar\n- Data: Birch\n- Tooling: Maple\n\n---\n\n## Work Done from Past Jobs\n\n### Engineer\n\n- Environment: Built Elm services.\n- Wrote Aspen integration glue.\n\n## Timeline Notes\n\nSkills: a note label.\n', [
        ['Linden', '- Languages: Linden, Willow'], ['Willow', '- Languages: Linden, Willow'],
        ['Cedar', '- Web & infrastructure: Cedar'], ['Birch', '- Data: Birch'], ['Maple', '- Tooling: Maple'],
        ['Elm', '- Environment: Built Elm services.'], ['Aspen', '- Wrote Aspen integration glue.'],
      ]);
      assert.deepEqual(declarations(snapshot), [['Linden', true], ['Willow', true], ['Cedar', true], ['Birch', true],
        ['Maple', true], ['Elm', false], ['Aspen', false]]);
    },
  },
  {
    name: 'R4 pinned authority retains exact pre-fix true and false flags and flagless jobs while refusing mixed or altered hashes',
    run() {
      const snapshot = freezeTree(snapshotFor('# Career\n## Skills\nLanguages: Linden\n## Work\nSkills: Willow\n## Experience\nBuilt Cedar services.\n', [
        ['Linden', 'Languages: Linden'], ['Cedar', 'Built Cedar services.'],
      ]));
      const sourceBefore = JSON.stringify(snapshot); const modern = __pinnedCareerSkillProjectionForTests(snapshot);
      assert.deepEqual(modern.skillEvidence.skills.map(item => item.declaredInSkillsSection), [true, false]);
      const previous = { ...modern.skillEvidence, skills: modern.skillEvidence.skills.map(item => ({ ...item,
        declaredInSkillsSection: item.name === 'Cedar' })) };
      const previousAuthority = authorityForProjection(modern.authority, previous);
      assert.notEqual(previousAuthority.skillEvidence.sha256, modern.authority.skillEvidence.sha256);
      assert.deepEqual(__pinnedCareerSkillProjectionForTests(snapshot, previousAuthority), { authority: previousAuthority, skillEvidence: previous });
      const flagless = { ...modern.skillEvidence, skills: modern.skillEvidence.skills.map(item => {
        const retained = { ...item }; delete retained.declaredInSkillsSection; return retained;
      }) };
      const flaglessAuthority = authorityForProjection(modern.authority, flagless);
      assert.deepEqual(__pinnedCareerSkillProjectionForTests(snapshot, flaglessAuthority), { authority: flaglessAuthority, skillEvidence: flagless });
      for (const declared of [true, false]) {
        const mixed = { ...previous, skills: previous.skills.map(item => ({ ...item, declaredInSkillsSection: declared })) };
        assert.throws(() => __pinnedCareerSkillProjectionForTests(snapshot, authorityForProjection(modern.authority, mixed)), /pinned career authority no longer matches/u);
      }
      for (const changed of [
        { ...previousAuthority, snapshotDigest: 'f'.repeat(64) },
        { ...previousAuthority, catalog: { ...previousAuthority.catalog, count: previousAuthority.catalog.count + 1 } },
        { ...previousAuthority, skillEvidence: { ...previousAuthority.skillEvidence, sha256: 'f'.repeat(64) } },
      ]) assert.throws(() => __pinnedCareerSkillProjectionForTests(snapshot, changed), /pinned career authority no longer matches/u);
      assert.equal(JSON.stringify(snapshot), sourceBefore);
    },
  },
  {
    name: 'R4 the real writer prompt omits an empty permitted Skills block and restricts a nonempty block to the exact index',
    run() {
      for (const empty of [true, false]) {
        const snapshot = snapshotFor('## Skills\n- Linden\n', [['Linden', '- Linden']]);
        if (empty) snapshot.profile.skills = [];
        const careerSkillEvidence = __snapshotCareerSkillEvidenceForTests(snapshot);
        const sourcePrompt = writeVerifySourcePrompt({ posting: 'Maintain dispatch services.', requirements: [], listingEvidence: [],
          identity: { name: 'Aster', contact: [] }, sourceRoles: [], profile: snapshot.profile,
          catalog: approvedCareerEvidenceCatalog(snapshot), careerSkillEvidence });
        const marker = 'INDEX-ELIGIBLE SKILLS (exact item names and their only permitted skill-group citation IDs):\n';
        const index = JSON.parse(sourcePrompt.slice(sourcePrompt.indexOf(marker) + marker.length));
        assert.equal(index.length, empty ? 0 : 1);
        const prompt = writeVerifyPrompt({ stage: 'write', state: initialWriteVerifyState(1), sourcePrompt,
          envelope: { protocol: 'paste-application.v1', stage: 'write' } });
        assert.ok(prompt.includes('include a skills block only from INDEX-ELIGIBLE SKILLS; omit it when that list is empty'));
        assert.ok(!prompt.includes('include a skills block, and'));
      }
    },
  },
];
