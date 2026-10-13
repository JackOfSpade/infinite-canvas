// Shared production truth predicates used by the v2 content gate.
export function targetIdentityNameLicensed(sentence, finding, ctx, { reportsNoPastWork, attributionTerms, sentenceAddressesTarget }) {
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
  if (company && sentenceAddressesTarget(text, company)) {
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${phrase(company)}(?![\\p{L}\\p{N}])`, 'giu');
    for (const match of text.matchAll(pattern)) if (noPastWork || forwardReference(match.index)) spans.push([match.index, match.index + match[0].length]);
  }
  if (!spans.length || !finding.term) return false;
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${phrase(finding.term)}(?![\\p{L}\\p{N}])`, 'giu');
  const occurrences = [...text.matchAll(pattern)];
  return occurrences.length > 0 && occurrences.every(match => spans.some(([from, to]) => match.index >= from && match.index + match[0].length <= to));
}


// Shared résumé and letter validation called by v2 and by historical stage replay.
export function validateSharedApplicationContent(response, state, input, authority, {
  nonemptyText, PASTE_RESUME_BULLET_FIELD_LABEL, unsupportedDurationClaimError, pasteCareerQuotesForEvidenceIds, selectedSourceRoles, validateAuthorityResumeArtifacts, isCurrentAuthorityProtocol, isWriteVerifyJob, currentAuthorityFinalResumeArtifactErrors, assertAuthorityDraftSelection, frozenPlanListingEvidenceIds, validateStructuredApplicationResume, selectedAuthorityCareerSkillEvidence, structuredResumeFailureParts, pasteResumeCompletionTwinErrors, pasteResumeUnderfillErrors, pasteCoverLetterUnderfillErrors, projectContactChannels, PASTE_COVER_PARAGRAPH_UNIT_LABEL, MAX_COVER_LETTER_PARAGRAPH_EVIDENCE_IDS, pasteCoverLetterCompletionTwinErrors
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
        for (const id of bulletEvidenceIds) if (!evidenceIds.has(id)) errors.push(`evidence-id-is-verified: ${PASTE_RESUME_BULLET_FIELD_LABEL} references unknown evidence ${String(id)}.`);
        if (!bulletEvidenceIds.some(id => acceptedEvidence.find(item => item?.id === id)?.sourceId === 'career-data')) errors.push('Every resume bullet needs career-data evidence, not only job-listing evidence.');
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
        const authorityErrors = validateAuthorityResumeArtifacts(response.resume, acceptedEvidence, authority, selectedSourceRoles(state, input));
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
    if (!paragraphs.length) errors.push('Cover letter needs at least one paragraph.');
    errors.push(...pasteCoverLetterUnderfillErrors(response.coverLetter, acceptedEvidence));
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
      if (!ids.some(id => acceptedEvidence.find(item => item?.id === id)?.sourceId === 'career-data')) errors.push(`${unit} needs at least one career-data evidence ID.`);
      else {
        const durationError = unsupportedDurationClaimError(unit, paragraph?.text, pasteCareerQuotesForEvidenceIds(ids, acceptedEvidence));
        if (durationError) errors.push(durationError);
      }
    });
    // Same reason as the résumé twin: the editorial battery that grades this
    // letter runs only when the package is assembled, three stages after the
    // stage that writes it. Run it here, on the same authored envelope, and
    // report it alongside the structural defects rather than behind them.
    errors.push(...pasteCoverLetterCompletionTwinErrors(response, state, input));
  }
  return errors;
}
