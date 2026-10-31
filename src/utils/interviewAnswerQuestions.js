// A model-authored question can smuggle an uncited assertion into an otherwise
// grounded card ("Why did you increase revenue by ...?"). The worker chooses
// topics and examples for this role, but all visible question/intent wording
// comes from this host-authored, fact-free catalog.
export const INTERVIEW_ANSWER_QUESTION_CATALOG = Object.freeze([
  ['Tell me about yourself.', ['Walk me through your background.', 'Can you introduce yourself?']],
  ['Tell me about your relevant experience.', ['Which experience is most relevant to this role?', 'What experience would you bring?']],
  ['Why are you interested in this role?', ['What interests you about this position?', 'Why this role?']],
  ['Why are you interested in this company?', ['Why do you want to work here?', 'What interests you about our company?']],
  ['Walk me through a project.', ['Tell me about a project you worked on.', 'Describe a relevant project.']],
  ['Describe a challenge you faced.', ['Tell me about a challenging situation.', 'Describe a difficult problem.']],
  ['How do you prioritize your work?', ['How do you decide what to work on first?', 'Tell me about competing priorities.']],
  ['How do you collaborate with others?', ['Tell me about working with stakeholders.', 'Describe your approach to teamwork.']],
  ['How do you handle disagreement?', ['Tell me about a conflict.', 'Describe a time you faced pushback.']],
  ['Describe your approach to leadership.', ['Tell me about leading a team.', 'How do you support other people?']],
  ['Walk me through a technical problem.', ['How do you approach technical challenges?', 'Tell me about a systems problem.']],
  ['Tell me about improving a process.', ['Describe a process improvement.', 'How do you make work more effective?']],
  ['How do you work under pressure?', ['Tell me about a tight deadline.', 'How do you approach urgent work?']],
  ['Walk me through a decision.', ['How do you make decisions?', 'Describe a tradeoff you considered.']],
  ['Tell me about a result from your work.', ['What outcome can you describe?', 'Describe the impact of a project.']],
  ['Tell me about something you learned.', ['What did you learn from that experience?', 'How has your experience shaped your approach?']],
  ['How do you understand customer needs?', ['Tell me about customer research.', 'How do you approach discovery?']],
  ['What strengths would you bring?', ['What do you do well?', 'Which strengths are relevant to this role?']],
  ['Tell me about something that did not go as planned.', ['Describe a setback.', 'Tell me about a mistake or failure.']],
  ['How do you adapt to change?', ['Tell me about a change in direction.', 'How do you handle changing requirements?']],
  ['How do you approach ambiguity?', ['Tell me about an unclear problem.', 'How do you get started without complete information?']],
  ['How do you respond to feedback?', ['Tell me about receiving feedback.', 'How has feedback changed your work?']],
  ['How do you approach planning and delivery?', ['Tell me about bringing work to completion.', 'How do you organize delivery?']],
  ['What would you like us to know about your experience?', ['Is there another example you would like to discuss?', 'What else is relevant to this conversation?']],
].map(([question, variants]) => Object.freeze({ question, variants: Object.freeze(variants) })));

// Questions asked at nearly every interview. Their answers come from career
// data alone, so one Foundation set is shared by every Interview Helper; all
// other catalog questions belong to a helper's company-specific Q&A.
const FOUNDATION_QUESTION_TEXT = Object.freeze([
  'Tell me about yourself.',
  'Walk me through a project.',
  'What strengths would you bring?',
  'Describe a challenge you faced.',
  'How do you handle disagreement?',
  'Tell me about something that did not go as planned.',
  'How do you collaborate with others?',
]);
export const INTERVIEW_FOUNDATION_QUESTIONS = Object.freeze(INTERVIEW_ANSWER_QUESTION_CATALOG.filter(item => FOUNDATION_QUESTION_TEXT.includes(item.question)));
