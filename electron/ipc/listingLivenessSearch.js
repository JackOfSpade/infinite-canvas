// Search-time AI resolution of transient listing evidence. Rows carry only a
// bounded verdict pair; page text remains in the request-local evidence map.
import { buildListingLivenessRequest, validateListingLivenessResponse } from './listingLivenessAi.js';
import { bridgeLinked } from './handoffBridge/bridgeAvailability.js';
import { cappedHandoff } from './officialPostingService.js';
import { normalizeListingLiveness, normalizeOfficialPosting } from './officialPostingFields.js';
import { classifyListingLiveness } from './listingLiveness.js';
import { withListingClosed, withListingLiveness } from './officialPostingBoardClosed.js';
import { bumpListingLivenessCount, mergeListingLivenessTelemetry } from './listingLivenessTelemetry.js';
import {
  isListingLivenessBreakerTripped, listingEvidenceKey, memoListingVerdict,
  readListingEvidence, readListingVerdictMemo, recordListingEvidence, tripListingLivenessBreaker,
  readOfficialExpiryCandidates, setOfficialExpiryCandidateVerdict,
} from './listingLivenessStore.js';

const BUDGET_MS = 10 * 60 * 1_000;
const CHUNK_SIZE = 8;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1_000;
const AI_VERDICTS = new Set(['open', 'closed', 'unclear']);
const boardOf = (row, evidence) => row?.source || evidence?.board || '';
const ruleKeyOf = evidence => evidence?.ruleKey || evidence?.board || 'generic';
const resolvedOfficial = row => ['L1', 'L2', 'L3', 'L4'].includes(normalizeOfficialPosting(row?.officialPosting)?.level);
const rowState = row => normalizeListingLiveness(row?.listingLiveness);

function shouldTripBreaker(error) {
  const code = String(error?.code || '').toLowerCase();
  const message = String(error?.message || '').toLowerCase();
  return code === 'bridge-timeout' || code === 'bridge-unavailable' || code === 'comparative-unavailable'
    || code === 'not_linked' || code === 'not-linked' || code === 'listing_liveness_response_invalid'
    || /(?:invalid|validation|schema|json)/u.test(code)
    || /(?:bridge.*(?:unavailable|disabled|not linked)|not.linked)/u.test(message);
}

/**
 * One instance belongs to one resolveScoreSafePostings call. Primary and
 * alternate rounds share its deadline and count-only telemetry. The current
 * IPC request context supplies the evidence, memo and cross-seam breaker.
 */
export function createListingLivenessSearchSession({
  callText, bridgeStatus, calibrationStore = null, signal, nodeId = null, manualAiRunId = null,
  now = Date.now, abortError = () => new Error('Listing liveness cancelled.'),
} = {}) {
  if (typeof callText !== 'function' || typeof now !== 'function') {
    throw new TypeError('Listing liveness search requires a structured call and clock.');
  }
  const deadline = now() + BUDGET_MS;
  // The caller injects the bridge status reader. Invoke it once for this seam,
  // including when a linked single chat has no active worker pool.
  const linkedStatus = Promise.resolve().then(() => typeof bridgeStatus === 'function'
    ? bridgeStatus() : bridgeStatus).then(bridgeLinked).catch(() => false);
  const counts = {};
  const handoffStats = { handoffs: 0, handoffMs: 0 };
  const pendingByKey = new Map();
  const skippedOfficial = new Set();
  const countedDemotions = new Set();
  const countedPromotions = new Set();
  const countedExpiry = new Set();
  let localBreaker = false;
  let tail = Promise.resolve();

  const checkAbort = () => {
    if (signal?.aborted) throw signal.reason || abortError();
  };
  const breakerTripped = () => localBreaker || isListingLivenessBreakerTripped();
  const tripBreaker = () => { localBreaker = true; tripListingLivenessBreaker(); };
  const recordPending = member => { if (member.key) pendingByKey.set(member.key, member.board); };
  const clearPending = member => { if (member.key) pendingByKey.delete(member.key); };
  const countRuleChanges = (board, ruleKey, result) => {
    for (const id of result?.promoted || []) {
      const key = `${ruleKey}|${id}`;
      if (!countedPromotions.has(key)) { countedPromotions.add(key); bumpListingLivenessCount(counts, board, 'rulePromoted'); }
    }
    for (const id of result?.demoted || []) {
      const key = `${ruleKey}|${id}`;
      if (!countedDemotions.has(key)) { countedDemotions.add(key); bumpListingLivenessCount(counts, board, 'ruleDemoted'); }
    }
  };
  const stamp = (row, evidence, verdict, at) => verdict === 'closed'
    ? withListingClosed(row, { verdict, basis: 'ai', board: boardOf(row, evidence),
      reason: 'ai-confirmed-closed', now: new Date(at) })
    : withListingLiveness(row, { verdict, basis: 'ai', board: boardOf(row, evidence), now: new Date(at) });

  async function sendRound(members, output) {
    if (!members.length) return { disagreed: new Set(), confirmedClosed: new Set() };
    const sorted = [...members].sort((a, b) => a.key.localeCompare(b.key) || a.index - b.index);
    const chunks = Array.from({ length: Math.ceil(sorted.length / CHUNK_SIZE) },
      (_unused, index) => sorted.slice(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE));
    const disagreed = new Set(); const confirmedClosed = new Set();
    for (const [chunkIndex, chunk] of chunks.entries()) {
      checkAbort();
      if (breakerTripped()) break;
      if (!await linkedStatus) { tripBreaker(); break; }
      const remaining = Math.floor(deadline - now());
      if (remaining <= 0) break;
      const requestMembers = chunk.map(member => ({ row: member.expiry ? member.row : output[member.index],
        evidence: member.evidence }));
      const request = buildListingLivenessRequest(requestMembers,
        { batch: chunkIndex + 1, batchTotal: chunks.length });
      try {
        const raw = await cappedHandoff(request, { call: callText, signal, timeoutMs: remaining,
          manualAiRunId, nodeId, now, stats: handoffStats });
        checkAbort();
        let parsed = raw;
        if (typeof raw === 'string') {
          try { parsed = JSON.parse(raw); } catch { parsed = raw; }
        }
        const answer = validateListingLivenessResponse(parsed, requestMembers);
        checkAbort();
        // Do not publish a partial chunk if a calibration write or audit
        // suspension fails. The official resolution can still proceed.
        const staged = [];
        for (const response of answer.rows) {
          const member = chunk[Number(response.id.slice(1)) - 1];
          if (member.expiry) { staged.push({ member, response }); continue; }
          const ruleKey = ruleKeyOf(member.evidence);
          const at = now();
          const calibration = await calibrationStore?.recordAiAnswer?.({
            ruleKey, evidence: member.evidence, verdict: response.verdict, now: at });
          checkAbort();
          const auditClosed = member.audit === true && response.verdict === 'closed' && response.quote.trim() !== '';
          const activeRuleIds = auditClosed
            ? [...new Set((member.evidence.openSignals || []).filter(signal => signal?.state === 'active')
              .map(item => item.ruleId).filter(Boolean))] : [];
          for (const ruleId of activeRuleIds) {
            await calibrationStore?.demoteRule?.({ ruleKey, ruleId, now: at, suspendedUntil: at + SEVEN_DAYS_MS });
            checkAbort();
          }
          staged.push({ member, response, calibration, auditClosed, activeRuleIds, ruleKey, at });
        }
        checkAbort();
        for (const item of staged) {
          if (item.member.expiry) {
            setOfficialExpiryCandidateVerdict(item.member.row, item.member.url, item.response.verdict);
            continue;
          }
          const { member, response, calibration, auditClosed, activeRuleIds, ruleKey, at } = item;
          output[member.index] = stamp(output[member.index], member.evidence, response.verdict, at);
          memoListingVerdict(member.row, response.verdict);
          clearPending(member);
          bumpListingLivenessCount(counts, member.board, 'aiChecked');
          bumpListingLivenessCount(counts, member.board, `ai${response.verdict[0].toUpperCase()}${response.verdict.slice(1)}`);
          if (member.audit) bumpListingLivenessCount(counts, member.board, 'auditChecked');
          if (member.audit && response.verdict === 'closed') confirmedClosed.add(member.index);
          if (auditClosed) {
            disagreed.add(member.index);
            bumpListingLivenessCount(counts, member.board, 'auditDisagreed');
          }
          countRuleChanges(member.board, ruleKey, calibration);
          for (const ruleId of activeRuleIds) countRuleChanges(member.board, ruleKey, { demoted: [ruleId] });
        }
      } catch (error) {
        checkAbort();
        if (shouldTripBreaker(error)) tripBreaker();
        // A failed chunk remains in its prior state; sibling chunks can still
        // proceed unless this was the specific circuit-breaker condition.
      }
    }
    return { disagreed, confirmedClosed };
  }

  async function runPrimary(rows) {
    checkAbort();
    const output = Array.isArray(rows) ? [...rows] : [];
    const pending = []; const auditByBoard = new Map();
    for (const [index, row] of output.entries()) {
      const key = listingEvidenceKey(row);
      const evidence = readListingEvidence(row);
      const board = boardOf(row, evidence);
      const memo = readListingVerdictMemo(row);
      if (evidence && AI_VERDICTS.has(memo)) {
        output[index] = stamp(row, evidence, memo, now());
        continue;
      }
      const state = rowState(row);
      if (state?.verdict === 'pending') {
        if (resolvedOfficial(row)) {
          if (key && !skippedOfficial.has(key)) {
            skippedOfficial.add(key); bumpListingLivenessCount(counts, board, 'aiSkippedOfficial');
          }
        } else if (evidence) {
          const member = { row, index, key, board, evidence, audit: false };
          pending.push(member); recordPending(member);
        }
      } else if (state?.verdict === 'open' && state.basis === 'open-marker' && !resolvedOfficial(row) && evidence) {
        const member = { row, index, key, board, evidence, audit: true };
        if (!auditByBoard.has(board)) auditByBoard.set(board, []);
        auditByBoard.get(board).push(member);
      }
    }
    const allAudit = [...auditByBoard.values()].flat();
    const sampled = [];
    for (const group of auditByBoard.values()) {
      group.sort((a, b) => a.key.localeCompare(b.key) || a.index - b.index);
      for (const [index, member] of group.entries()) if (index % 8 === 0) sampled.push(member);
    }
    const auditResult = await sendRound([...pending, ...sampled], output);
    checkAbort();
    if (auditResult.disagreed.size) {
      const boards = new Set(allAudit.filter(member => auditResult.disagreed.has(member.index)).map(member => member.board));
      const roundB = [];
      for (const member of allAudit) {
        if (!boards.has(member.board) || auditResult.confirmedClosed.has(member.index)) continue;
        // Recording the same captured page clears any Phase A memo. A stale
        // open answer must never resurrect after an audit disagreed with it.
        recordListingEvidence(member.row, member.evidence);
        output[member.index] = withListingLiveness(output[member.index], {
          verdict: 'pending', basis: 'neither', board: member.board, now: new Date(now()),
        });
        const retry = { ...member, row: output[member.index] };
        roundB.push(retry); recordPending(retry);
      }
      await sendRound(roundB, output);
      checkAbort();
    }
    return output;
  }

  async function runAlternates(rows) {
    checkAbort();
    const output = Array.isArray(rows) ? [...rows] : [];
    const pending = [];
    for (const [index, row] of output.entries()) {
      const evidence = readListingEvidence(row);
      if (!evidence) continue;
      const memo = readListingVerdictMemo(row);
      if (AI_VERDICTS.has(memo)) { output[index] = stamp(row, evidence, memo, now()); continue; }
      if (rowState(row)?.verdict !== 'pending') continue;
      const member = { row, index, key: listingEvidenceKey(row), board: boardOf(row, evidence), evidence, audit: false };
      pending.push(member); recordPending(member);
    }
    await sendRound(pending, output);
    checkAbort();
    return output;
  }

  async function runExpiryCandidates(rows) {
    checkAbort();
    const input = Array.isArray(rows) ? rows : [];
    const pending = [];
    for (const [index, row] of input.entries()) {
      const posting = normalizeOfficialPosting(row?.officialPosting);
      if (!posting || !['not-found', 'closed'].includes(posting.outcome)
        || !posting.trail?.includes('closed')) continue;
      for (const candidate of readOfficialExpiryCandidates(row)) {
        if (AI_VERDICTS.has(candidate.verdict) || !candidate.evidence) continue;
        const decision = classifyListingLiveness(candidate.evidence);
        if (['open', 'closed'].includes(decision.verdict)) {
          setOfficialExpiryCandidateVerdict(row, candidate.url, decision.verdict);
        } else if (decision.verdict === 'needs-ai') {
          pending.push({ row, index, key: `${listingEvidenceKey(row)}|${candidate.url}`,
            board: boardOf(row, candidate.evidence), evidence: candidate.evidence,
            url: candidate.url, expiry: true });
        }
      }
    }
    await sendRound(pending, []);
    checkAbort();
    for (const row of input) for (const candidate of readOfficialExpiryCandidates(row)) {
      const key = `${listingEvidenceKey(row)}|${candidate.url}`;
      if (countedExpiry.has(key)) continue;
      countedExpiry.add(key);
      bumpListingLivenessCount(counts, boardOf(row, candidate.evidence), candidate.verdict === 'closed'
        ? 'expiryCandidatesConfirmedClosed' : 'expiryCandidatesNotConfirmed');
    }
  }

  // A queue also guards concurrency one if a caller starts both stages before
  // awaiting the first; rejected work does not poison later queued calls.
  const enqueue = operation => {
    const result = tail.then(operation);
    tail = result.catch(() => {});
    return result;
  };
  return Object.freeze({
    classifyPrimary: rows => enqueue(() => runPrimary(rows)),
    classifyAlternates: rows => enqueue(() => runAlternates(rows)),
    classifyExpiryCandidates: rows => enqueue(() => runExpiryCandidates(rows)),
    telemetry: () => {
      const block = mergeListingLivenessTelemetry(counts);
      for (const board of pendingByKey.values()) bumpListingLivenessCount(block, board, 'aiPending');
      return { listingLiveness: block, handoffStats: { ...handoffStats } };
    },
  });
}
