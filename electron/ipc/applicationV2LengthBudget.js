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
