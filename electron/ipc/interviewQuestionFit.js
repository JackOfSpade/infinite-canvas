/** Question shape is a separate gate from factual entailment. A deliverable or
 * domain noun alone does not establish a behavioral answer. Missing shape is
 * allowed only with the card's thinEvidence warning. */
const ACTION = /\b(?:built|maintained|implemented|tested|migrated|replaced|changed|added|fixed|resolved|reviewed|supported|helped|contributed|investigated|compared|asked|interviewed|prioriti[sz]ed|chose|selected|decided|coordinated|planned|split|paired|agreed)\b/iu;
const PEOPLE = /\b(?:engineers?|designers?|stakeholders?|customers?|users?|patients?|therapists?|staff|management|team|product|colleagues?|partners?)\b/iu;
const PROBLEM = /\b(?:problem|failure|failed|errors?|constraint|missing|slow|latency|lag|deadline|outage|blocked|bug|bottleneck|conflict|unclear|unknown|uncertain)\b/iu;
const OUTCOME_STATE = /\b(?:(?:operations|service|systems?|access)\s+(?:continued|stayed|remained)[^.;]*(?:without interruption|available|live)|(?:delivered|completed|migrated|launched|rolled out)\b[^.;]*\bwithout\s+(?:interrupting|disrupting|interruption|downtime))\b/iu;
const EFFECT_OBJECT = /\b(?:costs?|errors?|defects?|failures?|latency|performance|availability|reliability|accessibility|accuracy|throughput|time|hours?|minutes?|seconds?|downtime|interruptions?|spend|revenue|conversion|retention|engagement|manual (?:data )?entry|manual work|processing|load times?)\b/iu;
const CHOICE = /\b(?:decided|chose|selected|adopted|bought|rejected|approved|decision to)\b/iu;
const CRITERION = /\b(?:cost|tradeoffs?|budget|criteria|risk|quality|impact|urgency|deadlines?|dependencies|capacity|effort|value|reliability|performance|requirements?)\b/iu;

function hasBoth(pattern, spoken, evidence) { return pattern.test(spoken) && pattern.test(evidence); }
function outcomeShape(value) {
  if (OUTCOME_STATE.test(value)) return true;
  // "Improved a system" names work, not its effect. Require an achieved effect
  // on something concrete; a following purpose clause cannot supply it.
  return [...value.matchAll(/\b(?:reduced|increased|improved|saved|eliminated|prevented|accelerated|grew)\s+([^.;]+)/giu)]
    .some(match => EFFECT_OBJECT.test(match[1].split(/\b(?:to|for|so|because)\b/iu)[0]));
}
function collaborationShape(value) {
  if (!PEOPLE.test(value)) return false;
  // A shared label does not say how the collaboration worked. A documented
  // contribution split or reciprocal action supplies that missing shape.
  const split = /\b(?:I|my)\b[^.;]+\b(?:while|whereas)\b[^.;]+\b(?:engineer|designer|team|colleague|partner)\b|\b(?:engineer|designer|team|colleague|partner)\b[^.;]+\b(?:while|whereas)\b[^.;]+\b(?:I|my)\b/iu;
  const reciprocal = /\b(?:paired|pairing)\b|\b(?:reviewed|reviewing|discussed|discussing|coordinated|coordinating|agreed|agreeing)\b[^.;]+\b(?:with|together|among|between)\b|\bwe\s+(?:reviewed|discussed|coordinated|agreed)\b|\b(?:requested|asked|incorporated|shared|exchanged|gathered|discussed)\b[^.;]+\bfeedback\b/iu;
  const explicitResponsibilities = /\b(?:split|divided|assigned|agreed)\b[^.;]+\b(?:responsibilit\w*|tasks?|work|roles?)\b/iu;
  return split.test(value) || reciprocal.test(value) || explicitResponsibilities.test(value);
}
function priorityShape(value) {
  return /\b(?:prioriti[sz]\w*|work(?:ed)? on first|first[^.;]+then|competing|urgent|triage\w*|ordered[^.;]+work)\b/iu.test(value)
    && CRITERION.test(value) && ACTION.test(value);
}
function processShape(value) {
  return /\b(?:replaced|instead of|before[^.;]+after|from[^.;]+to|used to|previously|manual[^.;]+automat\w*|migrated)\b/iu.test(value)
    && ACTION.test(value);
}
function needsShape(value) {
  return PEOPLE.test(value)
    && /\b(?:interviewed|interviewing|asked|listened|observed|surveyed|researched|gathered|collected|elicited|discovered)\b|\b(?:reviewed|discussed|incorporated)\b[^.;]+\b(?:feedback|requests?|needs?|requirements?)\b|\b(?:customers?|users?|patients?|therapists?|staff)\b[^.;]+\b(?:reported|requested|asked)\b/iu.test(value)
    && /\b(?:needs?|problems?|requests?|requirements?|feedback|pain|goals?|reported|interview\w*|asked)\b/iu.test(value);
}

export function isInterviewWhyQuestion(question) {
  return /^Why are you interested in this (?:role|company)\?$/u.test(question);
}

/** This small interest frame adds no candidate experience. Strip only the
 * host-authorized frame before applying the ordinary research fact guards. */
export function interviewResearchInterestText(value) {
  return typeof value === 'string' ? /^This (?:role|company) interests me because\s+(.+)$/u.exec(value)?.[1] : undefined;
}

/** Prefer a research reason in the headline. A warned fallback can retain the
 * reason in a separately cited bullet; ordinary claim guards still check every
 * line, including the career connection. */
export function interviewWhyCardFailures(card, evidence = []) {
  if (!isInterviewWhyQuestion(card?.question)) return [];
  const failures = [];
  const add = (rule, path, instruction) => failures.push({ rule: `INTERVIEW_ANSWER_${rule}`, path, instruction });
  const byId = new Map(evidence.map(item => [item.id, item]));
  const sourcesFor = statement => Array.isArray(statement?.evidenceIds) ? statement.evidenceIds.map(id => byId.get(id)) : [];
  if (card.thinEvidence === true && [card.headline, ...(Array.isArray(card.bullets) ? card.bullets : [])].some(statement => {
    const sources = sourcesFor(statement);
    return sources.length && sources.every(source => source?.kind === 'research');
  })) return failures;
  const headlineSources = sourcesFor(card.headline);
  if (!headlineSources.length || headlineSources.some(item => item?.kind !== 'research')) {
    add('WHY_HEADLINE_RESEARCH', 'headline', 'state the reason in the headline and cite only sealed research evidence there; career evidence belongs in the connecting bullets.');
  }
  const headline = typeof card.headline?.text === 'string' ? card.headline.text : '';
  const role = card.question === 'Why are you interested in this role?';
  const frame = role ? /^This role interests me because\s+\S/u : /^This company interests me because\s+\S/u;
  const researchFact = interviewResearchInterestText(headline);
  // For a company, a third-person research fact can itself state the reason.
  // Its subject, predicates, entities and quantities still pass the same
  // research entailment checks as every other spoken claim.
  const thirdPersonCompany = !role && headline.trim() && !/\b(?:I|we|my|our|me|us)\b/iu.test(headline);
  if (!(frame.test(headline) && !/\b(?:I|we|my|our|me|us)\b/iu.test(researchFact || '') || thirdPersonCompany)) {
    add('WHY_HEADLINE_REASON', 'headline', `answer why with ${role ? '"This role interests me because [cited role fact]"' : '"This company interests me because [cited company fact]" or a third-person cited company fact'}; do not lead with a candidate career accomplishment.`);
  }
  const bullets = Array.isArray(card.bullets) ? card.bullets : [];
  const careerConnections = bullets.filter(bullet => {
    const sources = sourcesFor(bullet);
    return sources.length && sources.every(source => source?.kind === 'career');
  });
  if (careerConnections.length < 1 || careerConnections.length > 2 || careerConnections.length !== bullets.length) {
    add('WHY_CAREER_CONNECTION', 'bullets', 'follow the research reason with one or two separately cited career facts in the bullets; keep research facts in the headline.');
  }
  return failures;
}

export function interviewQuestionFit(question, spokenText, sources = []) {
  const spoken = typeof spokenText === 'string' ? spokenText : '';
  const evidence = sources.map(item => item.text || '').join(' ');
  if (!spoken.trim() || !evidence.trim()) return false;
  if (/technical problem|challenge|setback|not go as planned|pressure|ambiguity/iu.test(question)) {
    return hasBoth(PROBLEM, spoken, evidence) && hasBoth(ACTION, spoken, evidence);
  }
  if (/result|outcome/iu.test(question)) return outcomeShape(spoken) && outcomeShape(evidence);
  if (/prioriti/iu.test(question)) return priorityShape(spoken) && priorityShape(evidence);
  if (/decision/iu.test(question)) return hasBoth(CHOICE, spoken, evidence) && hasBoth(CRITERION, spoken, evidence);
  if (/collaborat/iu.test(question)) return collaborationShape(spoken) && collaborationShape(evidence);
  if (/disagreement/iu.test(question)) return hasBoth(/\b(?:disagreed|disagreement|conflict|pushback|different views|opposing)\b/iu, spoken, evidence)
    && collaborationShape(spoken) && collaborationShape(evidence);
  if (/leadership/iu.test(question)) return hasBoth(/\b(?:coached|mentored|guided|delegated|supported|helped|led)\b/iu, spoken, evidence)
    && hasBoth(PEOPLE, spoken, evidence) && collaborationShape(spoken) && collaborationShape(evidence);
  if (/improving a process/iu.test(question)) return processShape(spoken) && processShape(evidence);
  if (/customer needs/iu.test(question)) return needsShape(spoken) && needsShape(evidence);
  if (/learned/iu.test(question)) return hasBoth(/\b(?:learned|found|discovered|realized)\b[^.;]+\b(?:that|when|because|needed|must|should)\b/iu, spoken, evidence);
  if (/respond to feedback/iu.test(question)) return hasBoth(/\bfeedback\b/iu, spoken, evidence) && hasBoth(/\b(?:changed|revised|adapted|added|removed|implemented)\b/iu, spoken, evidence);
  if (/adapt to change/iu.test(question)) return hasBoth(/\b(?:changed|replaced|new requirements|shifted|adapted|migrated)\b/iu, spoken, evidence) && hasBoth(ACTION, spoken, evidence);
  if (/planning and delivery/iu.test(question)) return hasBoth(/\b(?:planned|milestones?|validation|phases?|sequenced|rollout|until[^.;]+ready|until[^.;]+set up)\b/iu, spoken, evidence) && hasBoth(ACTION, spoken, evidence);
  if (/interested/iu.test(question)) return sources.some(item => item.kind === 'research')
    && (/\b(?:interested|interests?|appeals|drawn)\b/iu.test(spoken)
      || /company/iu.test(question));
  return true;
}

const STOP = new Set('a an and are as at be by for from has have in is it its of on or our that the their this to we with work working role experience development engineer engineering software'.split(' '));
function terms(value) {
  return new Set((String(value).toLowerCase().match(/[a-z][a-z0-9+#]*/gu) || []).map(term => {
    if (/^integrat/iu.test(term)) return 'integration';
    if (/^perform/iu.test(term)) return 'performance';
    if (/^prototyp/iu.test(term)) return 'prototype';
    if (/^experiment/iu.test(term)) return 'experiment';
    return term.replace(/s$/u, '');
  }).filter(term => !STOP.has(term)));
}
const ROLE_FEATURES = [
  [/\breact(?:\s+native)?\b/iu, 5], [/\btypescript\b/iu, 5],
  [/\bfull[- ]?stack\b|\b(?:front[- ]?end|client)[^.;]+\b(?:back[- ]?end|server)\b/iu, 4],
  [/\bcross[- ]?functional\b|\b(?:product|design|data science|marketing)\b/iu, 3],
  [/\bintegrat\w*\b/iu, 3], [/\bdata\b|\betl\b/iu, 2],
  [/\bperformance\b|\blatency\b|\boptimi[sz]\w*\b/iu, 3],
  [/\bprototyp\w*\b|\bexperiment\w*\b/iu, 3],
];

/** Ranking selects grounded material; listing words never license a claim. */
export function interviewEvidenceRank(question, evidence, roleThemes = [], jobListing = '') {
  const themes = Array.isArray(roleThemes) ? roleThemes.join(' ') : String(roleThemes || '');
  const listing = typeof jobListing === 'string' ? jobListing : JSON.stringify(jobListing || '');
  const targets = `${themes} ${listing}`;
  const themeTerms = terms(themes);
  const listingTerms = terms(listing);
  const ranked = evidence.filter(item => item.kind === 'career').map(item => {
    const sourceTerms = terms(item.text);
    const themeOverlap = [...themeTerms].filter(term => sourceTerms.has(term)).length;
    const listingOverlap = [...listingTerms].filter(term => sourceTerms.has(term)).length;
    const featureScore = ROLE_FEATURES.reduce((score, [pattern, weight]) => score + (pattern.test(targets) && pattern.test(item.text) ? weight : 0), 0);
    const roleScore = themeOverlap * 2 + listingOverlap + featureScore;
    const questionFit = interviewQuestionFit(question, item.text, [item]);
    const domainMismatch = /\b(?:medical|patients?|therapists?|flight|aviation|FAA|NOTAMs?)\b/iu.test(item.text)
      && !/\b(?:medical|health|patients?|therapists?|flight|aviation|FAA|NOTAMs?)\b/iu.test(targets);
    return { evidenceId: item.id, questionFit, roleScore, score: (questionFit ? 40 : 0) + roleScore * 3, domainMismatch };
  });
  const hasBetterDomain = ranked.some(item => !item.domainMismatch && item.roleScore > 0);
  return ranked.map(({ domainMismatch, ...item }) => ({ ...item, score: item.score - (hasBetterDomain && domainMismatch ? 18 : 0) }))
    .sort((a, b) => Number(b.questionFit) - Number(a.questionFit) || b.score - a.score || a.evidenceId.localeCompare(b.evidenceId));
}
