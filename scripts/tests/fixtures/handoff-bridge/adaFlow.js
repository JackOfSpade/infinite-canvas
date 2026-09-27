// Deliberately small synthetic copy of the four-stage application happy path.
// It is not imported from the app's tests so the fixture remains stable.
export const adaFlow = Object.freeze([
  { stage: 'evidence-plan', prompt: 'Build an evidence plan for Ada Lovelace.' },
  { stage: 'resume', prompt: 'Draft Ada Lovelace’s tailored resume.' },
  { stage: 'cover-letter', prompt: 'Draft Ada Lovelace’s cover letter.' },
  { stage: 'review', prompt: 'Review the application for accuracy.' },
]);
