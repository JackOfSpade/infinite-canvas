import { assert } from './testHelpers.js';
import {
  DUPLICATE_RESPONSE_MIN_CHARS,
  assessPastedResponse,
  extractPasteEnvelopeIdentity,
  normalizePastedResponse,
  responseFingerprint,
} from '../../src/utils/pasteIdentityGuard.js';

const longText = (char, extra = '') => `${char.repeat(DUPLICATE_RESPONSE_MIN_CHARS)}${extra}`;

const applicationEnvelope = ({ jobId, stage, handoffCode }) => (
  `{"protocol":"application-handoff-v1","jobId":"${jobId}","stage":"${stage}","handoffCode":"${handoffCode}","baseHashes":{}}`
);

export default [
  {
    name: 'pasteIdentityGuard: normalizePastedResponse collapses newline conventions and trims',
    run: () => {
      assert(normalizePastedResponse('a\r\nb\r\nc') === 'a\nb\nc', 'CRLF must collapse to \\n');
      assert(normalizePastedResponse('a\rb\rc') === 'a\nb\nc', 'a lone CR must collapse to \\n');
      assert(normalizePastedResponse('  \n hello \n  ') === 'hello', 'surrounding whitespace must be trimmed');
      assert(normalizePastedResponse(null) === '' && normalizePastedResponse(undefined) === '', 'non-strings become empty');
      assert(normalizePastedResponse(12345) === '', 'a number is not a string');
      assert(normalizePastedResponse('') === '', 'an empty string stays empty');
    },
  },
  {
    name: 'pasteIdentityGuard: responseFingerprint floors short text and is stable and length-sensitive',
    run: () => {
      const belowFloor = longText('a', '').slice(0, DUPLICATE_RESPONSE_MIN_CHARS - 1);
      assert(belowFloor.length === DUPLICATE_RESPONSE_MIN_CHARS - 1, 'sanity check on the fixture length');
      assert(responseFingerprint(belowFloor) === '', 'text shorter than the floor must never be fingerprinted');
      assert(responseFingerprint('short') === '', 'a short legitimately-repeatable answer must never be fingerprinted');
      assert(responseFingerprint('') === '', 'empty text must never be fingerprinted');

      const atFloor = longText('a');
      assert(atFloor.length === DUPLICATE_RESPONSE_MIN_CHARS, 'sanity check on the at-floor fixture');
      const fpAtFloor = responseFingerprint(atFloor);
      assert(fpAtFloor !== '', 'text at the floor must be fingerprinted');
      assert(fpAtFloor === responseFingerprint(atFloor), 'identical text must yield an identical fingerprint');
      assert(fpAtFloor.endsWith(`-${DUPLICATE_RESPONSE_MIN_CHARS}`), 'the normalized length must be part of the value');

      const different = longText('b');
      assert(responseFingerprint(different) !== fpAtFloor, 'different text must yield a different fingerprint');

      // Normalization happens before fingerprinting, so CRLF vs \n text that
      // is otherwise identical must fingerprint the same.
      const withCrlf = longText('c').slice(0, DUPLICATE_RESPONSE_MIN_CHARS - 2).concat('\r\n');
      const withLf = withCrlf.replace('\r\n', '\n');
      assert(responseFingerprint(withCrlf) === responseFingerprint(withLf), 'fingerprinting must normalize newlines first');

      // Same hash, different length must not collide: appending the length
      // guards against a bare 53-bit collision reading as a duplicate.
      const short1 = responseFingerprint(longText('d'));
      const short2 = responseFingerprint(longText('d', 'x'));
      assert(short1 !== short2, 'appending the length must distinguish same-prefix texts of different length');
    },
  },
  {
    name: 'pasteIdentityGuard: extractPasteEnvelopeIdentity reads an application JSON envelope',
    run: () => {
      const text = applicationEnvelope({ jobId: 'job-42', stage: 'resume', handoffCode: 'fZ8kQ1v3nT7pLwXyBc2dGh4j' });
      const identity = extractPasteEnvelopeIdentity(text);
      assert(identity.jobId === 'job-42', `expected jobId job-42, got ${identity.jobId}`);
      assert(identity.stage === 'resume', `expected stage resume, got ${identity.stage}`);
      assert(identity.handoffCode === 'fZ8kQ1v3nT7pLwXyBc2dGh4j', `expected the application handoffCode, got ${identity.handoffCode}`);
      assert(identity.pushStamps.length === 0, 'an application envelope carries no push stamp');
    },
  },
  {
    name: 'pasteIdentityGuard: extractPasteEnvelopeIdentity reads a fenced ```json block',
    run: () => {
      const text = [
        'Here is the completed bundle:',
        '',
        '```json',
        '{',
        '  "protocol": "application-handoff-v1",',
        '  "jobId": "job-77",',
        '  "stage": "cover-letter",',
        '  "handoffCode": "AbCdEf1234567890_-ghijk",',
        '  "baseHashes": {}',
        '}',
        '```',
      ].join('\n');
      const identity = extractPasteEnvelopeIdentity(text);
      assert(identity.jobId === 'job-77', `expected jobId job-77 inside the fence, got ${identity.jobId}`);
      assert(identity.stage === 'cover-letter', `expected stage cover-letter, got ${identity.stage}`);
      assert(identity.handoffCode === 'AbCdEf1234567890_-ghijk', `expected the fenced handoffCode, got ${identity.handoffCode}`);
    },
  },
  {
    name: 'pasteIdentityGuard: extractPasteEnvelopeIdentity reads a push Handoff: header and no envelope fields',
    run: () => {
      const text = 'Handoff: HANDOFF-K7Q3M2\n\n{"scores": [{"id": "a", "score": 4}]}';
      const identity = extractPasteEnvelopeIdentity(text);
      assert(identity.pushStamps.length === 1 && identity.pushStamps[0] === 'HANDOFF-K7Q3M2', `expected one push stamp, got ${JSON.stringify(identity.pushStamps)}`);
      assert(identity.jobId === null, 'a push response carries no jobId');
      assert(identity.handoffCode === null, 'a push response carries no JSON handoffCode property');
      assert(identity.stage === null, 'a push response carries no stage');

      // Lowercase and mixed-case stamps must still be recognised and are
      // reported uppercase.
      const mixedCase = 'handoff: handoff-k7q3m2\nsome text';
      const mixedIdentity = extractPasteEnvelopeIdentity(mixedCase);
      assert(mixedIdentity.pushStamps[0] === 'HANDOFF-K7Q3M2', 'a lowercase stamp must be normalized to uppercase');

      // Two distinct stamps in one paste must both be captured.
      const two = 'HANDOFF-K7Q3M2 and later HANDOFF-9V2W4X appear in this text.';
      const twoIdentity = extractPasteEnvelopeIdentity(two);
      assert(
        twoIdentity.pushStamps.length === 2
          && twoIdentity.pushStamps.includes('HANDOFF-K7Q3M2')
          && twoIdentity.pushStamps.includes('HANDOFF-9V2W4X'),
        `expected both stamps, got ${JSON.stringify(twoIdentity.pushStamps)}`,
      );
    },
  },
  {
    name: 'pasteIdentityGuard: extractPasteEnvelopeIdentity finds nothing in ordinary text',
    run: () => {
      const identity = extractPasteEnvelopeIdentity('Just a plain paragraph of prose with no codes or JSON in it at all.');
      assert(identity.jobId === null && identity.handoffCode === null && identity.stage === null, 'no identity markers must be found');
      assert(identity.pushStamps.length === 0, 'no push stamps must be found');
      assert(extractPasteEnvelopeIdentity('').jobId === null, 'empty text must not throw and must find nothing');
      assert(extractPasteEnvelopeIdentity(null).pushStamps.length === 0, 'a non-string must not throw');
    },
  },
  {
    name: 'pasteIdentityGuard: extractPasteEnvelopeIdentity is stable across repeated calls (no shared /g regex state)',
    run: () => {
      // A shared /g regex reused across calls carries its lastIndex forward
      // and silently drops matches on the next call — the exact trap
      // documented next to findMismatchedHandoffStamp in NonApiAiDialog.jsx.
      const text = 'Handoff: HANDOFF-K7Q3M2\nsecond stamp HANDOFF-9V2W4X here too, '
        + applicationEnvelope({ jobId: 'job-1', stage: 'resume', handoffCode: 'code0000000000000000000' });
      const first = extractPasteEnvelopeIdentity(text);
      const second = extractPasteEnvelopeIdentity(text);
      const third = extractPasteEnvelopeIdentity(text);
      assert(JSON.stringify(first) === JSON.stringify(second), 'a second call must return the same result as the first');
      assert(JSON.stringify(second) === JSON.stringify(third), 'a third call must still return the same result');
      assert(first.pushStamps.length === 2, `expected both stamps every call, got ${JSON.stringify(first.pushStamps)}`);
      assert(first.jobId === 'job-1', 'the JSON field extraction must also stay stable across repeated calls');
    },
  },
  {
    name: 'pasteIdentityGuard: extractPasteEnvelopeIdentity rejects an over-long value',
    run: () => {
      const hugeJobId = 'x'.repeat(250);
      const text = `{"jobId":"${hugeJobId}","stage":"resume","handoffCode":"short-code"}`;
      const identity = extractPasteEnvelopeIdentity(text);
      assert(identity.jobId === null, `a 250-char value must be rejected, got ${identity.jobId}`);
      // The other, normally-sized fields on the same line must still resolve
      // — the rejection is per-value, not a parse failure for the whole text.
      assert(identity.stage === 'resume', 'a sibling field must still be read');
      assert(identity.handoffCode === 'short-code', 'a sibling field must still be read');

      // A value that is only whitespace must also be rejected (non-empty
      // after trim).
      const blankValue = '{"jobId":"   ","stage":"resume"}';
      assert(extractPasteEnvelopeIdentity(blankValue).jobId === null, 'a whitespace-only value must be rejected');
    },
  },
  {
    name: 'pasteIdentityGuard: assessPastedResponse is a no-op on blank text or a missing active request',
    run: () => {
      const activeRequest = { requestId: 'r1', jobId: 'job-1', handoffCode: 'code-1' };
      assert(
        JSON.stringify(assessPastedResponse({ response: '', activeRequest, queuedRequests: [], priorSubmissions: [] })) === JSON.stringify({ block: null, notice: null }),
        'empty text must never block or notice',
      );
      assert(
        JSON.stringify(assessPastedResponse({ response: '   \n  ', activeRequest, queuedRequests: [], priorSubmissions: [] })) === JSON.stringify({ block: null, notice: null }),
        'whitespace-only text must never block or notice',
      );
      assert(
        JSON.stringify(assessPastedResponse({ response: 'some real text', activeRequest: null, queuedRequests: [], priorSubmissions: [] })) === JSON.stringify({ block: null, notice: null }),
        'a missing active request must never block or notice',
      );
    },
  },
  {
    name: 'pasteIdentityGuard: assessPastedResponse blocks on a handoffCode owned by another queued prompt',
    run: () => {
      const active = { requestId: 'active', jobId: 'job-1', handoffCode: 'code-active' };
      const other = { requestId: 'other', jobId: 'job-2', handoffCode: 'code-other' };
      const queuedRequests = [active, other];
      const response = applicationEnvelope({ jobId: 'job-2', stage: 'resume', handoffCode: 'code-other' });
      const { block, notice } = assessPastedResponse({ response, activeRequest: active, queuedRequests, priorSubmissions: [] });
      assert(notice === null, 'a code-ownership conflict must never carry a notice');
      assert(block && block.reason === 'other-queued-prompt', `expected other-queued-prompt, got ${JSON.stringify(block)}`);
      assert(block.ownerRequestId === 'other', `expected owner other, got ${block.ownerRequestId}`);
      assert(block.detail.includes('code-other'), 'the detail must name the evidence');
    },
  },
  {
    name: 'pasteIdentityGuard: assessPastedResponse blocks on a jobId owned by another queued prompt',
    run: () => {
      const active = { requestId: 'active', jobId: 'job-1', handoffCode: 'code-active' };
      const other = { requestId: 'other', jobId: 'job-2', handoffCode: 'code-other' };
      const queuedRequests = [active, other];
      // A different handoffCode of its own, but the jobId belongs to `other`.
      const response = applicationEnvelope({ jobId: 'job-2', stage: 'resume', handoffCode: 'unrelated-code' });
      const { block } = assessPastedResponse({ response, activeRequest: active, queuedRequests, priorSubmissions: [] });
      assert(block && block.reason === 'other-queued-prompt', `expected other-queued-prompt, got ${JSON.stringify(block)}`);
      assert(block.ownerRequestId === 'other', `expected owner other, got ${block.ownerRequestId}`);
    },
  },
  {
    name: 'pasteIdentityGuard: assessPastedResponse blocks a scoring stamp owned by another queued push prompt',
    run: () => {
      // The mirror-image cross-paste case: an application prompt is active,
      // and the pasted text is actually a job-scoring answer belonging to a
      // different push prompt still in the queue.
      const active = { requestId: 'application:job-1', jobId: 'job-1', handoffCode: 'appCode000000000000000', kind: 'application' };
      const pushOther = { requestId: 'push-2', handoffCode: 'HANDOFF-K7Q3M2', kind: 'scoring' };
      const queuedRequests = [active, pushOther];
      const response = 'Handoff: HANDOFF-K7Q3M2\n\n{"scores": []}';
      const { block } = assessPastedResponse({ response, activeRequest: active, queuedRequests, priorSubmissions: [] });
      assert(block && block.reason === 'other-queued-prompt', `expected other-queued-prompt, got ${JSON.stringify(block)}`);
      assert(block.ownerRequestId === 'push-2', `expected owner push-2, got ${block.ownerRequestId}`);
    },
  },
  {
    name: 'pasteIdentityGuard: assessPastedResponse never blocks on a code no queued prompt owns, or on the active prompt\'s own code',
    run: () => {
      const active = { requestId: 'active', jobId: 'job-1', handoffCode: 'HANDOFF-K7Q3M2' };
      const other = { requestId: 'other', jobId: 'job-2', handoffCode: 'HANDOFF-9V2W4X' };
      const queuedRequests = [active, other];

      // A stamp that matches NOTHING in the queue — must not be treated as
      // suspicious merely for differing from the active prompt's own code.
      const unownedStamp = assessPastedResponse({
        response: 'Handoff: HANDOFF-Z2Z2Z2\n\n{"scores": []}',
        activeRequest: active,
        queuedRequests,
        priorSubmissions: [],
      });
      assert(unownedStamp.block === null, `an unowned code must never block, got ${JSON.stringify(unownedStamp.block)}`);

      // The active prompt's own code, correctly echoed back.
      const ownCode = assessPastedResponse({
        response: 'Handoff: HANDOFF-K7Q3M2\n\n{"scores": []}',
        activeRequest: active,
        queuedRequests,
        priorSubmissions: [],
      });
      assert(ownCode.block === null, `the active prompt's own code must never block, got ${JSON.stringify(ownCode.block)}`);

      // The active prompt's own jobId, correctly echoed back in a JSON body.
      const ownJobId = assessPastedResponse({
        response: applicationEnvelope({ jobId: 'job-1', stage: 'resume', handoffCode: 'HANDOFF-K7Q3M2' }),
        activeRequest: active,
        queuedRequests,
        priorSubmissions: [],
      });
      assert(ownJobId.block === null, 'the active prompt\'s own jobId must never block');
    },
  },
  {
    name: 'pasteIdentityGuard: assessPastedResponse blocks a duplicate accepted elsewhere under a conclusively different prompt',
    run: () => {
      const active = { requestId: 'active', jobId: 'job-1', handoffCode: 'code-active' };
      const elsewhere = { requestId: 'elsewhere', jobId: 'job-2', handoffCode: 'code-elsewhere' };
      const text = longText('q');
      const priorSubmissions = [{
        fingerprint: responseFingerprint(text),
        requestId: 'elsewhere',
        handoffCode: 'code-elsewhere',
        jobId: 'job-2',
        label: 'Acme Corp',
        accepted: true,
      }];
      const { block, notice } = assessPastedResponse({
        response: text,
        activeRequest: active,
        queuedRequests: [active, elsewhere],
        priorSubmissions,
      });
      assert(notice === null, 'a cross-prompt duplicate block must not also carry a notice');
      assert(block && block.reason === 'already-submitted', `expected already-submitted, got ${JSON.stringify(block)}`);
      assert(block.ownerRequestId === 'elsewhere', `expected owner elsewhere, got ${block.ownerRequestId}`);
      assert(block.ownerLabel === null, 'ownerLabel is only set once the owner has left the queue');

      // Same scenario, but the owning request has since left the queue —
      // the label must be carried instead of a dead requestId.
      const { block: blockAfterLeaving } = assessPastedResponse({
        response: text,
        activeRequest: active,
        queuedRequests: [active],
        priorSubmissions,
      });
      assert(blockAfterLeaving.ownerRequestId === null, 'a departed owner must not be pointed at');
      assert(blockAfterLeaving.ownerLabel === 'Acme Corp', `expected the label to be carried, got ${blockAfterLeaving.ownerLabel}`);
    },
  },
  {
    name: 'pasteIdentityGuard: assessPastedResponse does not block a duplicate that was only rejected elsewhere',
    run: () => {
      // The whole point of the accepted-only rule: a response rejected for
      // prompt 1 because it was actually prompt 2's answer is correctly
      // re-pasted into prompt 2. Blocking it here would strand the person
      // holding the right answer with no way to submit it.
      const active = { requestId: 'active', jobId: 'job-2', handoffCode: 'code-active' };
      const rejectedElsewhere = { requestId: 'elsewhere', jobId: 'job-1', handoffCode: 'code-elsewhere' };
      const text = longText('r');
      const priorSubmissions = [{
        fingerprint: responseFingerprint(text),
        requestId: 'elsewhere',
        handoffCode: 'code-elsewhere',
        jobId: 'job-1',
        label: 'Rejected Prompt',
        accepted: false,
      }];
      const { block, notice } = assessPastedResponse({
        response: text,
        activeRequest: active,
        queuedRequests: [active, rejectedElsewhere],
        priorSubmissions,
      });
      assert(block === null, `a rejected-elsewhere duplicate must not block, got ${JSON.stringify(block)}`);
      assert(notice === null, 'it belongs to a different requestId, so it is not the own-repeat notice either');
    },
  },
  {
    name: 'pasteIdentityGuard: assessPastedResponse does not block an accepted duplicate under the same handoff code',
    run: () => {
      // A stepped-back or reissued request can carry a NEW requestId for
      // the SAME logical prompt (same handoffCode). Re-submitting identical
      // text there is legitimate, not a duplicate across two prompts.
      const active = { requestId: 'active-v2', jobId: 'job-1', handoffCode: 'shared-code' };
      const priorAcceptedSameCode = { requestId: 'active-v1', jobId: 'job-1', handoffCode: 'shared-code' };
      const text = longText('s');
      const priorSubmissions = [{
        fingerprint: responseFingerprint(text),
        requestId: 'active-v1',
        handoffCode: 'shared-code',
        jobId: 'job-1',
        label: 'Same Prompt',
        accepted: true,
      }];
      const { block, notice } = assessPastedResponse({
        response: text,
        activeRequest: active,
        queuedRequests: [active, priorAcceptedSameCode],
        priorSubmissions,
      });
      assert(block === null, `an accepted duplicate under the same handoff code must not block, got ${JSON.stringify(block)}`);
      assert(notice === null, 'the prior entry belongs to a different requestId, so it is not the own-repeat notice');

      // And the same must hold when either side's code is simply missing —
      // "cannot prove they differ" must not be treated as a difference.
      const activeNoCode = { requestId: 'active-v2', jobId: 'job-1', handoffCode: '' };
      const priorSubmissionsNoCode = [{
        fingerprint: responseFingerprint(text),
        requestId: 'active-v1',
        handoffCode: 'shared-code',
        jobId: 'job-1',
        label: 'Same Prompt',
        accepted: true,
      }];
      const missingCodeResult = assessPastedResponse({
        response: text,
        activeRequest: activeNoCode,
        queuedRequests: [activeNoCode],
        priorSubmissions: priorSubmissionsNoCode,
      });
      assert(missingCodeResult.block === null, 'a missing code on either side must not be treated as proof of a difference');
    },
  },
  {
    name: 'pasteIdentityGuard: assessPastedResponse never blocks a duplicate below the fingerprint floor',
    run: () => {
      const active = { requestId: 'active', jobId: 'job-1', handoffCode: 'code-active' };
      const elsewhere = { requestId: 'elsewhere', jobId: 'job-2', handoffCode: 'code-elsewhere' };
      const shortText = 'Yes, proceed.';
      // Even with a matching accepted prior submission recorded (however
      // that could happen for text this short), an empty fingerprint means
      // rule 3/4 never runs at all.
      const priorSubmissions = [{
        fingerprint: '',
        requestId: 'elsewhere',
        handoffCode: 'code-elsewhere',
        jobId: 'job-2',
        label: 'Acme Corp',
        accepted: true,
      }];
      const { block, notice } = assessPastedResponse({
        response: shortText,
        activeRequest: active,
        queuedRequests: [active, elsewhere],
        priorSubmissions,
      });
      assert(block === null && notice === null, 'text below the fingerprint floor must never block or notice on duplicate content');
    },
  },
  {
    name: 'pasteIdentityGuard: assessPastedResponse notices (never blocks) a repeat of the active prompt\'s own rejected text',
    run: () => {
      const active = { requestId: 'active', jobId: 'job-1', handoffCode: 'code-v2' };
      const text = longText('t');
      const priorSubmissions = [{
        fingerprint: responseFingerprint(text),
        requestId: 'active',
        handoffCode: 'code-v1',
        jobId: 'job-1',
        label: 'This Prompt',
        accepted: false,
      }];
      const { block, notice } = assessPastedResponse({
        response: text,
        activeRequest: active,
        queuedRequests: [active],
        priorSubmissions,
      });
      assert(block === null, 'a same-request repeat must never block');
      assert(notice && notice.reason === 'repeat-of-own-rejected', `expected repeat-of-own-rejected, got ${JSON.stringify(notice)}`);
      assert(notice.ownerRequestId === 'active', `expected ownerRequestId active, got ${notice.ownerRequestId}`);
    },
  },
  {
    name: 'pasteIdentityGuard: assessPastedResponse never throws on null, undefined, or garbage inputs',
    run: () => {
      const attempts = [
        undefined,
        {},
        { response: null, activeRequest: null, queuedRequests: null, priorSubmissions: null },
        { response: 123, activeRequest: 'not an object', queuedRequests: 'nope', priorSubmissions: 'nope' },
        { response: longText('u'), activeRequest: {}, queuedRequests: [null, undefined, {}], priorSubmissions: [null, undefined, {}] },
        { response: longText('v'), activeRequest: { requestId: 'x' }, queuedRequests: [{ requestId: 'x' }, null], priorSubmissions: [{ fingerprint: null }, { accepted: true }] },
      ];
      for (const args of attempts) {
        let result;
        let threw = false;
        try { result = assessPastedResponse(args); } catch { threw = true; }
        assert(!threw, `assessPastedResponse must never throw, args: ${JSON.stringify(args)}`);
        assert(
          result && ('block' in result) && ('notice' in result),
          `assessPastedResponse must always return a { block, notice } shape, got ${JSON.stringify(result)}`,
        );
      }
    },
  },
];
