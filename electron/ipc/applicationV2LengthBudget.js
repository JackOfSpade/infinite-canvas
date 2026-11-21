/** Layout calibration from measured one-page résumé renders. No career data lives here. */
export function writeVerifyLengthBudgetForStructure({ roles, education, skillsRows, projects }) {
  for (const value of [roles, education, skillsRows, projects]) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('Application v2 length-budget structure must use nonnegative integer counts.');
  }
  // Calibrated against rendered accepted and dropped drafts. Each extra fixed
  // row consumes space before prose; the fit gate remains the final authority.
  const capacity = Math.max(300, 1780 - 30 * roles - 25 * education - 65 * skillsRows - 25 * projects);
  const maxCharacters = Math.round(capacity / 10) * 10;
  const maxBullets = Math.max(2, Math.min(11, 11 - projects - Math.max(0, roles - 3)));
  return { structure: { roles, education, skillsRows, projects }, maxCharacters, maxBullets };
}

export function writeVerifyLengthBudgets(profile, sourceRoles) {
  const roles = Math.min(3, (sourceRoles || []).length);
  const education = Math.min(1, (profile?.education || []).length);
  const availableSkills = (profile?.skills || []).length;
  // The résumé prints at most one Personal Projects entry, drawn from
  // projects with no role link; a role-linked project is that role's work.
  const projectCount = Math.min(1, (profile?.projects || []).filter(project => !project?.roleId).length);
  return [
    writeVerifyLengthBudgetForStructure({ roles, education, skillsRows: Math.min(3, availableSkills), projects: 0 }),
    ...(projectCount ? [writeVerifyLengthBudgetForStructure({ roles, education, skillsRows: Math.min(1, availableSkills), projects: projectCount })] : []),
  ];
}

/**
 * Cover-letter capacity, measured on 2026-11-16 from three accepted one-page
 * letters and their rendered type area (917.76px): 2,160 paragraph characters
 * in four paragraphs filled 86% of the page, 2,260 and 2,440 in five filled
 * 96%. A letter-only job printed no length at all, so 16 of that run's letter
 * drafts measured 102% to 135% of the page and each cost a shortening round.
 * An upper estimate that leaves a margin; the fit gate remains the authority.
 */
export const WRITE_VERIFY_LETTER_CAPACITY = Object.freeze({ paragraphs: 5, maxCharacters: 2400, perExtraParagraphCharacters: 100 });
export function writeVerifyLetterCapacityLine({ paragraphs, maxCharacters, perExtraParagraphCharacters } = WRITE_VERIFY_LETTER_CAPACITY) {
  // 2026-11-20: the earlier wording ("about N characters ... an upper estimate, not an amount to reach") left Opus
  // letters over N in 20 of 22 replayed runs (two-document mean 2,855), so the line now gives a target below the
  // measured page and a hard ceiling with an instruction to count (docs/ai-model-selection.md, write row).
  const group = value => value.toLocaleString('en-US');
  const targetHigh = maxCharacters - 200;
  const targetLow = targetHigh - 200;
  return `MEASURED LETTER CAPACITY: The letter must fit one page together with its letterhead, date, salutation and closing. At ${paragraphs} paragraphs the page holds at most ${group(maxCharacters)} characters of paragraph text, spaces included, and ${perExtraParagraphCharacters} fewer for each paragraph beyond ${paragraphs}. Aim for ${group(targetLow)} to ${group(targetHigh)} characters and never exceed the limit: before answering, count the characters of your paragraphs, and if the total is over, cut the weakest sentence or example until it fits. A letter over the limit fails the one-page check after conversion and costs a shortening round.`;
}
