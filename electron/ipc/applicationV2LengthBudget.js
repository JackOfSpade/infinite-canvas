/** Layout calibration from measured one-page résumé renders. No career data lives here. */
export function writeVerifyLengthBudgetForStructure({ roles, education, skillsRows, projects }) {
  for (const value of [roles, education, skillsRows, projects]) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('Application v2 length-budget structure must use nonnegative integer counts.');
  }
  // Calibrated against rendered accepted and dropped drafts. Each extra fixed
  // row consumes space before prose; the fit gate remains the final authority.
  const capacity = Math.max(300, 1780 - 30 * roles - 25 * education - 65 * skillsRows - 25 * projects);
  const minCharacters = Math.round(capacity * 0.85 / 10) * 10;
  const maxCharacters = Math.round(capacity / 10) * 10;
  const maxBullets = Math.max(2, Math.min(11, 11 - projects - Math.max(0, roles - 3)));
  const minBullets = Math.max(1, maxBullets - 2);
  return { structure: { roles, education, skillsRows, projects }, minCharacters, maxCharacters, minBullets, maxBullets };
}

export function writeVerifyLengthBudgets(profile, sourceRoles) {
  const roles = Math.min(3, (sourceRoles || []).length);
  const education = Math.min(1, (profile?.education || []).length);
  const availableSkills = (profile?.skills || []).length;
  const projectCount = Math.min(3, (profile?.projects || []).length);
  return [
    writeVerifyLengthBudgetForStructure({ roles, education, skillsRows: Math.min(3, availableSkills), projects: 0 }),
    ...(projectCount ? [writeVerifyLengthBudgetForStructure({ roles, education, skillsRows: Math.min(1, availableSkills), projects: projectCount })] : []),
  ];
}
