import { normalizedCompanyDisplayName } from './coverLetterChecks.js';

const escape = value => String(value).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const LEFT = String.raw`(?<![\p{L}\p{N}])`;
const APOS = String.raw`['’]`;
const normalizeApostrophes = value => String(value ?? '').replace(/[‘’ʼ＇]/gu, "'");
// This list belongs only to the tightening guard. It grants no naming licence.
const SIMPLE_MODAL = String.raw`(?:would|could|will|hope\s+to|want\s+to|look\s+forward\s+to|love\s+to)`;
const MODAL_INTENT = String.raw`(?:excited|eager|ready)\s+to`;
const MODAL = String.raw`(?:${SIMPLE_MODAL}|(?:(?:am|are|${APOS}m|${APOS}re)\s+)?${MODAL_INTENT})`;
// The repeated continuity lead consumes be-verbs separately, so they must
// not also be an optional prefix of its modal alternative.
const CONTINUITY_MODAL = String.raw`(?:${SIMPLE_MODAL}|${MODAL_INTENT})`;
const SUBJECT = String.raw`(?:I|we)(?![\p{L}\p{N}])`;
const NONMODAL_SUBJECT = String.raw`${SUBJECT}(?!\s*(?:\p{L}+ly\s+)*${MODAL}\b|${APOS}(?:d|ll)\b)`;
const TIME = String.raw`(?:time|role|work|tenure|years?|job|position|stint|career|employment|experience)`;
const TIME_WITH = String.raw`(?:time|role|tenure|years?|job|position|stint|career|employment)`;
const ROLE = String.raw`(?:engineer|developer|programmer|analyst|manager|designer|lead|intern|employee|associate|consultant|contractor|architect|scientist|specialist|coordinator|director|technician|teammate|team\s+member|staff(?:er)?|SRE|PM)s?`;
const WORK = String.raw`(?:ran|rebuilt|rewrote|built|wrote|maintained|managed|led|developed|designed|created|delivered|supported|operated|coordinated|handled|oversaw|shipped|coded|debugged|worked|run|runs|build|builds|maintain|maintains|manage|manages|lead|leads|write|writes|develop|develops|design|designs|create|creates|deliver|delivers|support|supports|operate|operates|coordinate|coordinates|handle|handles|oversee|oversees|ship|ships|code|codes|debug|debugs|work|works)`;
const normalizedEmployer = value => normalizedCompanyDisplayName(normalizeApostrophes(value)).toLocaleLowerCase();

/** Pure tightening over the pre-feature naming rule. Names are exact frozen
 * strings, their pre-separator prefix and shared legal-name normalization.
 * No first-word or brand aliases are inferred. */
export function targetEmploymentFrames(sentence, targetCompany, options) {
  try { return employmentFrames(sentence, targetCompany, options); }
  catch { return []; }
}

function employmentFrames(sentence, targetCompany, options = {}) {
  const names = value => Array.isArray(value) ? value.filter(name => typeof name === 'string').map(name => normalizeApostrophes(name).replace(/\s+/gu, ' ').trim()).filter(Boolean) : [];
  const approvedOrganizations = names(options?.approvedOrganizations);
  const approvedCareerEmployers = names(options?.approvedCareerEmployers);
  const rawCompany = String(targetCompany ?? '').trim();
  const company = rawCompany.length > 200 ? rawCompany.split(/\s+[-–—|]\s+/u)[0].trim() : rawCompany;
  if (company.length > 200) return [];
  const frozen = normalizeApostrophes(company);
  const prefix = frozen.split(/\s+[-–—|]\s+/u)[0];
  const withoutSuffix = normalizedCompanyDisplayName(prefix.replace(/\([^)]*\)/gu, ' '));
  const forms = [...new Set([frozen, prefix, withoutSuffix])].filter(name => name.length >= 2).sort((a, b) => b.length - a.length);
  if (!forms.length || approvedCareerEmployers.some(name => forms.some(form => normalizedEmployer(name) === normalizedEmployer(form)))) return [];
  let text = normalizeApostrophes(sentence);
  for (const name of [...approvedOrganizations].filter(name => {
    if (name.length > text.length) return false;
    const contained = new RegExp(`${LEFT}${escape(normalizeApostrophes(name)).replace(/\s+/gu, '\\s+')}(?![\\p{L}\\p{N}])`, 'iu');
    return !forms.some(form => contained.test(form));
  }).sort((a, b) => b.length - a.length)) {
    const pattern = new RegExp(`${LEFT}${escape(normalizeApostrophes(name)).replace(/\s+/gu, '\\s+')}(?![\\p{L}\\p{N}])`, 'giu');
    text = text.replace(pattern, match => '\u2063'.repeat(match.length));
  }
  const employer = `(?:${forms.map(name => escape(name).replace(/\s+/gu, '\\s+')).join('|')})(?:${APOS}s?)?(?![\\p{L}\\p{N}]|${APOS})`;
  // A lowercased ordinary word is not the frozen employer's written name.
  if (forms.some(form => form !== form.toLocaleLowerCase())) {
    text = text.replace(new RegExp(`${LEFT}${employer}`, 'giu'), surface =>
      surface === surface.toLocaleLowerCase() ? '\u2063'.repeat(surface.length) : surface);
  }
  const E = 'TARGET_EMPLOYER';
  const compile = source => {
    let serial = 0;
    // An atomic lookahead/backreference prevents a pre-dash prefix from
    // winning by backtracking past the full name and its modal lookahead.
    return new RegExp(source.replaceAll(E, () => {
      const name = `employer${serial++}`;
      return `(?=(?<${name}>${employer}))\\k<${name}>`;
    }), 'iu');
  };

  const hasNonmodalSubject = new RegExp(`${LEFT}${NONMODAL_SUBJECT}`, 'iu').test(text);
  const hasSubject = new RegExp(`${LEFT}${SUBJECT}`, 'iu').test(text);
  const hasPossessive = /\b(?:my|our)\s+/iu.test(text);
  const patterns = [
    ['initial-at', String.raw`^\s*["“(]*At\s+${E}\s*,?\s*(?:${NONMODAL_SUBJECT}|(?:my|our)\s+(?![^,;.!?]*\b${MODAL}\b)(?!${MODAL}\b)\p{L}+(?![\p{L}\p{N}])(?:\s+(?!${MODAL}\b)\p{L}+(?![\p{L}\p{N}]))?(?!\s+${MODAL}\b))`],
    ['while-at', String.raw`${LEFT}while\s+(?:I\s+(?:was|were|am)\s+)?(?:working\s+|employed\s+|serving\s+)?(?:at|for)\s+${E}`],
    ['during-my-time-at', String.raw`${LEFT}(?:during|throughout)\s+(?:my|our)\s+(?:\p{L}+\s+)?${TIME}\s+(?:at|with|for)\s+${E}`],
    ['my-time-role-at', String.raw`${LEFT}(?:my|our)\s+(?:${TIME}\s+at|${TIME_WITH}\s+with)\s+${E}(?!\s+${MODAL}\b)`],
    ['worked-at', String.raw`${LEFT}${SUBJECT}\s+(?:previously\s+|once\s+|formerly\s+)?(?:worked|have\s+worked|had\s+worked|was\s+working|were\s+working)\s+(?:at|for)\s+${E}`],
    ['present-work-at', String.raw`${LEFT}${SUBJECT}\s+(?:\p{L}+ly\s+|now\s+|still\s+)*work\s+(?:at|for)\s+${E}|${LEFT}${SUBJECT}(?:\s+am|${APOS}m|\s+are|${APOS}re)\s+(?:currently\s+|now\s+|still\s+)?working\s+(?:at|for)\s+${E}`],
    ['joined', String.raw`${LEFT}${SUBJECT}\s+(?:(?:have|had|once|recently|previously|just|already)\s+)*joined\s+(?:the\s+)?${E}(?!\s+(?:webinar|event|talk|meetup|call|newsletter)\b)`],
    ['since-joining', String.raw`${LEFT}since\s+(?:I\s+)?(?:joining|joined)\s+(?:the\s+)?${E}(?!\s+(?:webinar|event|talk|meetup|call|newsletter)\b)`],
    ['as-target-role', String.raw`${LEFT}as\s+(?:an?|the)\s+${E}\s+(?:[\p{L}-]+\s+){0,2}?${ROLE}(?![\p{L}\p{N}])`],
    ['work-for', String.raw`${LEFT}${SUBJECT}\s+(?:\p{L}+ly\s+|now\s+|still\s+)*${WORK}\b[^,;.!?]{0,300}?\s+for\s+${E}`],
    ['work-at', String.raw`${LEFT}${SUBJECT}\s+(?:\p{L}+ly\s+|now\s+|still\s+)*${WORK}\b(?:(?!${LEFT}(?:to|like|such|similar|same|kind|sort|type|would|could|will|that|which|who|whom|where|and|but|so|than|as|after|before|about|when|while|because|since|if|once|until)(?![\p{L}\p{N}]))[^,;.!?]){0,300}?(?<!${LEFT}(?:mission|vision|values|culture|goals|approach|priorities))\s+at\s+${E}(?=\s*(?:[,;.!?)"”]|$))`],
    ['member-of-team', String.raw`${LEFT}as\s+a\s+member\s+of\s+the\s+${E}\s+team\s*,?\s*${NONMODAL_SUBJECT}`],
    ['where-i', String.raw`${LEFT}${E}\s+is\s+where\s+${NONMODAL_SUBJECT}`],
    ['our-team-at', String.raw`${LEFT}our\s+team\s+at\s+${E}(?!\s+${MODAL}\b)`],
  ];
  const findings = [];
  for (const [frame, source] of patterns) {
    if (!hasNonmodalSubject && (hasSubject || !hasPossessive)) continue;
    // These literal separators are required by the respective frame. Avoid
    // retrying its bounded scan across long blanks when no separator exists.
    if ((frame === 'work-for' && !/\sfor\s/iu.test(text)) ||
        (frame === 'work-at' && !/\sat\s/iu.test(text))) continue;
    const match = compile(source).exec(text);
    if (match) findings.push({ code: 'target-employment-frame', term: company, frame, index: match.index });
  }
  // Returning, resuming and joining again assert a prior affiliation even in
  // an otherwise hypothetical clause. Only a career employer can ground it.
  const personLead = String.raw`${LEFT}${SUBJECT}(?:${APOS}(?:d|ll|m|re))?\s+(?:(?:${CONTINUITY_MODAL}|like\s+to|have|had|am|are|be|been|previously|recently|just|already)\s+)*`;
  const returnAction = String.raw`(?:re\p{Pd}?join(?:ed|ing)?|return(?:ed|ing)?\s+to|com(?:e|ing)\s+back\s+to|go(?:ing)?\s+back\s+to|back\s+(?:at|with)|resum(?:e|ed|ing)\s+(?:work\s+)?at|continu(?:e|ed|ing)\s+(?:work\s+)?at)`;
  const initialReturn = String.raw`^\s*(?:re\p{Pd}?joining|returning\s+to|coming\s+back\s+to|going\s+back\s+to|resuming\s+(?:work\s+)?at|continuing\s+(?:work\s+)?at)`;
  const continuity = compile(String.raw`(?:${personLead}${returnAction}|${initialReturn})\s+(?:the\s+)?${E}|(?:${personLead}(?:join(?:ing|ed)?|return(?:ing|ed)?\s+to)|^\s*joining)\s+(?:the\s+)?${E}\s+(?:again|once\s+more|anew)\b`).exec(text);
  if (continuity) findings.push({ code: 'target-employment-frame', term: company, frame: 'rejoin-return-resume', index: continuity.index });

  return findings.length ? [findings[0]] : [];
}
