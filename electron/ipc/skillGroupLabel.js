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
// "Tools and Methods" reads on the page. The other connectors the neutral-label
// rule allows (&, /, ,) are punctuation and pass through untouched.
const SKILL_GROUP_LOWERCASE_WORDS = new Set(['and']);
// A word is a run of letters and digits plus the punctuation that lives INSIDE
// a product name (Node.js, C#, C++, an apostrophe). A hyphen and a slash are
// deliberately excluded, so both halves of "web development / tools" and
// "web-development" are cased.
const SKILL_GROUP_WORD_RE = /[\p{L}\p{N}][\p{L}\p{N}'’.+#]*/gu;
// A short all-lowercase word in a label is an acronym unless it is one of the
// handful of two-letter function words English uses between nouns. This is a
// structural rule, not a list of acronyms: nothing about the acronym is named
// here, so a label built from any field's two-letter abbreviation (a clinical,
// legal, financial or engineering one) is cased the same way.
//
// WHY IT EXISTS. Title-casing a fully lowercase word turns a two-letter
// abbreviation into "Xy". Lowercase is the EXPECTED input here, not an exotic
// one: the label vocabulary (structuredResume.js skillGroupVocabulary) is
// printed into the prompt in lowercase, so lowercase is the spelling a
// responder copies from the rule it was given.
const SKILL_GROUP_ACRONYM_MAX_LETTERS = 2;
const SKILL_GROUP_SHORT_FUNCTION_WORDS = new Set(['a', 'an', 'as', 'at', 'by', 'in', 'is', 'of', 'on', 'or', 'to', 'vs']);

/**
 * Title-case a skills-group label for display.
 *
 * Every `<dt>` the design system ships is Title Case and no prose rule
 * anywhere states it, so a lowercase label from a pasted response printed
 * exactly as it arrived: `.skills dt` carries no text-transform
 * (resume.css:568-574).
 *
 * A short all-lowercase word that is not a function word is printed as an
 * acronym, which repairs the "Xy" a title-caser produces from the lowercase
 * spelling the prompt's own vocabulary offers. Otherwise a word that ALREADY
 * carries an uppercase letter is returned untouched, so a label from the
 * approved profile such as "iOS" or "gRPC" survives this function. Callers apply
 * it at RENDER, after validation: the group-label gate compares the text the
 * responder actually sent, so casing must not change what was graded. Merge
 * keys are unaffected for the same reason they are case-insensitive —
 * resumeHtml's skillLabelKey() lowercases and strips every non-alphanumeric
 * character.
 */
export function titleCaseSkillGroupLabel(label) {
  return String(label ?? '').replace(SKILL_GROUP_WORD_RE, (word, offset) => {
    const lowercased = word.toLocaleLowerCase();
    if (/[\p{Lu}\p{Lt}]/u.test(word)) return word;
    if (offset > 0 && SKILL_GROUP_LOWERCASE_WORDS.has(lowercased)) return word;
    if (/^\p{L}+$/u.test(word) && [...word].length <= SKILL_GROUP_ACRONYM_MAX_LETTERS
      && !SKILL_GROUP_SHORT_FUNCTION_WORDS.has(lowercased)) return word.toLocaleUpperCase();
    return word.charAt(0).toLocaleUpperCase() + word.slice(1);
  });
}
