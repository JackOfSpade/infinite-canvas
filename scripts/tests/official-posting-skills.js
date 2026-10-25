import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { approvedCareerEvidenceCatalog, buildCareerSourceCorpus, CAREER_SNAPSHOT_SCHEMA_VERSION } from '../../electron/ipc/careerSnapshot.js';
import { buildApplicationCareerAuthority } from '../../electron/ipc/applicationCareerAuthority.js';
import { __pinnedCareerSkillProjectionForTests, __snapshotCareerSkillEvidenceForTests, __validateAuthorityResumeArtifactsForTests } from '../../electron/ipc/localAiApplication.js';

function corpusFor(...texts) {
  return buildCareerSourceCorpus(texts.map((text, index) => ({ name: `synthetic-career-${index + 1}.md`, text })));
}

function segmentFor(corpus, text, occurrence = 0) {
  const segment = corpus.segments.filter(item => item.text.trim() === text)[occurrence];
  assert.ok(segment, `fixture has segment ${JSON.stringify(text)} at occurrence ${occurrence}`);
  return segment.id;
}

function skill(id, name, directEvidenceSegmentIds, evidenceSegmentIds = directEvidenceSegmentIds) {
  return { id, name, capabilityKind: 'tool', supportMode: 'direct', indexEligible: true, directEvidenceSegmentIds, evidenceSegmentIds };
}

function project(corpus, skills, extra = {}) {
  return __snapshotCareerSkillEvidenceForTests({
    schemaVersion: CAREER_SNAPSHOT_SCHEMA_VERSION, sources: corpus.sources, segments: corpus.segments,
    profile: { skills }, ...extra,
  });
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function freezeTree(value) {
  if (!value || typeof value !== 'object') return value;
  for (const child of Object.values(value)) freezeTree(child);
  return Object.freeze(value);
}

export default [
  {
    name: 'official-posting skills projection follows Markdown section levels through nested headings and stops at same or higher headings',
    run() {
      const corpus = corpusFor('# Career\n## Skills\nLinden\n### Methods\nWillow\n## Work\nCedar\n### Tools\nMaple\n# Skills\nBirch\n# Education\nElm\n');
      const names = ['Linden', 'Willow', 'Cedar', 'Maple', 'Birch', 'Elm'];
      const projected = project(corpus, names.map(name => skill(`skill-${name.toLowerCase()}`, name, [segmentFor(corpus, name)])));
      assert.deepEqual(projected.skills.map(item => [item.name, item.declaredInSkillsSection]), [
        ['Linden', true], ['Willow', true], ['Cedar', false], ['Maple', false], ['Birch', true], ['Elm', false],
      ]);
    },
  },
  {
    name: 'official-posting skills projection recognizes Skills labels and all-caps Skills sections in each source independently',
    run() {
      const corpus = corpusFor('Skills: Linden\nWillow\nExperience:\nCedar\n', 'TECHNICAL SKILLS\nBirch\nEXPERIENCE\nElm\n', 'I use my skills to maintain Maple.\nCore competencies: Juniper\n');
      const specs = [
        ['Linden', 'Skills: Linden'], ['Willow', 'Willow'], ['Cedar', 'Cedar'],
        ['Birch', 'Birch'], ['Elm', 'Elm'], ['Maple', 'I use my skills to maintain Maple.'], ['Juniper', 'Core competencies: Juniper'],
      ];
      const projected = project(corpus, specs.map(([name, line]) => skill(`skill-${name.toLowerCase()}`, name, [segmentFor(corpus, line)])));
      assert.deepEqual(projected.skills.map(item => [item.name, item.declaredInSkillsSection]), [
        ['Linden', true], ['Willow', true], ['Cedar', false], ['Birch', true], ['Elm', false], ['Maple', false], ['Juniper', false],
      ]);
    },
  },
  {
    name: 'official-posting exact direct acronym lines remain Skills content while malformed or ineligible rows cannot hide a section boundary',
    run() {
      const corpus = corpusFor('SKILLS\nSQL\nPython\nWORK EXPERIENCE\nRust\n');
      const projected = project(corpus, ['SQL', 'Python', 'Rust'].map(name => skill(`skill-${name.toLowerCase()}`, name, [segmentFor(corpus, name)])));
      assert.deepEqual(projected.skills.map(item => [item.name, item.declaredInSkillsSection]), [['SQL', true], ['Python', true], ['Rust', false]]);
      const heading = corpusFor('# SQL Skills\nPython\n# Work\nRust\n');
      assert.equal(project(heading, [skill('skill-sql', 'SQL', [heading.segments[0].id])]).skills[0].declaredInSkillsSection, false,
        'a skill mentioned only in a Markdown Skills heading is still excluded');
      const boundary = corpus.segments.find(segment => segment.text.trim() === 'WORK EXPERIENCE');
      for (const change of [
        { startOffset: boundary.startOffset + 1 },
        { sourceId: 'unknown-source' },
        { endOffset: corpus.sources[0].text.length },
      ]) {
        const malformed = { ...boundary, id: 'segment-malformed-boundary', ...change };
        const result = project({ ...corpus, segments: [...corpus.segments, malformed] }, [
          skill('skill-sql', 'SQL', [segmentFor(corpus, 'SQL')]),
          skill('skill-false-boundary', 'WORK EXPERIENCE', [malformed.id]),
          skill('skill-rust', 'Rust', [segmentFor(corpus, 'Rust')]),
        ]);
        assert.equal(result.skills.find(item => item.name === 'SQL').declaredInSkillsSection, true,
          'the Skills section is still open before the actual boundary under test');
        assert.equal(result.skills.find(item => item.name === 'Rust').declaredInSkillsSection, false,
          'an invalid direct-evidence segment cannot turn an actual section heading into content');
      }
      const ineligible = { ...skill('skill-false-boundary', 'WORK EXPERIENCE', [boundary.id]), indexEligible: false };
      const denied = project(corpus, [skill('skill-sql', 'SQL', [segmentFor(corpus, 'SQL')]), ineligible, skill('skill-rust', 'Rust', [segmentFor(corpus, 'Rust')])]);
      assert.deepEqual(denied.skills.map(item => [item.name, item.declaredInSkillsSection]), [['SQL', true], ['Rust', false]],
        'an ineligible skill cannot suppress a section boundary');
    },
  },
  {
    name: 'official-posting skills headings never declare terms from their own Markdown or all-caps title while inline Skills labels do',
    run() {
      for (const text of ['# Linden Skills\nWillow\n## Birch Methods\nCedar\n', 'LINDEN SKILLS\nWillow\n']) {
        const corpus = corpusFor(text);
        const heading = corpus.segments[0];
        const projected = project(corpus, [skill('skill-linden', 'Linden', [heading.id]), skill('skill-willow', 'Willow', [segmentFor(corpus, 'Willow')])]);
        assert.deepEqual(projected.skills.map(item => [item.name, item.declaredInSkillsSection]), [['Linden', false], ['Willow', true]]);
        const nested = corpus.segments.find(item => item.text.includes('Birch'));
        if (nested) assert.equal(project(corpus, [skill('skill-birch', 'Birch', [nested.id])]).skills[0].declaredInSkillsSection, false);
      }
      const corpus = corpusFor('Skills: Linden\n');
      assert.equal(project(corpus, [skill('skill-linden', 'Linden', [corpus.segments[0].id])]).skills[0].declaredInSkillsSection, true);
    },
  },
  {
    name: 'official-posting skills declaration uses direct segment offsets rather than repeated words, generic evidence or derived relationships',
    run() {
      const corpus = corpusFor('Linden\r\n# Skills\r\nLinden\r\n# Work\r\nLinden\r\n', '# Skills\nWillow\n');
      const before = segmentFor(corpus, 'Linden', 0);
      const inside = segmentFor(corpus, 'Linden', 1);
      const after = segmentFor(corpus, 'Linden', 2);
      for (const [direct, expected] of [[before, false], [inside, true], [after, false]]) {
        const projected = project(corpus, [skill('skill-linden', 'Linden', [direct], [before, inside, after])]);
        assert.equal(projected.skills[0].declaredInSkillsSection, expected);
      }
      const projected = project(corpus, [
        skill('skill-linden', 'Linden', [before], [before, inside]),
        skill('skill-willow', 'Willow', [segmentFor(corpus, 'Willow')]),
        { id: 'skill-derived', name: 'Cedar', capabilityKind: 'tool', supportMode: 'relationship-qualified', indexEligible: false, directEvidenceSegmentIds: [], evidenceSegmentIds: [inside] },
      ]);
      assert.deepEqual(projected.skills.map(item => [item.name, item.declaredInSkillsSection]), [['Linden', false], ['Willow', true]]);
      // A segment that crosses the section end cannot declare the skill, even
      // if most of its text sits inside the Skills section.
      const source = corpus.sources[0];
      const startOffset = source.text.indexOf('Linden', source.text.indexOf('# Skills'));
      const crossing = { id: 'segment-crossing', sourceId: source.id, startOffset, endOffset: source.text.length, text: source.text.slice(startOffset) };
      const crossed = project({ ...corpus, segments: [...corpus.segments, crossing] }, [skill('skill-linden', 'Linden', [crossing.id])]);
      assert.equal(crossed.skills[0].declaredInSkillsSection, false);
    },
  },
  {
    name: 'official-posting pinned skills authority preserves exact flagless legacy hashes and rejects altered references without mutating the snapshot',
    run() {
      const corpus = corpusFor('# Skills\nLinden\n# Work\nWillow\n');
      const snapshot = freezeTree({
        schemaVersion: CAREER_SNAPSHOT_SCHEMA_VERSION, status: 'approved', snapshotId: 'a'.repeat(64),
        sources: corpus.sources, segments: corpus.segments,
        profile: { skills: [skill('skill-linden', 'Linden', [segmentFor(corpus, 'Linden')]), skill('skill-willow', 'Willow', [segmentFor(corpus, 'Willow')])] },
      });
      const before = JSON.stringify(snapshot);
      const fresh = __pinnedCareerSkillProjectionForTests(snapshot);
      assert.deepEqual(fresh.skillEvidence.skills.map(item => item.declaredInSkillsSection), [true, false]);
      assert.deepEqual(__pinnedCareerSkillProjectionForTests(snapshot, fresh.authority), fresh);
      const legacyEvidence = { ...fresh.skillEvidence, skills: fresh.skillEvidence.skills.map(item => {
        const legacy = { ...item };
        delete legacy.declaredInSkillsSection;
        return legacy;
      }) };
      const legacyAuthority = {
        ...fresh.authority,
        skillEvidence: { count: legacyEvidence.skills.length, sha256: createHash('sha256').update(canonical(legacyEvidence), 'utf8').digest('hex') },
      };
      assert.notEqual(legacyAuthority.skillEvidence.sha256, fresh.authority.skillEvidence.sha256);
      const retained = __pinnedCareerSkillProjectionForTests(snapshot, legacyAuthority);
      assert.deepEqual(retained.authority, legacyAuthority);
      assert.deepEqual(retained.skillEvidence, legacyEvidence);
      assert.ok(retained.skillEvidence.skills.every(item => !Object.hasOwn(item, 'declaredInSkillsSection')));
      for (const changed of [
        { ...fresh.authority, snapshotDigest: 'f'.repeat(64) },
        { ...legacyAuthority, skillEvidence: { ...legacyAuthority.skillEvidence, count: legacyEvidence.skills.length + 1 } },
        { ...legacyAuthority, skillEvidence: { ...legacyAuthority.skillEvidence, sha256: 'f'.repeat(64) } },
      ]) assert.throws(() => __pinnedCareerSkillProjectionForTests(snapshot, changed), /pinned career authority no longer matches/u);
      assert.equal(JSON.stringify(snapshot), before);
    },
  },
  {
    name: 'official-posting local authority résumé validator requires a listing name for a modern skill outside Skills while flagless projections retain admission',
    run() {
      const corpus = corpusFor('I maintained Linden during freight operations.\n');
      const snapshot = {
        schemaVersion: CAREER_SNAPSHOT_SCHEMA_VERSION, status: 'approved', snapshotId: 'b'.repeat(64),
        sources: corpus.sources, segments: corpus.segments,
        profile: { skills: [skill('skill-linden', 'Linden', [corpus.segments[0].id])] },
      };
      const projection = __snapshotCareerSkillEvidenceForTests(snapshot);
      assert.equal(projection.skills[0].declaredInSkillsSection, false);
      const authority = buildApplicationCareerAuthority(snapshot);
      const evidence = approvedCareerEvidenceCatalog(snapshot).filter(item => item.id.startsWith('host.career.skill.skill-linden.'));
      const resume = { skills: [{ id: 'skills-one', items: ['Linden'], evidenceIds: evidence.map(item => item.id) }] };
      const attempt = (quote, projected = projection) => __validateAuthorityResumeArtifactsForTests(resume,
        [...evidence, ...(quote ? [{ id: 'listing-one', sourceId: 'job-listing', quote }] : [])], authority, [], projected);
      assert.ok(attempt().some(error => error.includes('not declared in the approved source Skills section')));
      assert.deepEqual(attempt('The freight team uses Linden for its rosters.'), []);
      assert.ok(attempt('The freight team uses Lindenwood for its rosters.').length);
      const flagless = { ...projection, skills: projection.skills.map(item => {
        const legacy = { ...item };
        delete legacy.declaredInSkillsSection;
        return legacy;
      }) };
      assert.deepEqual(attempt('', flagless), []);
      assert.deepEqual(attempt('', null), []);
    },
  },
  {
    name: 'official-posting skills projection emits false without a Skills heading and preserves historical projection fields exactly',
    run() {
      const corpus = corpusFor('I maintained Linden during freight operations.\n');
      const direct = skill('skill-linden', 'Linden', [corpus.segments[0].id]);
      const current = project(corpus, [direct]);
      assert.equal(current.skills[0].declaredInSkillsSection, false);
      assert.equal(current.version, 'career-snapshot-skills.v2');
      const historical = project(corpus, [direct], { schemaVersion: 5 });
      assert.deepEqual(historical, {
        version: 'career-snapshot-skills.v1',
        skills: [{ id: 'skill-linden', name: 'Linden', indexEligible: true, evidenceSegmentIds: [corpus.segments[0].id] }],
      });
    },
  },
];
