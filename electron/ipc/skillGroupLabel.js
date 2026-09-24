/**
 * One definition of the skills-block `<dt>` casing rule.
 *
 * WHY ITS OWN MODULE. Two renderers write into the same `<dl class="skills">`:
 * structuredResume.js renders the corpus rows, and resumeHtml.js appends or
 * creates rows for verified inferred skills. Both must case a label the same
 * way or one list shows two casings. The rule cannot live in either of them:
 * resumeHtml.js is imported (through jobApplication.js → resumeRender.js) by
 * structuredResume.js's own dependency chain, and resumeRender.js reads a
 * resumeHtml export at module-evaluation time, so an edge from resumeHtml.js
 * back up to structuredResume.js closes that cycle and the whole suite dies at
 * module link with "Cannot access 'ATS_SAFE_PDF_FONT_TOKENS' before
 * initialization". This module imports nothing, so neither direction can
 * deadlock. structuredResume.js re-exports the function, which is where the
 * résumé contract's consumers read it from.
 */

// A connecting word inside a compound label stays lowercase, the way
// "Infrastructure and Integration" reads on the page. The other connectors the
// neutral-label rule allows (&, /, ,) are punctuation and pass through
// untouched.
const SKILL_GROUP_LOWERCASE_WORDS = new Set(['and']);
// A word is a run of letters and digits plus the punctuation that lives INSIDE
// a product name (Node.js, C#, C++, an apostrophe). A hyphen and a slash are
// deliberately excluded, so both halves of "web development / tools" and
// "web-development" are cased.
const SKILL_GROUP_WORD_RE = /[\p{L}\p{N}][\p{L}\p{N}'’.+#]*/gu;
// The acronyms a skills-row label can legitimately be built from, each with the
// casing it prints in. A CLOSED set, deliberately not a heuristic: nothing about
// a short word says "acronym" (`ml` and `web` are both three letters or fewer),
// so any rule general enough to catch AI would shout at some ordinary noun.
//
// WHY IT EXISTS. Title-casing a fully lowercase word rendered "ai" as "Ai", and
// the design system ships exactly "Infrastructure & AI"
// (uploads/Application.html:1542, handoff/Application-paginated-example.html:
// 1556) plus the documented "AI/ML" (STYLE.md:833, SKILL.md:696-697). Lowercase
// is the EXPECTED input here, not an exotic one: the neutral vocabulary
// (structuredResume.js NEUTRAL_SKILL_GROUP_LABELS) is printed into the prompt in
// lowercase, so 'ai' is the spelling a responder copies from the rule it was
// given.
//
// Membership is bounded by that same vocabulary: 'ai' and 'ml' are the only
// acronyms any allowlisted label or shipped `<dt>` can produce. The other
// plausible candidates (ui, ux, api, sql, os, ci, cd) are left out because no
// entry in that vocabulary and no exemplar row spells one, and a label that does
// carry one can only have come from career data, where the corpus's own spelling
// already survives this function untouched.
const SKILL_GROUP_ACRONYM_CASING = new Map([['ai', 'AI'], ['ml', 'ML']]);

/**
 * Title-case a skills-group label for display.
 *
 * Every `<dt>` the design system ships is Title Case (resume.html:197/200/203,
 * preview/component-skills.html:20/22/24, uploads/Application.html:1536/1539/
 * 1542) and NO prose rule anywhere states it, so a lowercase label from a
 * pasted response printed exactly as it arrived: `.skills dt` carries no
 * text-transform (resume.css:568-574).
 *
 * A known acronym is printed in its own casing whatever casing it arrived in,
 * which also repairs the "Ai" a title-caser produces from the lowercase 'ai' the
 * prompt's own vocabulary offers. Otherwise a word that ALREADY carries an
 * uppercase letter is returned untouched, so a careerData label such as "iOS" or
 * "gRPC" survives this function. Callers apply it at RENDER, after validation:
 * the group-label gate accepts a label that occurs verbatim in frozen career
 * data, and that comparison has to keep reading the text the responder actually
 * sent. Merge keys are unaffected for the same reason they are case-insensitive
 * — resumeHtml's skillLabelKey() lowercases and strips every non-alphanumeric
 * character.
 */
export function titleCaseSkillGroupLabel(label) {
  return String(label ?? '').replace(SKILL_GROUP_WORD_RE, (word, offset) => {
    const lowercased = word.toLocaleLowerCase();
    const acronym = SKILL_GROUP_ACRONYM_CASING.get(lowercased);
    if (acronym) return acronym;
    if (/[\p{Lu}\p{Lt}]/u.test(word)) return word;
    if (offset > 0 && SKILL_GROUP_LOWERCASE_WORDS.has(lowercased)) return word;
    return word.charAt(0).toLocaleUpperCase() + word.slice(1);
  });
}
