// Synthetic output-only interview turns. No private recordings or transcripts.
export const interviewCallTranscriptFixtures = [
  { text: 'Tell me about leading a team.', expected: 'leadership' },
  { text: 'Could you briefly walk me through your background?', expected: 'intro' },
  { text: 'How do you prioritize your work?', expected: 'priorities' },
  { text: 'How do you handle working under pressure?', expected: 'pressure' },
  { text: 'Tell me about leading a team at RivalCo?', expected: null },
  { text: 'How did you raise onboarding activation to 99%?', expected: null },
  { text: 'Tell me about never leading a team.', expected: null },
];

export const interviewCallNonQuestions = [
  'Thank you for joining us today.',
  'I worked with a team on the migration.',
  'What we did was improve the setup flow.',
  'What you do is improve the setup flow.',
  'How this works is we meet twice a week.',
  'How to prioritize work is covered in our handbook.',
  'When we worked together we used short check-ins.',
  'Tell me about',
  'Could you walk me through',
  'How would you',
  'Leadership?',
];
