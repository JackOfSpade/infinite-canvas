// Fixture inputs for the career writing core golden test. The golden JSON was
// captured from applicationWriteVerify.js BEFORE the shared core extraction,
// so the test proves application prompts and validator text are unchanged.
export function goldenDocuments() {
  const evidenceIds = ['e1'];
  return {
    resume: { name: 'Ada Lovelace', contact: 'ada@example.test', roles: [{ id: 'role-acme', title: 'Engineer', company: 'Acme', dates: '', bullets: [
      { id: 'b-1', text: 'Built reliable services.', evidenceIds }, { id: 'b-2', text: 'Delivered a synthetic unsupported outcome — “quoted”.', evidenceIds },
    ] }], projects: [], skills: [{ id: 's-1', group: 'Languages', items: ['Python', 'Go'], evidenceIds }], education: [], credentials: [] },
    coverLetter: { name: 'Ada Lovelace', contact: 'ada@example.test', roleThesis: 'My prior work is relevant to the role.',
      coverLetterArgument: { primaryEvidence: { evidence: 'Built reliable services.', evidenceRole: 'Engineer at Acme', relationToThesis: 'The prior delivery supports the thesis.' } },
      paragraphs: [{ id: 'p-1', text: 'My synthetic first paragraph makes a claim.', evidenceIds: ['e1', 'job-listing-1'] }] },
  };
}
export const goldenFindings = [
  { id: 'b-1', claim: 'Built reliable services.', reason: 'Synthetic finding.', quote: 'Built services.' },
  { id: 'b-2', claim: 'synthetic unsupported outcome - "quoted"', reason: 'Folding.' },
  { id: 'b-2', claim: 'Delivered a … outcome', reason: 'Ellipsis.' },
  { id: 'nope', claim: '', reason: '' },
  null, [], 7,
];
export function goldenState(w) {
  const state = w.initialWriteVerifyState();
  Object.assign(state.candidates[0], { structured: goldenDocuments(), status: 'accepted', plainText: 'RÉSUMÉ\nx\nCOVER LETTER\ny' });
  state.ranking = ['candidate-1']; state.factIndex = 0;
  state.factFindings = [{ id: 'b-1', claim: 'Built reliable services.', reason: 'Synthetic finding.', quote: 'Built services.' }];
  return state;
}
export const goldenListing = [{ id: 'job-listing-1', sourceId: 'job-listing', quote: 'We build services.' }, { id: 'job-listing-2', sourceId: 'job-listing', quote: 'Unused.' }];
