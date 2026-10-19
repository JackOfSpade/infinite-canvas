/** Host-enforced bindings and replay rules for legacy audit-stop receipts. */
export const MAX_REQUIREMENTS_REEPOCHS = 2;

export function requirementsAdjudicationBindings(receipts, units = null) {
  const allowed = units == null ? null : new Set(units.map(unit => unit.id));
  const decisions = new Map();
  for (const receipt of receipts) {
    for (const row of receipt?.rows || []) {
      if (!['requirement', 'not-a-requirement'].includes(row?.disposition) || typeof row?.unitId !== 'string') {
        throw new Error('The prior requirements adjudication has a malformed binding row.');
      }
      if (decisions.has(row.unitId) && decisions.get(row.unitId) !== row.disposition) {
        throw new Error(`The prior requirements adjudication has conflicting binding decisions for ${row.unitId}.`);
      }
      decisions.set(row.unitId, row.disposition);
    }
  }
  return [...decisions].filter(([unitId]) => !allowed || allowed.has(unitId))
    .map(([unitId, disposition]) => ({ unitId, disposition }));
}

export function requirementsBindingErrors(coverage, bindingRows) {
  const binding = new Map((bindingRows || []).map(row => [row.unitId, row.disposition]));
  return (coverage || []).flatMap(row => binding.has(row?.unitId) && binding.get(row?.unitId) !== row?.disposition
    ? [`Source unit ${row.unitId} must keep the prior independent adjudicator's binding disposition ${JSON.stringify(binding.get(row.unitId))}.`]
    : []);
}

export function requirementsAuditCapTerminal(epoch, disputedUnitIds, bindingRows = []) {
  if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error('The requirements audit epoch is invalid.');
  if (!Array.isArray(disputedUnitIds) || !disputedUnitIds.length || disputedUnitIds.some(id => typeof id !== 'string' || !id)) {
    throw new Error('The requirements audit cap needs disputed unit IDs.');
  }
  const bound = new Set(bindingRows.map(row => row.unitId));
  const repeated = disputedUnitIds.filter(id => bound.has(id));
  // A lone disputed sentence has an independent, binding adjudication path.
  // Keep the cap for disputes that continue to involve multiple source units.
  if (new Set(disputedUnitIds).size === 1) return null;
  if (epoch < MAX_REQUIREMENTS_REEPOCHS && !repeated.length) return null;
  const reason = repeated.length ? 'prior-adjudication-conflict' : 'audit-re-epoch-cap';
  return {
    kind: 'requirements-audit-disagreement',
    reason,
    epoch,
    disputedUnitIds: [...new Set(disputedUnitIds)],
    message: repeated.length
      ? `Requirements audit stopped for human review because it disputed a binding prior adjudication. Disputed source units: ${[...new Set(disputedUnitIds)].join(', ')}.`
      : `Requirements audit stopped for human review after ${MAX_REQUIREMENTS_REEPOCHS} re-epochs. Disputed source units: ${[...new Set(disputedUnitIds)].join(', ')}.`,
  };
}

export function requirementsSingletonBinding(disputedUnitIds, bindingRows = [], discoveryRows = []) {
  if (disputedUnitIds?.length !== 1) return null;
  const unitId = disputedUnitIds[0];
  const binding = bindingRows.find(row => row.unitId === unitId);
  const discovery = discoveryRows.find(row => row.unitId === unitId);
  return binding && discovery?.disposition === binding.disposition ? binding : null;
}
