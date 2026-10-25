// Shared production truth predicates used by the v2 content gate.
import { targetCompanyNames, targetIntentCompanyNames } from './coverLetterChecks.js';
export function targetIdentityNameLicensed(sentence, finding, ctx, { reportsNoPastWork, attributionTerms, sentenceAddressesTarget, groundingClauses, hasWorkIngWord, hasCandidateNonIntentClause, targetEmploymentIntentClause, speaksOnlyOfApplicationIntent, nonEmploymentTargetReference }) {
  if (finding?.code !== 'name') return false;
  const text = String(sentence ?? '');
  const noPastWork = reportsNoPastWork(text);
  const forwardReference = index => /\b(?:apply(?:ing)? for|interested in|would\b[^.!?]{0,100}\b(?:bring|contribute|support)\b|could\b[^.!?]{0,100}\b(?:contribute|support)\b)[^.!?]{0,140}$/iu.test(text.slice(0, index));
  const escape = value => String(value).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const phrase = value => attributionTerms(value).map(escape).join('[^\\p{L}\\p{N}]+');
  const spans = [];
  const title = String(ctx?.targetTitle || '').trim();
  if (title) {
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${phrase(title)}(?=[^\\p{L}\\p{N}]*(?:role|position|job|opportunity)\\b)`, 'giu');
    for (const match of text.matchAll(pattern)) if (noPastWork || forwardReference(match.index)) spans.push([match.index, match.index + match[0].length]);
    const terms = attributionTerms(title);
    for (let first = 0; first < terms.length; first += 1) {
      for (let last = first + 2; last <= terms.length; last += 1) {
        const fragment = terms.slice(first, last).map(escape).join('[^\\p{L}\\p{N}]+');
        const target = new RegExp(`(?<![\\p{L}\\p{N}])${fragment}(?=[^\\p{L}\\p{N}]*(?:role|position|job|opportunity|team|group|product|department)\\b)`, 'giu');
        for (const match of text.matchAll(target)) if (noPastWork || forwardReference(match.index)) spans.push([match.index, match.index + match[0].length]);
        if (fragment && ctx?.targetCompany) {
          const employer = phrase(ctx.targetCompany);
          const owned = new RegExp(`(?<![\\p{L}\\p{N}])${employer}['’]s\\s+${fragment}(?![\\p{L}\\p{N}])`, 'giu');
          for (const match of text.matchAll(owned)) if (noPastWork || forwardReference(match.index)) spans.push([match.index, match.index + match[0].length]);
        }
        if (sentenceAddressesTarget(text, ctx?.targetCompany || '')) {
          const recipient = new RegExp(`\\b(?:to|for|on)\\s+(?:the\\s+)?${fragment}(?![\\p{L}\\p{N}])`, 'giu');
          for (const match of text.matchAll(recipient)) if (noPastWork || forwardReference(match.index)) spans.push([match.index, match.index + match[0].length]);
        }
        const named = new RegExp(`(?<![\\p{L}\\p{N}])${fragment}(?![\\p{L}\\p{N}])`, 'giu');
        for (const match of text.matchAll(named)) if (forwardReference(match.index)) spans.push([match.index, match.index + match[0].length]);
      }
    }
    for (const term of terms.filter(value => /^(?:I|II|III|IV|V|VI|VII|VIII|IX|X)$/iu.test(value))) {
      const level = new RegExp(`\\blevel\\s+${escape(term)}(?=\\s+(?:role|position|job|opportunity)\\b)`, 'giu');
      for (const match of text.matchAll(level)) if (noPastWork || forwardReference(match.index)) spans.push([match.index, match.index + match[0].length]);
    }
  }
  const company = String(ctx?.targetCompany || '').trim();
  // Boards sometimes append a product description to the employer name.
  // Its exact prefix is a target reference too, including its possessive;
  // this licenses no claim that the candidate previously worked there.
  const companyNames = targetCompanyNames(company).filter(name => name.length >= 3);
  // A distinctive brand prefix is licensed only by a complete joining intent
  // or application opener. A sibling claim keeps the whole sentence outside
  // these closed frames, and ordinary employment receives no new exemption.
  if (targetEmploymentIntentClause(text, company)
    || (typeof speaksOnlyOfApplicationIntent === 'function' && speaksOnlyOfApplicationIntent(text, company, ctx?.targetTitle))) {
    for (const name of targetIntentCompanyNames(company).filter(name => !companyNames.includes(name))) {
      const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${phrase(name)}(?:['’]s)?(?![\\p{L}\\p{N}])`, 'giu');
      for (const match of text.matchAll(pattern)) spans.push([match.index, match.index + match[0].length]);
    }
  }
  const need = String.raw`(?:needs?|requirements?|priorit(?:y|ies)|goals?|mission|roadmap|challenges?|problems?|standards?)`;
  const word = String.raw`[\p{L}'’-]+`;
  const needPhrase = new RegExp(`^\\s+(?:${word}\\s+){0,2}${need}\\b`, 'iu');
  const clauseWindow = (at, end) => {
    let start = 0;
    for (const clause of groundingClauses(text)) if (clause.start <= at) start = Math.max(start, clause.start);
    for (const boundary of text.slice(0, at).matchAll(/\b(?:which|that|who|and|so)\s+/giu)) start = Math.max(start, boundary.index + boundary[0].length);
    return { before: text.slice(start, at), text: text.slice(start, end) };
  };
  for (const name of companyNames) if (sentenceAddressesTarget(text, name)) {
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${phrase(name)}(?:['’]s)?(?![\\p{L}\\p{N}])`, 'giu');
    for (const match of text.matchAll(pattern)) {
      const at = match.index;
      const end = at + match[0].length;
      const after = text.slice(end);
      const noun = after.match(needPhrase);
      const window = clauseWindow(at, end + (noun?.[0].length || 0));
      const possessive = /['’]s$/iu.test(match[0]);
      const subjectPosition = !possessive && /^\s*$/u.test(window.before);
      // A new employer-subject clause cannot attribute earlier candidate work
      // to the employer. Check this before the legacy no-past-work shortcut,
      // which intentionally does not classify present/irregular work verbs.
      const earlier = text.slice(0, at).replace(/[,;]?\s*(?:and|so|which|that|who)\s*$/iu, '').trim();
      if (subjectPosition && hasCandidateNonIntentClause(earlier, company, ctx?.targetTitle)
        && !nonEmploymentTargetReference(earlier)) continue;
      if (noPastWork || forwardReference(at)) { spans.push([at, end]); continue; }
      const deny = /\b(?:at|for|with|inside|within|on|using|via|under|from|during|after|since)\s+$/iu.test(window.before)
        || /\b(?:joined|joining|served|serves|helped|helps|worked)\s+$/iu.test(window.before)
        || (possessive && /^\s+(?:platform|product|customers|users|codebase|stack|system|infrastructure|data|pipeline|app|service)\b/iu.test(after));
      if (deny) continue;
      const intent = targetEmploymentIntentClause(window.text.trim(), company)
        && (/\b(?:join|help|contribute\s+to|support|bring\b[^.!?;]*\bto)\s+$/iu.test(window.before)
          || /\blook(?:ing)?\s+forward\s+to\s+(?:joining|helping|contributing\s+to|supporting|bringing\b[^.!?;]*\bto)\s+$/iu.test(window.before));
      const plain = reportsNoPastWork(window.text) && !hasWorkIngWord(window.before);
      const fit = Boolean(noun) && /\b(?:meets|meet|fits|fit|matches|match|suits|suit|addresses)\s+$/iu.test(window.before);
      const ownedNeed = possessive && Boolean(noun) && ((/^\s*$/u.test(window.before)
        && /^\s+(?:is|are|needs|wants|asks)\b/iu.test(after.slice(noun[0].length)))
        || /\b(?:is|are|needs|wants|asks)\s+$/iu.test(window.before));
      const clauseTail = after.split(/[,;.!?]|\b(?:which|that|who|and|so)\b/iu)[0];
      const subject = subjectPosition
        && !/\b(?:i|we|me|my|our|us)\b/iu.test(clauseTail)
        && /^\s+(?:needs|wants|asks|seeks|requires|expects|hires|is\s+(?:hiring|looking|seeking|building)|has\s+(?:a|an)\s+(?:need|mission|roadmap|goal|priority)|exists)\b/iu.test(after);
      if (intent || (plain && (fit || ownedNeed || subject))) spans.push([at, end]);
    }
  }
  if (!spans.length || !finding.term) return false;
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${phrase(finding.term)}(?![\\p{L}\\p{N}])`, 'giu');
  const occurrences = [...text.matchAll(pattern)];
  return occurrences.length > 0 && occurrences.every(match => spans.some(([from, to]) => match.index >= from && match.index + match[0].length <= to));
}


// Shared résumé and letter validation called by v2 and by historical stage replay.
export function validateSharedApplicationContent(response, state, input, authority, {
  nonemptyText, PASTE_RESUME_BULLET_FIELD_LABEL, unsupportedDurationClaimError, pasteCareerQuotesForEvidenceIds, selectedSourceRoles, validateAuthorityResumeArtifacts, isCurrentAuthorityProtocol, isWriteVerifyJob, currentAuthorityFinalResumeArtifactErrors, assertAuthorityDraftSelection, frozenPlanListingEvidenceIds, validateStructuredApplicationResume, selectedAuthorityCareerSkillEvidence, structuredResumeFailureParts, pasteResumeCompletionTwinErrors, pasteResumeUnderfillErrors, projectContactChannels, PASTE_COVER_PARAGRAPH_UNIT_LABEL, MAX_COVER_LETTER_PARAGRAPH_EVIDENCE_IDS, pasteCoverLetterCompletionTwinErrors, createApplicationListingClosingValidator
}) {
  const errors = [];
  if (state.stage === 'resume') {
    if (!response.resume || typeof response.resume !== 'object' || Array.isArray(response.resume)) errors.push('Resume handoff needs a structured resume object.');
    const acceptedEvidence = Array.isArray(state.evidencePlan?.evidence) ? state.evidencePlan.evidence : [];
    const roles = Array.isArray(response.resume?.roles) ? response.resume.roles : [];
    const evidenceIds = new Set(acceptedEvidence.map(item => item?.id));
    const roleIds = new Set();
    for (const role of roles) {
      if (!nonemptyText(role?.id) || roleIds.has(role.id)) errors.push('Resume role IDs must be unique nonempty strings.');
      roleIds.add(role?.id);
      const bullets = Array.isArray(role?.bullets) ? role.bullets : [];
      for (const bullet of bullets) {
        if (!nonemptyText(bullet?.id) || !nonemptyText(bullet?.text) || !Array.isArray(bullet?.evidenceIds) || !bullet.evidenceIds.length) errors.push('Every resume bullet needs id, text, and evidenceIds.');
        const bulletEvidenceIds = Array.isArray(bullet?.evidenceIds) ? bullet.evidenceIds : [];
        for (const id of bulletEvidenceIds) if (!evidenceIds.has(id)) errors.push(`evidence-id-is-verified: ${PASTE_RESUME_BULLET_FIELD_LABEL} ${String(bullet?.id ?? '')} references unknown evidence ${String(id)}.`);
        if (!bulletEvidenceIds.some(id => acceptedEvidence.find(item => item?.id === id)?.sourceId === 'career-data')) errors.push(`Resume bullet ${String(bullet?.id ?? '')} needs career-data evidence, not only job-listing evidence.`);
        else {
          const durationError = unsupportedDurationClaimError(`${PASTE_RESUME_BULLET_FIELD_LABEL} ${String(bullet?.id)}`, bullet?.text, pasteCareerQuotesForEvidenceIds(bulletEvidenceIds, acceptedEvidence));
          if (durationError) errors.push(durationError);
        }
      }
    }
    const expectedRoleIds = selectedSourceRoles(state, input).map(role => role.id).sort();
    if (expectedRoleIds.length && JSON.stringify([...roleIds].sort()) !== JSON.stringify(expectedRoleIds)) errors.push('Resume roles must cover every source role exactly once.');
    let structurallyValid = true;
    try {
      if (authority) {
        const authorityErrors = validateAuthorityResumeArtifacts(response.resume, acceptedEvidence, authority, selectedSourceRoles(state, input), input.careerSkillEvidence);
        if (isCurrentAuthorityProtocol(input) && !isWriteVerifyJob(input)) {
          authorityErrors.push(...currentAuthorityFinalResumeArtifactErrors({
            resume: response.resume,
            authority,
            skillSelection: state.authoritySelection?.skillSelection,
            skills: input.careerSkillEvidence?.skills,
          }));
        }
        if (authorityErrors.length) throw new Error(authorityErrors.join(' '));
        if (isCurrentAuthorityProtocol(input) && !isWriteVerifyJob(input)) {
          assertAuthorityDraftSelection({
            fullAuthority: { catalog: input.hostCareerEvidenceCatalog || [], skills: input.careerSkillEvidence?.skills || [] },
            selection: {
              selectedRoleIds: state.selectedRoleIds || [],
              selectedProjectIds: state.authoritySelection?.evidenceSelection?.selectedProjectIds || [],
              resumeProjectObligation: state.authoritySelection?.evidenceSelection?.resumeProjectObligation ?? null,
              selectedEducationIds: state.authoritySelection?.evidenceSelection?.selectedEducationIds || [],
              selectedCertificationIds: state.authoritySelection?.evidenceSelection?.selectedCertificationIds || [],
              selectedSkillIds: state.authoritySelection?.skillSelection?.selectedSkillIds || [],
              selectedEvidenceIds: state.authoritySelection?.evidenceSelection?.selectedEvidenceIds || [],
            },
            acceptedNonAuthorityEvidenceIds: frozenPlanListingEvidenceIds(state.evidencePlan),
            resume: response.resume,
            coverLetter: null,
          });
        }
      } else validateStructuredApplicationResume(response.resume, {
        sourceRoles: selectedSourceRoles(state, input),
        evidenceCatalog: state.evidencePlan?.evidence || [],
        trustedIdentity: state.trustedIdentity,
        careerData: state.careerData,
        careerSkillEvidence: selectedAuthorityCareerSkillEvidence(input, state),
      });
    } catch (error) {
      // A missing grounding input is this app's defect; listing it among the
      // corrections would spend a manual handoff round on something no
      // response can fix.
      if (error?.code === 'STRUCTURED_RESUME_CONFIGURATION') throw error;
      structurallyValid = false;
      errors.push(...structuredResumeFailureParts(error));
    }
    // Only once the structure holds: the twin renders the résumé, and a draft
    // the validator above already rejected would fail that render for the same
    // reason and report it a second time.
    if (structurallyValid) errors.push(...pasteResumeCompletionTwinErrors(response.resume, state, input));
    errors.push(...pasteResumeUnderfillErrors(response.resume, acceptedEvidence));
  } else if (state.stage === 'cover-letter') {
    if (!response.coverLetter || typeof response.coverLetter !== 'object' || Array.isArray(response.coverLetter)) errors.push('Cover-letter handoff needs a structured coverLetter object.');
    const acceptedEvidence = Array.isArray(state.evidencePlan?.evidence) ? state.evidencePlan.evidence : [];
    const paragraphs = Array.isArray(response.coverLetter?.paragraphs) ? response.coverLetter.paragraphs : [];
    const evidenceIds = new Set(acceptedEvidence.map(item => item?.id));
    const paragraphIds = new Set();
    let validateListingClosing = null;
    if (!paragraphs.length) errors.push('Cover letter needs at least one paragraph.');
    // Split by cause (pasteStableIdError above states the same reasoning for
    // the same reason): a name mismatch and a contact mismatch are different
    // repairs, and merging them into one verdict left a responder who fixed
    // one guessing whether the other had ever been wrong.
    if (response.coverLetter?.name !== state.trustedIdentity?.name) errors.push('Cover-letter name must exactly equal context.trustedIdentity.name, element for element.');
    if (JSON.stringify(projectContactChannels(response.coverLetter?.contact || []))
      !== JSON.stringify(projectContactChannels(state.trustedIdentity?.contact || []))) errors.push('Cover-letter contact must exactly equal context.trustedIdentity.contact, element for element and in the same order.');
    if (!nonemptyText(response.coverLetter?.roleThesis)) errors.push('Cover letter needs a roleThesis.');
    if (!response.coverLetter?.coverLetterArgument?.primaryEvidence) errors.push('Cover letter needs a coverLetterArgument.primaryEvidence.');
    paragraphs.forEach((paragraph, index) => {
      // One message per cause, and the paragraph named by its own id — or, when
      // the id is the thing missing, by its position — so two independently
      // broken paragraphs never collapse into one byte-identical string:
      // normalizePasteCorrections dedupes by exact string equality, and a
      // merged, unnamed verdict hid a sibling defect for a whole extra round.
      const hasId = nonemptyText(paragraph?.id);
      const unit = hasId ? `${PASTE_COVER_PARAGRAPH_UNIT_LABEL} ${String(paragraph.id)}` : `${PASTE_COVER_PARAGRAPH_UNIT_LABEL} at position ${index + 1}`;
      if (!hasId) {
        errors.push(`${unit} has a missing or empty id (received ${JSON.stringify(paragraph?.id ?? null)}). Every paragraph needs its own nonempty id.`);
      } else if (paragraphIds.has(paragraph.id)) {
        errors.push(`The paragraph id ${JSON.stringify(paragraph.id)} is used by more than one paragraph; each id must be unique within paragraphs.`);
      } else {
        paragraphIds.add(paragraph.id);
      }
      if (!nonemptyText(paragraph?.text)) errors.push(`${unit} has no text.`);
      const paragraphEvidenceIds = Array.isArray(paragraph?.evidenceIds) ? paragraph.evidenceIds : null;
      if (!paragraphEvidenceIds || paragraphEvidenceIds.length < 1 || paragraphEvidenceIds.length > MAX_COVER_LETTER_PARAGRAPH_EVIDENCE_IDS) {
        errors.push(`${unit} carries ${paragraphEvidenceIds ? paragraphEvidenceIds.length : 0} evidenceIds; every paragraph needs 1 to ${MAX_COVER_LETTER_PARAGRAPH_EVIDENCE_IDS} evidenceIds.`);
      }
      const ids = paragraphEvidenceIds || [];
      for (const id of ids) if (!evidenceIds.has(id)) errors.push(`${unit} references unknown evidence ${String(id)}. evidenceIds may only name an ID from the accepted evidence plan.`);
      const careerQuotes = pasteCareerQuotesForEvidenceIds(ids, acceptedEvidence);
      if (!ids.some(id => acceptedEvidence.find(item => item?.id === id)?.sourceId === 'career-data')) {
        // Historical callers and ordinary career-grounded paragraphs do not
        // need the optional closing context. Missing injection keeps the old
        // citation rule; only a host validator can grant the exception.
        if (!validateListingClosing && ids.length && ids.every(id => acceptedEvidence.find(item => item?.id === id)?.sourceId === 'job-listing')
          && typeof createApplicationListingClosingValidator === 'function') {
          validateListingClosing = createApplicationListingClosingValidator({
            input, state: { ...state, resume: response.resume || state.resume }, authority,
          });
        }
        const validation = validateListingClosing?.({ paragraphs, index, acceptedEvidence });
        if (!validation?.eligible) {
          errors.push(`${unit} needs at least one career-data evidence ID.`);
          if (Array.isArray(validation?.corrections)) errors.push(...validation.corrections);
        }
      }
      // Listing-only prose never borrows the posting's requested duration.
      const durationError = unsupportedDurationClaimError(unit, paragraph?.text, careerQuotes);
      if (durationError) errors.push(durationError);
    });
    // Same reason as the résumé twin: the editorial battery that grades this
    // letter runs only when the package is assembled, three stages after the
    // stage that writes it. Run it here, on the same authored envelope, and
    // report it alongside the structural defects rather than behind them.
    errors.push(...pasteCoverLetterCompletionTwinErrors(response, state, input));
  }
  return errors;
}
