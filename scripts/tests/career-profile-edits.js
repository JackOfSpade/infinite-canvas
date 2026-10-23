import nodeAssert from 'node:assert';
import { createHash } from 'node:crypto';

import { assert } from './testHelpers.js';
import {
  CAREER_PROFILE_PAGE_SCHEMA,
  CAREER_PROFILE_EDIT_SCHEMA,
  CAREER_PROFILE_EDIT_AUDIT_SCHEMA,
  CAREER_PROFILE_EDIT_REPAIR_SCHEMA,
  CAREER_PROFILE_ADJUDICATION_SCHEMA,
} from '../../electron/ipc/aiSchemas.js';
import { validateResponseSchema } from '../../electron/ipc/schemaValidation.js';
import {
  CAREER_PROFILE_EDITABLE_FIELDS,
  editTargetKey,
  parseEditValue,
  applyProfileEdits,
  normalizeQuoteText,
  verifySourceQuote,
  createDecisionLedger,
  recordDecision,
  decisionForTarget,
  checkFindingAgainstLedger,
  recordChallengeEvidence,
  findConflictingEdits,
  decisionsForPage,
  serializeDecisionLedger,
  deserializeDecisionLedger,
} from '../../electron/ipc/careerProfileEdits.js';

const PREFIX = 'p0002-';

function shard() {
  return {
    identity: { name: 'Ada Lovelace', contacts: ['ada@example.com'], evidenceSegmentIds: ['segment-0001'] },
    roles: [{
      id: 'p0002-role-1', evidenceSegmentIds: ['segment-0002'], title: 'Engineer', employer: 'Acme',
      startDate: '2020', endDate: '2022', location: 'Remote', achievementIds: [], skillIds: [],
    }],
    achievements: [],
    projects: [],
    skills: [{
      id: 'p0002-skill-1', evidenceSegmentIds: ['segment-0003'], name: 'Python', category: 'Language',
      capabilityKind: 'language', supportMode: 'direct', directEvidenceSegmentIds: ['segment-0003'],
      indexEligible: true, roleIds: ['p0002-role-1'],
    }],
    education: [],
    certifications: [],
    otherEvidence: [],
    segmentCoverage: [
      { segmentId: 'segment-0001', disposition: 'identity' },
      { segmentId: 'segment-0002', disposition: 'role-header' },
      { segmentId: 'segment-0003', disposition: 'skill-evidence' },
    ],
    rolePatches: [{ targetId: 'p0001-role-9', evidenceSegmentIds: ['segment-0002'], updates: { endDate: '2023' } }],
    projectPatches: [],
    continuationState: { roles: { mode: 'inherit', ids: [] }, projects: { mode: 'inherit', ids: [] } },
  };
}

function edit(op, group, entityId, field, value) {
  return { op, group, entityId, field, valueJson: value === undefined ? '' : JSON.stringify(value) };
}

function expectRejected(input, edits, expectedErrors) {
  const snapshot = structuredClone(input);
  const result = applyProfileEdits(input, edits, { entityIdPrefix: PREFIX });
  nodeAssert.deepStrictEqual(result.errors, expectedErrors);
  assert(result.shard === input, 'a rejected edit batch must return the original shard reference');
  nodeAssert.deepStrictEqual(result.shard, snapshot);
  nodeAssert.deepStrictEqual(input, snapshot);
  nodeAssert.deepStrictEqual(result.applied, []);
}

const TITLE_KEY = 'roles\u0000p0002-role-1\u0000title';

function expectedDecisionId(pageIndex, targetKey, round, valueJson) {
  const canonical = JSON.stringify({ pageIndex, round, targetKey, valueJson });
  return `decision-${createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 16)}`;
}

function finding(edits, decisionId = '', evidenceSegmentIds = []) {
  return {
    id: 'finding-1', severity: 'blocker', category: 'attribution', segmentIds: ['segment-0002'],
    entityIds: ['p0002-role-1'], detail: 'Title is wrong.', edits,
    sourceQuote: 'Senior Engineer', challenge: { decisionId, evidenceSegmentIds },
  };
}

function settledLedger() {
  const ledger = createDecisionLedger();
  const decision = recordDecision(ledger, {
    pageIndex: 2, targetKey: TITLE_KEY, value: 'Engineer', sourceQuote: 'Engineer',
    evidenceSegmentIds: ['segment-0002'], category: 'attribution', round: 1, origin: 'adjudication', findingDetail: 'kept',
  });
  return { ledger, decision };
}

export default [
  {
    name: 'career profile edits: sample shard is a valid page shard',
    run: () => {
      nodeAssert.deepStrictEqual(validateResponseSchema(shard(), CAREER_PROFILE_PAGE_SCHEMA), []);
    },
  },
  {
    name: 'career profile edits: edit schema accepts a sample and rejects missing/extra fields',
    run: () => {
      const sample = edit('set', 'roles', 'p0002-role-1', 'title', 'Lead');
      nodeAssert.deepStrictEqual(validateResponseSchema(sample, CAREER_PROFILE_EDIT_SCHEMA), []);
      const missing = { ...sample };
      delete missing.valueJson;
      nodeAssert.deepStrictEqual(validateResponseSchema(missing, CAREER_PROFILE_EDIT_SCHEMA),
        [{ path: '$', message: 'is missing required property "valueJson"' }]);
      nodeAssert.deepStrictEqual(validateResponseSchema({ ...sample, extra: 1 }, CAREER_PROFILE_EDIT_SCHEMA),
        [{ path: '$.extra', message: 'is not an allowed property' }]);
      nodeAssert.deepStrictEqual(validateResponseSchema({ ...sample, op: 'patch' }, CAREER_PROFILE_EDIT_SCHEMA),
        [{ path: '$.op', message: 'must be one of: "set", "add", "remove", "set-coverage"' }]);
    },
  },
  {
    name: 'career profile edits: edit-audit schema requires edits, sourceQuote and challenge',
    run: () => {
      const valid = { findings: [finding([edit('set', 'roles', 'p0002-role-1', 'title', 'Lead')])] };
      nodeAssert.deepStrictEqual(validateResponseSchema(valid, CAREER_PROFILE_EDIT_AUDIT_SCHEMA), []);
      const missing = structuredClone(valid);
      delete missing.findings[0].challenge;
      nodeAssert.deepStrictEqual(validateResponseSchema(missing, CAREER_PROFILE_EDIT_AUDIT_SCHEMA),
        [{ path: '$.findings[0]', message: 'is missing required property "challenge"' }]);
      const extra = structuredClone(valid);
      extra.findings[0].challenge.bogus = true;
      nodeAssert.deepStrictEqual(validateResponseSchema(extra, CAREER_PROFILE_EDIT_AUDIT_SCHEMA),
        [{ path: '$.findings[0].challenge.bogus', message: 'is not an allowed property' }]);
      const noEdits = structuredClone(valid);
      noEdits.findings[0].edits = [];
      nodeAssert.deepStrictEqual(validateResponseSchema(noEdits, CAREER_PROFILE_EDIT_AUDIT_SCHEMA),
        [{ path: '$.findings[0].edits', message: 'must contain at least 1 item' }]);
    },
  },
  {
    name: 'career profile edits: repair and adjudication schemas accept samples and reject missing/extra fields',
    run: () => {
      const repair = { edits: [edit('remove', 'skills', 'p0002-skill-1', '')], notes: '' };
      nodeAssert.deepStrictEqual(validateResponseSchema(repair, CAREER_PROFILE_EDIT_REPAIR_SCHEMA), []);
      nodeAssert.deepStrictEqual(validateResponseSchema({ edits: [] }, CAREER_PROFILE_EDIT_REPAIR_SCHEMA),
        [{ path: '$', message: 'is missing required property "notes"' }]);
      nodeAssert.deepStrictEqual(validateResponseSchema({ ...repair, more: '' }, CAREER_PROFILE_EDIT_REPAIR_SCHEMA),
        [{ path: '$.more', message: 'is not an allowed property' }]);
      const ruling = { ruling: 'keep', valueJson: '', rationale: 'Source says Engineer.', sourceQuote: 'Engineer', evidenceSegmentIds: ['segment-0002'] };
      nodeAssert.deepStrictEqual(validateResponseSchema(ruling, CAREER_PROFILE_ADJUDICATION_SCHEMA), []);
      const missing = { ...ruling };
      delete missing.rationale;
      nodeAssert.deepStrictEqual(validateResponseSchema(missing, CAREER_PROFILE_ADJUDICATION_SCHEMA),
        [{ path: '$', message: 'is missing required property "rationale"' }]);
      nodeAssert.deepStrictEqual(validateResponseSchema({ ...ruling, extra: 'x' }, CAREER_PROFILE_ADJUDICATION_SCHEMA),
        [{ path: '$.extra', message: 'is not an allowed property' }]);
      nodeAssert.deepStrictEqual(validateResponseSchema({ ...ruling, evidenceSegmentIds: [] }, CAREER_PROFILE_ADJUDICATION_SCHEMA),
        [{ path: '$.evidenceSegmentIds', message: 'must contain at least 1 item' }]);
    },
  },
  {
    name: 'career profile edits: editable fields, target keys and value parsing',
    run: () => {
      nodeAssert.deepStrictEqual(CAREER_PROFILE_EDITABLE_FIELDS.identity, ['name', 'contacts', 'evidenceSegmentIds']);
      nodeAssert.deepStrictEqual(CAREER_PROFILE_EDITABLE_FIELDS.roles,
        ['evidenceSegmentIds', 'title', 'employer', 'startDate', 'endDate', 'location', 'achievementIds', 'skillIds']);
      nodeAssert.deepStrictEqual(CAREER_PROFILE_EDITABLE_FIELDS.skills,
        ['evidenceSegmentIds', 'name', 'category', 'capabilityKind', 'supportMode', 'directEvidenceSegmentIds', 'indexEligible', 'roleIds']);
      nodeAssert.deepStrictEqual(CAREER_PROFILE_EDITABLE_FIELDS.rolePatches, ['evidenceSegmentIds', 'updates']);
      nodeAssert.deepStrictEqual(CAREER_PROFILE_EDITABLE_FIELDS.projectPatches, ['evidenceSegmentIds', 'updates']);
      nodeAssert.deepStrictEqual(CAREER_PROFILE_EDITABLE_FIELDS.segmentCoverage, ['disposition']);
      assert(Object.isFrozen(CAREER_PROFILE_EDITABLE_FIELDS), 'editable field map must be frozen');
      assert(editTargetKey(edit('set', 'roles', 'p0002-role-1', 'title', 'x')) === TITLE_KEY, 'set key');
      assert(editTargetKey(edit('add', 'roles', 'p0002-role-2', 'title', {})) === 'roles\u0000p0002-role-2\u0000*', 'add key');
      assert(editTargetKey(edit('remove', 'roles', 'p0002-role-1', '')) === 'roles\u0000p0002-role-1\u0000*', 'remove key');
      assert(editTargetKey(edit('set-coverage', 'segmentCoverage', 'segment-0002', '', 'context'))
        === 'segmentCoverage\u0000segment-0002\u0000disposition', 'set-coverage key');
      nodeAssert.deepStrictEqual(parseEditValue(edit('set', 'roles', 'x', 'title', 'Lead')), { ok: true, value: 'Lead' });
      nodeAssert.deepStrictEqual(parseEditValue(edit('remove', 'roles', 'x', '')), { ok: true, value: undefined });
      nodeAssert.deepStrictEqual(parseEditValue({ ...edit('set', 'roles', 'x', 'title'), valueJson: '' }),
        { ok: false, error: 'valueJson must not be empty for set' });
      nodeAssert.deepStrictEqual(parseEditValue({ ...edit('remove', 'roles', 'x', ''), valueJson: '"x"' }),
        { ok: false, error: "valueJson must be '' for remove" });
      assert(parseEditValue({ ...edit('set', 'roles', 'x', 'title'), valueJson: '{bad' }).ok === false, 'invalid JSON rejected');
    },
  },
  {
    name: 'career profile edits: set, add, remove, set-coverage and patch edits apply purely',
    run: () => {
      const input = shard();
      const snapshot = structuredClone(input);
      const setTitle = edit('set', 'roles', 'p0002-role-1', 'title', 'Senior Engineer');
      const newAchievement = {
        id: 'p0002-ach-1', evidenceSegmentIds: ['segment-0002'], roleId: 'p0002-role-1',
        claim: 'Shipped billing.', technologies: [], metrics: [],
      };
      const addAch = edit('add', 'achievements', 'p0002-ach-1', '', newAchievement);
      const removeSkill = edit('remove', 'skills', 'p0002-skill-1', '');
      const coverage = edit('set-coverage', 'segmentCoverage', 'segment-0002', '', 'context');
      const patch = edit('set', 'rolePatches', 'p0001-role-9', 'updates', { endDate: '2024' });
      const identity = edit('set', 'identity', 'identity', 'name', 'Ada King');
      const result = applyProfileEdits(input, [setTitle, addAch, removeSkill, coverage, patch, identity], { entityIdPrefix: PREFIX });
      nodeAssert.deepStrictEqual(result.errors, []);
      nodeAssert.deepStrictEqual(input, snapshot);
      const expected = shard();
      expected.roles[0].title = 'Senior Engineer';
      expected.achievements = [newAchievement];
      expected.skills = [];
      expected.segmentCoverage[1].disposition = 'context';
      expected.rolePatches[0].updates = { endDate: '2024' };
      expected.identity.name = 'Ada King';
      nodeAssert.deepStrictEqual(result.shard, expected);
      nodeAssert.deepStrictEqual(result.applied, [
        { edit: setTitle, targetKey: TITLE_KEY, before: 'Engineer', after: 'Senior Engineer' },
        { edit: addAch, targetKey: 'achievements\u0000p0002-ach-1\u0000*', before: null, after: newAchievement },
        { edit: removeSkill, targetKey: 'skills\u0000p0002-skill-1\u0000*', before: snapshot.skills[0], after: null },
        { edit: coverage, targetKey: 'segmentCoverage\u0000segment-0002\u0000disposition', before: 'role-header', after: 'context' },
        { edit: patch, targetKey: 'rolePatches\u0000p0001-role-9\u0000updates', before: { endDate: '2023' }, after: { endDate: '2024' } },
        { edit: identity, targetKey: 'identity\u0000identity\u0000name', before: 'Ada Lovelace', after: 'Ada King' },
      ]);
      nodeAssert.deepStrictEqual(validateResponseSchema(result.shard, CAREER_PROFILE_PAGE_SCHEMA), []);
    },
  },
  {
    name: 'career profile edits: each invalid edit leaves the shard unchanged with a named error',
    run: () => {
      expectRejected(shard(), [edit('set', 'roles', 'p0002-role-404', 'title', 'Lead')],
        ["edit 0 (set roles/p0002-role-404/title): roles has no entity with id 'p0002-role-404'"]);
      expectRejected(shard(), [edit('set', 'roles', 'p0002-role-1', 'id', 'p0002-role-7')],
        ["edit 0 (set roles/p0002-role-1/id): field 'id' is not editable for roles; editable fields: evidenceSegmentIds, title, employer, startDate, endDate, location, achievementIds, skillIds"]);
      expectRejected(shard(), [edit('set', 'skills', 'p0002-skill-1', 'supportMode', 'bogus')],
        ['edit 0 (set skills/p0002-skill-1/supportMode): value for skills/p0002-skill-1/supportMode is invalid: $ must be one of: "direct", "relationship-qualified"']);
      expectRejected(shard(), [edit('set', 'roles', 'p0002-role-1', 'title', 'Engineer')],
        ['edit 0 (set roles/p0002-role-1/title): edit to roles/p0002-role-1/title proposes no change']);
      expectRejected(shard(), [edit('add', 'achievements', 'p0003-ach-1', '', {
        id: 'p0003-ach-1', evidenceSegmentIds: ['segment-0002'], roleId: 'p0002-role-1', claim: 'x', technologies: [], metrics: [],
      })], ["edit 0 (add achievements/p0003-ach-1/*): new achievements id 'p0003-ach-1' must start with page prefix 'p0002-'"]);
      expectRejected(shard(), [edit('add', 'roles', 'p0002-role-1', '', shard().roles[0])],
        ["edit 0 (add roles/p0002-role-1/*): roles already has a record with id 'p0002-role-1'"]);
      expectRejected(shard(), [
        edit('set', 'roles', 'p0002-role-1', 'title', 'Lead'),
        edit('set', 'roles', 'p0002-role-1', 'title', 'Principal'),
      ], ['edit 1 (set roles/p0002-role-1/title): conflicts with an earlier edit to roles/p0002-role-1/title that proposes a different value']);
      const ambiguous = shard();
      ambiguous.rolePatches.push({ targetId: 'p0001-role-9', evidenceSegmentIds: ['segment-0003'], updates: { title: 'Lead' } });
      expectRejected(ambiguous, [edit('set', 'rolePatches', 'p0001-role-9', 'updates', { endDate: '2025' })],
        ["edit 0 (set rolePatches/p0001-role-9/updates): rolePatches has 2 records with targetId 'p0001-role-9'; the target is ambiguous"]);
      expectRejected(shard(), [edit('set-coverage', 'segmentCoverage', 'segment-0099', '', 'context')],
        ['edit 0 (set-coverage segmentCoverage/segment-0099/*): segment segment-0099 has no segmentCoverage record']);
    },
  },
  {
    name: 'career profile edits: one bad edit rejects the whole batch and lists every error',
    run: () => {
      expectRejected(shard(), [
        edit('set', 'roles', 'p0002-role-1', 'title', 'Lead'),
        edit('remove', 'skills', 'p0002-skill-404', ''),
        edit('set', 'skills', 'p0002-skill-1', 'supportMode', 'bogus'),
      ], [
        "edit 1 (remove skills/p0002-skill-404/*): skills has no entity with id 'p0002-skill-404' to remove",
        'edit 2 (set skills/p0002-skill-1/supportMode): value for skills/p0002-skill-1/supportMode is invalid: $ must be one of: "direct", "relationship-qualified"',
      ]);
    },
  },
  {
    name: 'career profile edits: source quotes normalize whitespace and NFC and may span segments in order',
    run: () => {
      const segments = new Map([
        ['segment-0001', { id: 'segment-0001', text: 'Led the  migration\nof billing' }],
        ['segment-0002', { id: 'segment-0002', text: 'to Postgres in 2021.' }],
        ['segment-0003', { id: 'segment-0003', text: 'Caf\u00e9 owner' }],
      ]);
      assert(normalizeQuoteText('  a\t\n  b  ') === 'a b', 'whitespace collapses');
      assert(normalizeQuoteText('Cafe\u0301') === 'Caf\u00e9', 'NFC composes');
      assert(verifySourceQuote('the migration of billing', ['segment-0001'], segments) === true, 'whitespace-normalized quote');
      assert(verifySourceQuote('Cafe\u0301 owner', ['segment-0003'], segments) === true, 'NFC quote');
      assert(verifySourceQuote('of billing to Postgres', ['segment-0001', 'segment-0002'], segments) === true, 'cross-segment quote');
      assert(verifySourceQuote('of billing to Postgres', ['segment-0002', 'segment-0001'], segments) === false, 'order matters');
      assert(verifySourceQuote('to Postgres', ['segment-0009'], segments) === false, 'unknown segment');
      assert(verifySourceQuote('   ', ['segment-0001'], segments) === false, 'empty quote');
      assert(verifySourceQuote('to MySQL', ['segment-0002'], segments) === false, 'absent text');
      assert(verifySourceQuote('to Postgres', ['segment-0002'], Object.fromEntries(segments)) === true, 'plain-object lookup');
    },
  },
  {
    name: 'career profile edits: decision ids are deterministic and an unchallenged edit on a settled target is rejected',
    run: () => {
      const { ledger, decision } = settledLedger();
      const id = expectedDecisionId(2, TITLE_KEY, 1, '"Engineer"');
      assert(decision.id === id, `decision id ${decision.id} !== ${id}`);
      nodeAssert.deepStrictEqual(decisionForTarget(ledger, 2, TITLE_KEY), decision);
      assert(decisionForTarget(ledger, 3, TITLE_KEY) === null, 'other page has no decision');
      const edits = [edit('set', 'roles', 'p0002-role-1', 'title', 'Senior Engineer')];
      nodeAssert.deepStrictEqual(checkFindingAgainstLedger(ledger, 2, finding(edits), edits), {
        ok: false,
        errors: [`roles/p0002-role-1/title is settled by ${id} (value "Engineer"; evidence segment-0002). Drop this finding, or challenge ${id} with evidence segments not yet considered.`],
        challengedDecisions: [],
      });
      const removal = [edit('remove', 'roles', 'p0002-role-1', '')];
      nodeAssert.deepStrictEqual(checkFindingAgainstLedger(ledger, 2, finding(removal)).errors,
        [`roles/p0002-role-1/title is settled by ${id} (value "Engineer"; evidence segment-0002). Drop this finding, or challenge ${id} with evidence segments not yet considered.`]);
      const unrelated = [edit('set', 'roles', 'p0002-role-1', 'employer', 'Initech')];
      nodeAssert.deepStrictEqual(checkFindingAgainstLedger(ledger, 2, finding(unrelated)), { ok: true, errors: [], challengedDecisions: [] });
    },
  },
  {
    name: 'career profile edits: wrong decision id and already-considered evidence are rejected; new evidence is accepted',
    run: () => {
      const { ledger, decision } = settledLedger();
      const edits = [edit('set', 'roles', 'p0002-role-1', 'title', 'Senior Engineer')];
      nodeAssert.deepStrictEqual(checkFindingAgainstLedger(ledger, 2, finding(edits, 'decision-0000000000000000', ['segment-0007'])).errors,
        [`challenge names decision-0000000000000000 but roles/p0002-role-1/title is currently settled by ${decision.id} (value "Engineer"; evidence segment-0002).`]);
      nodeAssert.deepStrictEqual(checkFindingAgainstLedger(ledger, 2, finding(edits, decision.id, ['segment-0002'])).errors,
        [`challenge of ${decision.id} on roles/p0002-role-1/title cites no new evidence; already considered: segment-0002.`]);
      nodeAssert.deepStrictEqual(checkFindingAgainstLedger(ledger, 2, finding(edits, decision.id, ['segment-0002', 'segment-0007'])),
        { ok: true, errors: [], challengedDecisions: [decision] });
    },
  },
  {
    name: 'career profile edits: considered evidence accumulates across supersession',
    run: () => {
      const { ledger, decision: first } = settledLedger();
      recordChallengeEvidence(ledger, 2, TITLE_KEY, ['segment-0005']);
      const second = recordDecision(ledger, {
        pageIndex: 2, targetKey: TITLE_KEY, value: 'Senior Engineer', sourceQuote: 'Senior Engineer',
        evidenceSegmentIds: ['segment-0005'], category: 'attribution', round: 2, origin: 'audit', findingDetail: 'promoted',
      });
      assert(second.id === expectedDecisionId(2, TITLE_KEY, 2, '"Senior Engineer"'), 'second decision id');
      nodeAssert.deepStrictEqual(decisionForTarget(ledger, 2, TITLE_KEY), second);
      const edits = [edit('set', 'roles', 'p0002-role-1', 'title', 'Engineer')];
      nodeAssert.deepStrictEqual(checkFindingAgainstLedger(ledger, 2, finding(edits, second.id, ['segment-0002'])).errors,
        [`challenge of ${second.id} on roles/p0002-role-1/title cites no new evidence; already considered: segment-0002, segment-0005.`]);
      nodeAssert.deepStrictEqual(checkFindingAgainstLedger(ledger, 2, finding(edits, first.id, ['segment-0009'])).errors,
        [`challenge names ${first.id} but roles/p0002-role-1/title is currently settled by ${second.id} (value "Senior Engineer"; evidence segment-0005).`]);
      const stored = JSON.parse(serializeDecisionLedger(ledger)).targets[0];
      nodeAssert.deepStrictEqual(stored.consideredEvidenceSegmentIds, ['segment-0002', 'segment-0005']);
      nodeAssert.deepStrictEqual(stored.supersededDecisionIds, [first.id]);
    },
  },
  {
    name: 'career profile edits: termination — a 3-segment target changes at most 3 times without any counter',
    run: () => {
      const universe = ['segment-0001', 'segment-0002', 'segment-0003'];
      const subsets = [];
      for (let mask = 1; mask < 8; mask++) subsets.push(universe.filter((_, bit) => mask & (1 << bit)));
      const attempt = (ledger, round, evidence) => {
        const current = decisionForTarget(ledger, 0, TITLE_KEY);
        const edits = [edit('set', 'roles', 'p0002-role-1', 'title', `title-${round}`)];
        const check = checkFindingAgainstLedger(ledger, 0, finding(edits, current.id, evidence));
        if (!check.ok) return false;
        recordChallengeEvidence(ledger, 0, TITLE_KEY, evidence);
        recordDecision(ledger, {
          pageIndex: 0, targetKey: TITLE_KEY, value: `title-${round}`, sourceQuote: 'q',
          evidenceSegmentIds: evidence, category: 'attribution', round, origin: 'audit', findingDetail: '',
        });
        return true;
      };
      const seed = () => {
        const ledger = createDecisionLedger();
        recordDecision(ledger, {
          pageIndex: 0, targetKey: TITLE_KEY, value: 'title-0', sourceQuote: '', evidenceSegmentIds: [],
          category: 'attribution', round: 0, origin: 'repair', findingDetail: '',
        });
        return ledger;
      };

      const scripted = seed();
      const outcomes = [['segment-0001'], ['segment-0001'], ['segment-0002', 'segment-0001'], ['segment-0003'], ['segment-0002'], universe]
        .map((evidence, index) => attempt(scripted, index + 1, evidence));
      nodeAssert.deepStrictEqual(outcomes, [true, false, true, true, false, false]);
      assert(outcomes.filter(Boolean).length === 3, 'exactly three changes were admitted');
      assert(decisionForTarget(scripted, 0, TITLE_KEY).value === 'title-4', 'the fourth admitted challenge never happened');

      // Exhaustively: every sequence of five challenges over the three
      // segments admits at most three changes.
      let maxChanges = 0;
      const total = subsets.length ** 5;
      for (let code = 0; code < total; code++) {
        const ledger = seed();
        let changes = 0;
        let rest = code;
        for (let step = 1; step <= 5; step++) {
          if (attempt(ledger, step, subsets[rest % subsets.length])) changes++;
          rest = Math.floor(rest / subsets.length);
        }
        maxChanges = Math.max(maxChanges, changes);
        assert(changes <= 3, `sequence ${code} admitted ${changes} changes`);
      }
      assert(maxChanges === 3, `the bound is reachable (max ${maxChanges})`);
    },
  },
  {
    name: 'career profile edits: findConflictingEdits groups only different canonical values',
    run: () => {
      const entries = [
        { findingIndex: 0, pageIndex: 1, edit: edit('set', 'roles', 'p0002-role-1', 'title', 'A') },
        { findingIndex: 1, pageIndex: 1, edit: { ...edit('set', 'roles', 'p0002-role-1', 'title'), valueJson: ' "A" ' } },
        { findingIndex: 2, pageIndex: 1, edit: edit('set', 'roles', 'p0002-role-1', 'employer', 'X') },
        { findingIndex: 3, pageIndex: 1, edit: edit('set', 'roles', 'p0002-role-1', 'employer', 'Y') },
        { findingIndex: 4, pageIndex: 2, edit: edit('set', 'roles', 'p0002-role-1', 'employer', 'Z') },
        { findingIndex: 5, pageIndex: 1, edit: edit('set', 'rolePatches', 'p0001-role-9', 'updates', { b: 1, a: 2 }) },
        { findingIndex: 6, pageIndex: 1, edit: { ...edit('set', 'rolePatches', 'p0001-role-9', 'updates'), valueJson: '{"a":2,"b":1}' } },
      ];
      nodeAssert.deepStrictEqual(findConflictingEdits(entries), [
        { pageIndex: 1, targetKey: 'roles\u0000p0002-role-1\u0000employer', entries: [entries[2], entries[3]] },
      ]);
      nodeAssert.deepStrictEqual(findConflictingEdits([]), []);
    },
  },
  {
    name: 'career profile edits: decisionsForPage is compact and sorted; ledger serialization round-trips',
    run: () => {
      const { ledger, decision: title } = settledLedger();
      const name = recordDecision(ledger, {
        pageIndex: 2, targetKey: 'identity\u0000identity\u0000name', value: 'Ada Lovelace', sourceQuote: 'Ada Lovelace',
        evidenceSegmentIds: ['segment-0001'], category: 'grounding', round: 1, origin: 'repair', findingDetail: '',
      });
      recordDecision(ledger, {
        pageIndex: 3, targetKey: TITLE_KEY, value: 'Other', sourceQuote: 'Other',
        evidenceSegmentIds: ['segment-0010'], category: 'grounding', round: 1, origin: 'audit', findingDetail: '',
      });
      nodeAssert.deepStrictEqual(decisionsForPage(ledger, 2), [
        { id: name.id, groupId: name.id, targetKey: 'identity\u0000identity\u0000name', valueJson: '"Ada Lovelace"', evidenceSegmentIds: ['segment-0001'], origin: 'repair', round: 1 },
        { id: title.id, groupId: title.id, targetKey: TITLE_KEY, valueJson: '"Engineer"', evidenceSegmentIds: ['segment-0002'], origin: 'adjudication', round: 1 },
      ]);
      const json = serializeDecisionLedger(ledger);
      const restored = deserializeDecisionLedger(json);
      assert(serializeDecisionLedger(restored) === json, 'serialization is canonical and round-trips');
      nodeAssert.deepStrictEqual(decisionForTarget(restored, 2, TITLE_KEY), title);
      nodeAssert.deepStrictEqual(decisionsForPage(restored, 3), decisionsForPage(ledger, 3));
      const edits = [edit('set', 'roles', 'p0002-role-1', 'title', 'Lead')];
      nodeAssert.deepStrictEqual(checkFindingAgainstLedger(restored, 2, finding(edits, title.id, ['segment-0002'])).errors,
        [`challenge of ${title.id} on roles/p0002-role-1/title cites no new evidence; already considered: segment-0002.`]);
      nodeAssert.throws(() => deserializeDecisionLedger('{"version":2,"targets":[]}'), /version 1/);
    },
  },
  {
    name: 'career profile edits: a coordinated decision group can be challenged by its groupId only with new evidence for every challenged target',
    run: () => {
      const ledger = createDecisionLedger();
      const MODE_KEY = 'skills\u0000p0002-skill-1\u0000supportMode';
      const DIRECT_KEY = 'skills\u0000p0002-skill-1\u0000directEvidenceSegmentIds';
      const INDEX_KEY = 'skills\u0000p0002-skill-1\u0000indexEligible';
      const GROUP = 'group-00000000000000aa';
      const settle = (targetKey, value) => recordDecision(ledger, {
        pageIndex: 2, targetKey, value, sourceQuote: 'Python', evidenceSegmentIds: ['segment-0003'],
        category: 'skills', round: 1, origin: 'audit', findingDetail: 'qualified', groupId: GROUP,
      });
      const mode = settle(MODE_KEY, 'relationship-qualified');
      const direct = settle(DIRECT_KEY, []);
      const index = settle(INDEX_KEY, false);
      assert(mode.groupId === GROUP && direct.groupId === GROUP && index.groupId === GROUP
        && new Set([mode.id, direct.id, index.id]).size === 3, 'decisions recorded with one groupId keep distinct ids');
      const flip = [
        edit('set', 'skills', 'p0002-skill-1', 'supportMode', 'direct'),
        edit('set', 'skills', 'p0002-skill-1', 'directEvidenceSegmentIds', ['segment-0004']),
        edit('set', 'skills', 'p0002-skill-1', 'indexEligible', true),
      ];
      nodeAssert.deepStrictEqual(checkFindingAgainstLedger(ledger, 2, finding(flip, GROUP, ['segment-0004'])),
        { ok: true, errors: [], challengedDecisions: [mode, direct, index] });
      nodeAssert.deepStrictEqual(checkFindingAgainstLedger(ledger, 2, finding(flip, GROUP, ['segment-0003'])).errors, [
        `challenge of ${mode.id} on skills/p0002-skill-1/supportMode cites no new evidence; already considered: segment-0003.`,
        `challenge of ${direct.id} on skills/p0002-skill-1/directEvidenceSegmentIds cites no new evidence; already considered: segment-0003.`,
        `challenge of ${index.id} on skills/p0002-skill-1/indexEligible cites no new evidence; already considered: segment-0003.`,
      ]);
      // New evidence must be new for EACH challenged target.
      recordChallengeEvidence(ledger, 2, MODE_KEY, ['segment-0004']);
      nodeAssert.deepStrictEqual(checkFindingAgainstLedger(ledger, 2, finding(flip, GROUP, ['segment-0004'])).errors,
        [`challenge of ${mode.id} on skills/p0002-skill-1/supportMode cites no new evidence; already considered: segment-0003, segment-0004.`]);
      nodeAssert.deepStrictEqual(checkFindingAgainstLedger(ledger, 2, finding([flip[2]], 'group-00000000000000bb', ['segment-0005'])).errors,
        [`challenge names group-00000000000000bb but skills/p0002-skill-1/indexEligible is currently settled by ${index.id} in group ${GROUP} (value false; evidence segment-0003).`]);
      nodeAssert.deepStrictEqual(checkFindingAgainstLedger(ledger, 2, finding([flip[2]])).errors,
        [`skills/p0002-skill-1/indexEligible is settled by ${index.id} in group ${GROUP} (value false; evidence segment-0003). Drop this finding, or challenge ${index.id} or ${GROUP} with evidence segments not yet considered.`]);
      nodeAssert.throws(() => recordDecision(ledger, {
        pageIndex: 2, targetKey: MODE_KEY, value: 'direct', sourceQuote: '', evidenceSegmentIds: [],
        category: 'skills', round: 2, origin: 'audit', findingDetail: '', groupId: '',
      }), /groupId/);
    },
  },
  {
    name: 'career profile edits: groupId is serialized, listed per page and survives a ledger round-trip',
    run: () => {
      const ledger = createDecisionLedger();
      const grouped = recordDecision(ledger, {
        pageIndex: 2, targetKey: TITLE_KEY, value: 'Lead', sourceQuote: 'Lead', evidenceSegmentIds: ['segment-0002'],
        category: 'attribution', round: 1, origin: 'adjudication', findingDetail: '', groupId: 'group-0123456789abcdef',
      });
      const json = serializeDecisionLedger(ledger);
      nodeAssert.deepStrictEqual(JSON.parse(json).targets[0].current.groupId, 'group-0123456789abcdef');
      const restored = deserializeDecisionLedger(json);
      assert(serializeDecisionLedger(restored) === json, 'grouped serialization round-trips byte for byte');
      nodeAssert.deepStrictEqual(decisionForTarget(restored, 2, TITLE_KEY), grouped);
      nodeAssert.deepStrictEqual(decisionsForPage(restored, 2), [
        { id: grouped.id, groupId: 'group-0123456789abcdef', targetKey: TITLE_KEY, valueJson: '"Lead"', evidenceSegmentIds: ['segment-0002'], origin: 'adjudication', round: 1 },
      ]);
      const edits = [edit('set', 'roles', 'p0002-role-1', 'title', 'Engineer')];
      nodeAssert.deepStrictEqual(checkFindingAgainstLedger(restored, 2, finding(edits, 'group-0123456789abcdef', ['segment-0006'])),
        { ok: true, errors: [], challengedDecisions: [grouped] });
      nodeAssert.deepStrictEqual(checkFindingAgainstLedger(restored, 2, finding(edits, 'group-0123456789abcdef', ['segment-0002'])).errors,
        [`challenge of ${grouped.id} on roles/p0002-role-1/title cites no new evidence; already considered: segment-0002.`]);
      // A legacy decision without groupId is its own group.
      const legacy = JSON.parse(json);
      delete legacy.targets[0].current.groupId;
      const legacyLedger = deserializeDecisionLedger(legacy);
      nodeAssert.deepStrictEqual(decisionsForPage(legacyLedger, 2)[0].groupId, grouped.id);
      nodeAssert.deepStrictEqual(checkFindingAgainstLedger(legacyLedger, 2, finding(edits, grouped.id, ['segment-0006'])).ok, true);
    },
  },
];
