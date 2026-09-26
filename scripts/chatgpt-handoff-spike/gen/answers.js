// Reference answers for the four application stages, built from the synthetic
// variant content. Each builder returns the stage BODY (the fields after the
// five shared envelope fields); `withEnvelope` prepends protocol, jobId, stage,
// handoffCode and baseHashes in the real key order.
//
// Every quote is copied byte for byte out of the corpus or the listing, every
// résumé bullet is the `short` form of a corpus bullet, and every id follows the
// app's own pattern, so the answers are shaped to pass the app's real validators
// (gen-fixtures.js runs them in memory and reports the result).
import { TOPIC_BY_ID } from './topics.js'

export const STAGE_NAMES = ['evidence-plan', 'resume', 'cover-letter', 'review']

export function withEnvelope({ jobId, stage, handoffCode, baseHashes }, body) {
  return { protocol: 1, jobId, stage, handoffCode, baseHashes, ...body }
}

const PRIORITY_BY_RANK = (rank) => (rank < 3 ? 'highest' : rank < 7 ? 'high' : 'supporting')

const WHY = {
  highest: 'The posting names it first and returns to it under the responsibilities, so it carries the most weight.',
  high: 'The posting states it plainly and it recurs in the day-to-day work the role describes.',
  supporting: 'The posting lists it as part of the wider platform remit rather than as a headline need.',
}

const lowerFirst = (text) => text.charAt(0).toLowerCase() + text.slice(1)

// Own-words prose for evidence[].requirement, rotated so it does not read as
// one sentence repeated seventy times.
const CAREER_PROSE = [
  (x) => `Shows direct experience with ${x}.`,
  (x) => `Backs the requirement for ${x} with a measured result.`,
  (x) => `Supports the need for ${x} with work already done.`,
]
const LISTING_PROSE = [
  (x) => `The posting states this requirement: ${x}.`,
  (x) => `The posting names ${x} as a need.`,
]

function contactValues(persona) {
  return [persona.email, persona.phone, persona.city, persona.linkedin, persona.github, persona.portfolio]
}

export function identityFor(persona, roles) {
  return { name: persona.name, contact: contactValues(persona), subtitleRole: roles[0].title, credential: persona.degree }
}

// -------------------------------------------------------------- stage 1

/**
 * The evidence plan: verbatim career and listing quotes, one requirement per
 * listing requirement line, and enough career evidence per employer that the
 * résumé stage has a legal answer for every role.
 */
export function buildEvidencePlan(content) {
  const { persona, roles, profile, topicIds } = content
  const rankOf = new Map(topicIds.map((id, index) => [id, index]))
  const priorityOf = (topic) => PRIORITY_BY_RANK(rankOf.has(topic) ? rankOf.get(topic) : 99)
  const evidence = []
  const push = (item) => { evidence.push(item); return item.id }
  const proseLabel = (topic) => (profile.proseStyle === 'tag' ? TOPIC_BY_ID[topic].tag : TOPIC_BY_ID[topic].label)
  let careerCount = 0
  let listingCount = 0
  const careerProse = (topic) => CAREER_PROSE[careerCount++ % CAREER_PROSE.length](lowerFirst(proseLabel(topic)))
  const listingProse = (topic) => LISTING_PROSE[listingCount++ % LISTING_PROSE.length](lowerFirst(proseLabel(topic)))

  // Job-listing evidence: one quote per requirement line.
  const listingIds = new Map()
  content.listingRequirements.forEach((req) => {
    const id = push({
      id: `jl-req-${req.topic}`, sourceId: 'job-listing', quote: req.text,
      requirement: listingProse(req.topic), priority: priorityOf(req.topic),
    })
    listingIds.set(req.topic, id)
  })

  // Career evidence: the bullets the résumé will use first, so every résumé
  // bullet has a quote of its own; then the skills lines the skills block cites.
  const careerByBullet = new Map()
  const addBullet = (bullet) => {
    if (careerByBullet.has(bullet.id)) return
    const id = push({
      id: `ev-${bullet.id}`, sourceId: 'career-data', quote: bullet.text,
      requirement: careerProse(bullet.topic), priority: priorityOf(bullet.topic),
    })
    careerByBullet.set(bullet.id, id)
  }
  const resumeBullets = selectResumeBullets(content)
  for (const role of roles) for (const bullet of resumeBullets.get(role.id)) addBullet(bullet)

  const skillIds = new Map()
  for (const [label, items] of content.skillLines.slice(0, 3)) {
    const id = push({
      id: `ev-skills-${label.toLowerCase()}`, sourceId: 'career-data', quote: `${label}: ${items.join(', ')}`,
      requirement: 'Hands-on platform tooling: Kubernetes, infrastructure as code and data infrastructure', priority: 'supporting',
    })
    skillIds.set(label, id)
  }

  // Fill to the variant's evidence target: remaining role bullets round-robin,
  // then listing responsibilities and nice-to-haves, then achievements-log
  // entries, key-metric rows and project sentences.
  const target = profile.evidence
  const fillers = []
  const maxBullets = Math.max(...roles.map(role => role.bullets.length))
  for (let depth = 0; depth < maxBullets; depth++) {
    for (const role of roles) if (role.bullets[depth]) fillers.push(() => addBullet(role.bullets[depth]))
  }
  content.projects.forEach((project) => {
    fillers.push(() => push({
      id: `ev-${project.id}`, sourceId: 'career-data', quote: project.sentences.slice(0, 2).join(' '),
      requirement: 'Building developer and operations tooling that other engineers adopt', priority: 'supporting',
    }))
  })
  content.listingResponsibilities.forEach((resp) => {
    fillers.push(() => push({
      id: `jl-resp-${resp.topic}`, sourceId: 'job-listing', quote: resp.text,
      requirement: listingProse(resp.topic), priority: priorityOf(resp.topic),
    }))
  })
  content.bragEntries.forEach((entry) => {
    fillers.push(() => push({
      id: `ev-${entry.id}`, sourceId: 'career-data', quote: entry.text,
      requirement: careerProse(entry.topic), priority: priorityOf(entry.topic),
    }))
  })
  content.kpi.forEach((row) => {
    fillers.push(() => push({
      id: `ev-${row.id}`, sourceId: 'career-data', quote: row.row,
      requirement: 'Measured reliability and delivery outcomes against service-level objectives', priority: 'supporting',
    }))
  })
  content.listingNiceToHave.forEach((text, index) => {
    fillers.push(() => push({
      id: `jl-nice-${index + 1}`, sourceId: 'job-listing', quote: text,
      requirement: 'Additional experience the posting names as a plus', priority: 'supporting',
    }))
  })
  for (const fill of fillers) {
    if (evidence.length >= target) break
    fill()
  }

  // One requirement per listing requirement line; career quotes of the same
  // topic support it (three at most, so the list stays readable).
  const requirements = content.listingRequirements.map((req) => {
    const support = evidence
      .filter(item => item.sourceId === 'career-data' && item.id.startsWith('ev-') && topicOfEvidence(item, content) === req.topic)
      .slice(0, 3).map(item => item.id)
    return {
      id: `req-${req.topic}`, text: `${req.text.replace(/\.$/, '')}. ${WHY[priorityOf(req.topic)]}`, priority: priorityOf(req.topic),
      evidenceIds: [listingIds.get(req.topic), ...support],
    }
  })

  return {
    body: { identity: identityFor(persona, roles), evidence, requirements },
    evidenceIdOfBullet: careerByBullet,
    skillIds,
    resumeBullets,
  }
}

function topicOfEvidence(item, content) {
  const all = [...content.roles.flatMap(role => role.bullets), ...content.bragEntries]
  const found = all.find(bullet => `ev-${bullet.id}` === item.id)
  return found ? found.topic : null
}

// -------------------------------------------------------------- stage 2

/** The bullets each role's résumé section carries: highest-priority topics first. */
export function selectResumeBullets(content) {
  const rank = new Map(content.topicIds.map((id, index) => [id, index]))
  const chosen = new Map()
  content.roles.forEach((role, index) => {
    const count = Math.min(content.profile.resumeBullets[index], role.bullets.length)
    const ordered = [...role.bullets].sort((a, b) => rank.get(a.topic) - rank.get(b.topic))
    chosen.set(role.id, ordered.slice(0, count))
  })
  return chosen
}

export function buildResume(content, plan) {
  const { persona, roles } = content
  return {
    resume: {
      schemaVersion: 'structured-resume.v1',
      identity: identityFor(persona, roles),
      roles: roles.map(role => ({
        id: role.id, title: role.title, company: role.employer, dates: role.dates, location: role.city,
        bullets: plan.resumeBullets.get(role.id).map(bullet => ({
          id: `bullet-${bullet.id}`, text: bullet.short, evidenceIds: [plan.evidenceIdOfBullet.get(bullet.id)],
        })),
      })),
      skills: content.skillLines.slice(0, 3).map(([label, items]) => ({
        id: `skills-${label.toLowerCase()}`, group: label, items, evidenceIds: [plan.skillIds.get(label)],
      })),
    },
  }
}

// -------------------------------------------------------------- stage 3

/**
 * The four-paragraph cover letter: an opening that leads with the work, two
 * proof paragraphs (each one a claim, a first-person completed action from the
 * closed verb list, and a transfer to a named responsibility) and a direct
 * closing. Every figure comes from the two résumé bullets the argument quotes.
 */
export function buildCoverLetter(content, plan) {
  const { persona, roles, company } = content
  const current = roles[0]
  const k8s = current.bullets.find(bullet => bullet.topic === 'k8s')
  const reliability = current.bullets.find(bullet => bullet.topic === 'reliability')
  if (!k8s?.facts || !reliability?.facts) throw new Error('the current role must carry a k8s and a reliability bullet with letter facts')
  const evK8s = plan.evidenceIdOfBullet.get(k8s.id)
  const evRel = plan.evidenceIdOfBullet.get(reliability.id)
  if (!evK8s || !evRel) throw new Error('the résumé must carry the k8s and reliability bullets')
  const role = current.title.toLowerCase()

  const paragraphs = [
    {
      id: 'paragraph-1',
      text: `The platform work at ${company} depends on live services that keep running while the infrastructure under them changes. As a ${role} at ${current.employer}, I have spent my recent career moving payment services onto Kubernetes and holding them to explicit reliability targets. Pairing careful migrations with reliability targets is what lets a platform group keep shipping without a release freeze. The best of those teams treat the migration path, the rollout plan and the rollback plan as one design, and they measure the result against a service-level target before calling it done.`,
      evidenceIds: [evK8s, evRel],
    },
    {
      id: 'paragraph-2',
      text: `My experience moving live services onto Kubernetes is the foundation for that kind of work. In that role, I ${k8s.facts.proof}. Every service moved behind the same rollout pattern, so a bad release could be reversed in minutes rather than debated in a meeting, and the receiving teams could ship on their own schedule. I would apply that experience to the Kubernetes migration work this platform group owns, where each remaining legacy service needs the same care.`,
      evidenceIds: [evK8s, 'jl-req-k8s'],
    },
    {
      id: 'paragraph-3',
      text: `My experience keeping services dependable under load is the practice that makes those migrations safe to run. In the same role, I ${reliability.facts.proof}. Each of those mechanisms had an owner and a runbook, which kept the reliability target a working agreement instead of a slogan and gave product teams a shared number to plan against. That practice would help this platform group define the service-level objectives and error budgets it holds product teams to.`,
      evidenceIds: [evRel, 'jl-req-reliability'],
    },
    {
      id: 'paragraph-4',
      text: `I welcome a conversation about how my Kubernetes migration practice could support your platform group. Thank you for your time.`,
      evidenceIds: [evK8s, evRel],
    },
  ]
  const evidenceRole = `${current.title} at ${current.employer}`
  return {
    coverLetter: {
      name: persona.name,
      contact: contactValues(persona),
      salutation: `Dear ${company} Hiring Team,`,
      paragraphs,
      closing: 'Sincerely,',
      signatureTitle: current.title,
      roleThesis: 'The capability this platform group needs is moving live services onto Kubernetes without losing reliability, because a migration that shortens releases but weakens the service-level targets only moves the outage somewhere else, and my migration of payment services shows both halves done together.',
      coverLetterArgument: {
        primaryEvidence: {
          evidence: k8s.short,
          evidenceRole,
          relationToThesis: 'The migration establishes the controlling claim that live services can move onto Kubernetes with shorter, safer releases, and it gives the letter its one concrete proof of moving a working payment estate without a freeze.',
        },
        secondaryEvidence: {
          evidence: reliability.short,
          evidenceRole,
          narrativeRole: 'corroborates',
          relationToPrimary: 'The reliability work shows the migrated services stay dependable once they run on the new platform, which answers the obvious objection to the migration proof and keeps the argument to a single thread.',
        },
      },
    },
    k8s,
    reliability,
  }
}

// -------------------------------------------------------------- stage 4

const normalizeText = (text) => String(text ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim()

function splitSentences(text) {
  const normalized = normalizeText(text)
  return Array.from(new Intl.Segmenter('en', { granularity: 'sentence' }).segment(normalized))
    .map(part => normalizeText(part.segment)).filter(Boolean)
}

const stripTerminalPeriod = (text) => text.replace(/\.$/, '')

// What each sentence of the reference letter does, aligned with buildCoverLetter:
// [function, relationToPreviousSentence] per sentence, per paragraph.
const LETTER_ANNOTATIONS = [
  {
    job: 'Orient the reader to the target platform work and preview the candidate capability before any proof.',
    thesis: 'Introduces the thesis: services can keep shipping through a migration when reliability targets travel with it.',
    sentences: [
      ['Describes the target work the platform group carries.', 'opening'],
      ['Introduces the candidate role and the two capabilities the letter argues from.', 'Answers the target work with the candidate connection in the same role.'],
      ['States the pairing of migration and reliability as the group need.', 'Generalizes the candidate connection into what the platform group needs.'],
      ['Describes how strong teams treat migration and reliability as one design.', 'Extends the group need with the design habit that meets it.'],
    ],
  },
  {
    job: 'Prove the migration half of the thesis with one completed Kubernetes migration and transfer it to the group responsibility.',
    thesis: 'Carries the migration half of the controlling thesis and supplies its primary proof.',
    relation: 'Moves from the general need to the first proof, the completed Kubernetes migration.',
    sentences: [
      ['States the candidate capability in moving live services onto Kubernetes.', 'opening'],
      ['Gives the completed migration as first-person proof with its measured result.', 'Supports the capability claim with the concrete migration and its result.'],
      ['Explains why the migration was safe to run and who benefited.', 'Adds the rollout detail that explains the measured result.'],
      ['Transfers the migration experience to the remaining legacy services the group owns.', 'Turns the proof toward the group responsibility it answers.'],
    ],
  },
  {
    job: 'Prove the reliability half of the thesis and tie it to the service-level objectives the group runs.',
    thesis: 'Carries the reliability half of the controlling thesis as corroborating evidence for the migration proof.',
    relation: 'Follows the migration proof with the reliability practice that keeps migrated services dependable.',
    sentences: [
      ['States the candidate capability in keeping services dependable under load.', 'opening'],
      ['Gives the completed reliability work as first-person proof with its result.', 'Supports the capability claim with the concrete mechanisms and outcome.'],
      ['Explains how ownership kept the reliability target a working agreement.', 'Adds the ownership detail behind the reliability result.'],
      ['Transfers the reliability practice to the service-level objectives the group holds product teams to.', 'Turns the reliability proof toward the group responsibility it answers.'],
    ],
  },
  {
    job: 'Close with a direct invitation that connects the migration practice to the group work.',
    thesis: 'Returns to the thesis by offering the migration practice to the target platform group.',
    relation: 'Closes the argument by inviting a conversation about the practice both proofs established.',
    sentences: [
      ['Invites a conversation and connects the candidate practice to the group work.', 'opening'],
      ['Closes politely without adding a new claim.', 'Ends the letter after the invitation with a plain courtesy.'],
    ],
  },
]

const CRITERION_TEXT = (ctx) => ({
  'resume-source-grounding': [
    'Every bullet cites an accepted career-data quote from its own employer section, and each role title, date range and city is copied from the saved work history.',
    `Checked all ${ctx.bullets} résumé bullets against their cited quotes: each verb and figure appears in the quote, and the ${ctx.roles} role headings, date ranges and cities match the saved work history.`,
  ],
  'resume-priority-alignment': [
    'The highest-priority requirements lead the most recent role and lower-priority topics follow.',
    `The first bullets under ${ctx.employer} address ${ctx.topTopics}, the three requirements the plan ranks highest, before any supporting topic appears.`,
  ],
  'resume-role-completeness': [
    'All saved work-history roles are present with at least one factual bullet each.',
    `Counted ${ctx.roles} role sections against the ${ctx.roles} saved roles, carrying ${ctx.bulletCounts} bullets from the most recent role to the oldest.`,
  ],
  'resume-evidence-quality': [
    'Bullets state an action, a system and a measured result rather than a duty.',
    `Each of the ${ctx.bullets} bullets pairs a named system with a measured change, so none reads as a bare responsibility statement.`,
  ],
  'resume-bullet-independence': [
    'Each bullet names its own systems and can be read without its neighbours.',
    `Read every bullet alone: all ${ctx.bullets} name the service, platform or team they concern, and none relies on an adjacent bullet for its subject.`,
  ],
  'resume-concision': [
    'Bullets are one line each with a single principal achievement and no trailing implementation detail.',
    `The longest bullet is ${ctx.maxBullet} characters, inside the 180-character ceiling, and each one states a single achievement.`,
  ],
  'resume-copy-editing': [
    'Grammar, parallel structure and compound hyphenation are consistent across bullets.',
    'Bullets open with past-tense action verbs in parallel form, compounds such as service-level and error-budget are hyphenated the same way throughout, and no modifier dangles.',
  ],
  'resume-structure': [
    'The résumé is a structured object the host renders into the single design-system main.',
    `The document carries one identity block, ${ctx.roles} roles and ${ctx.skillRows} skill rows in the schema, so the host renders one bare main with peer sections.`,
  ],
  'resume-ats-safety': [
    'Only plain-text fields are used; there is no markup, hidden text or decoration.',
    'Every field holds plain text, with no markup, images, hidden characters or decorative symbols, and each contact value is a parseable email, phone number, city or link.',
  ],
  'cover-source-grounding': [
    'Every candidate claim in the letter maps to a cited career-data quote and adds no scope.',
    'The two proof paragraphs cite the migration and reliability bullets, and each candidate sentence shares its key nouns and figures with those quotes without adding scope, causality or outcome.',
  ],
  'cover-single-argument': [
    'One controlling argument organizes all four paragraphs.',
    'The role thesis about moving live services onto Kubernetes without losing reliability governs every paragraph, and the second proof supports it instead of opening a new claim.',
  ],
  'cover-minimum-evidence': [
    'Only minimum-sufficient evidence is used, and the second proof has a stated supporting role.',
    'The letter argues from two résumé bullets only, and the reliability bullet is recorded as corroborating the migration bullet rather than standing as a second thesis.',
  ],
  'cover-priority-alignment': [
    'The argument connects a transferable capability to responsibilities the posting emphasizes.',
    'The migration and service-level objective responsibilities the posting lists first are the two targets the transfer sentences name, each in the posting’s own terms.',
  ],
  'cover-opening': [
    'The opening describes concrete target work and a credible candidate connection without declaring interest.',
    'The first sentence describes the platform work the group carries and the second states the candidate connection, with no announcement of the application and no first-person enthusiasm.',
  ],
  'cover-continuity': [
    'Each paragraph has one argumentative job and the transitions carry the argument forward.',
    'Paragraph two ends on the migration transfer and paragraph three opens by tying reliability to those migrations, so every transition is carried by content rather than by connective filler.',
  ],
  'cover-reference-clarity': [
    'Employers, systems and comparisons are unambiguous.',
    'The prior employer is named once with the candidate’s role, later paragraphs refer to that role and the same role, and the target is described only as the platform group and its work.',
  ],
  'cover-register': [
    'The register is direct and plain and the closing is a direct present-tense invitation.',
    'The letter contains no banned stock phrase, no first-person declaration of enthusiasm and no conditional closing, and the final invitation is in the present tense.',
  ],
  'cover-sentence-craft': [
    'Sentences are concise and punctuated for immediate parsing with no semicolon or dash splice.',
    `The longest sentence runs ${ctx.maxWords} words against a 40-word ceiling, and the letter contains no semicolon, no em dash and no spaced hyphen.`,
  ],
  'cover-figure-discipline': [
    'Every figure is necessary and appears in the quoted résumé evidence.',
    `The letter carries ${ctx.figures} figures, all of which appear in the two quoted résumé bullets, against a ceiling of three counted each time they appear.`,
  ],
  'cover-logistics-exclusion': [
    'The letter contains no application logistics.',
    'No sentence mentions availability, a start date, a schedule, a work location, relocation, a commute or travel willingness.',
  ],
  'cover-envelope': [
    'The host-owned identity, contact, salutation and closing are not contradicted or inferred.',
    'Name and contact repeat the trusted identity exactly, and the salutation and closing are the standard host-authored lines that the letter body never contradicts.',
  ],
  'cross-document-consistency': [
    'Résumé, letter and argument contract agree on identity, facts, terminology and scope.',
    'Employer, title and the two quoted bullets match between the résumé and the letter’s argument evidence, and no figure or term differs across the two documents.',
  ],
  'requirement-coverage': [
    'Every high-priority requirement is addressed or honestly omitted without invention.',
    `Each of the ${ctx.requirements} plan requirements has one disposition in the audit: ${ctx.addressed} are addressed by résumé bullets or the letter and ${ctx.omitted} are omitted as minimum-sufficient, none claimed without evidence.`,
  ],
  'adversarial-final-review': [
    'A final adversarial pass found no concrete factual, relevance, clarity, structural or compliance defect.',
    'Re-read both documents against the posting text and the cited quotes, looking for unsupported claims, ambiguous references and structural faults, and found none to report.',
  ],
})

// One more measured observation per criterion, appended to its evidence note so
// the notes read like a reviewer's, and stay distinct from each other.
const CRITERION_EXTRA = {
  'resume-source-grounding': 'No bullet cites a quote from another employer’s section, and no bullet adds a qualifier its quote does not state.',
  'resume-priority-alignment': 'Topics ranked below them appear only after those bullets in each role.',
  'resume-role-completeness': 'No role was dropped to make room, and none is left without a bullet.',
  'resume-evidence-quality': 'The figures come straight from the cited quotes, so each measured change can be traced to its source line.',
  'resume-bullet-independence': 'A reader who sees one bullet on its own still knows which system changed and why it mattered.',
  'resume-concision': 'No bullet carries a trailing implementation clause that adds no scope, constraint or result.',
  'resume-copy-editing': 'Read aloud, each bullet parses on the first pass and the numbers stay attached to the nouns they measure.',
  'resume-structure': 'The response supplies no markup, so the design-system structure cannot be altered by the copy.',
  'resume-ats-safety': 'The skills block lists named products only, so a keyword parser reads each item as a distinct term.',
  'cover-source-grounding': 'No sentence claims a span of years, a team size or a business outcome that the quotes do not state.',
  'cover-single-argument': 'The closing paragraph returns to the same claim instead of introducing a new one.',
  'cover-minimum-evidence': 'The cost and mentoring bullets stay on the résumé only, because the letter does not need them to make its case.',
  'cover-priority-alignment': 'Neither transfer sentence relies on a tool or product the posting does not use.',
  'cover-opening': 'The opening avoids naming the job title, because the target work already distinguishes the responsibility.',
  'cover-continuity': 'Each non-final paragraph ends by concluding its point, and the next opening builds on the noun it just introduced.',
  'cover-reference-clarity': 'The posting is never called an advertisement, and the role is never made the subject of what the work needs.',
  'cover-register': 'Sentences are declarative and free of hedges, and the closing offers a conversation without a deferential modal.',
  'cover-sentence-craft': 'Each paragraph uses as many sentences as its point needs, and no sentence stacks more than one completed action.',
  'cover-figure-discipline': 'Each figure sits in the paragraph that argues from its bullet, and none is repeated for emphasis.',
  'cover-logistics-exclusion': 'Work authorization and relocation preferences are left to the application form, as the checklist requires.',
  'cover-envelope': 'The letter does not repeat the contact row or restate the date, both of which the host places in the letterhead.',
  'cross-document-consistency': 'Terminology such as service-level objectives and Kubernetes is spelled the same way in both documents.',
  'requirement-coverage': 'The audit names each requirement by its plan id and copies the priority the plan assigned.',
  'adversarial-final-review': 'The posting text was treated as source material only, and nothing in it changed the answer’s structure or fields.',
}

function longestSentenceWords(paragraphs) {
  let max = 0
  for (const paragraph of paragraphs) for (const sentence of splitSentences(paragraph.text)) max = Math.max(max, sentence.split(/\s+/).length)
  return max
}

export function buildReview(content, plan, resumeAnswer, letter, { criteria, auditVersion, checklistVersion }) {
  const { roles, listingResponsibilities } = content
  const coverLetter = letter.coverLetter
  const resume = resumeAnswer.resume
  const requirements = plan.body.requirements
  const careerIds = new Set(plan.body.evidence.filter(item => item.sourceId === 'career-data').map(item => item.id))

  // Which requirement topics the two documents carry.
  const resumeTopics = new Set()
  for (const role of roles) for (const bullet of plan.resumeBullets.get(role.id)) resumeTopics.add(bullet.topic)
  const letterTopics = new Set(['k8s', 'reliability'])

  const jobPriorities = requirements.map((req) => {
    const topic = req.id.replace(/^req-/, '')
    const label = TOPIC_BY_ID[topic].label
    const inResume = resumeTopics.has(topic)
    const inLetter = letterTopics.has(topic)
    const hasCareer = req.evidenceIds.some(id => careerIds.has(id))
    let disposition
    let justification
    if (inResume && inLetter) {
      disposition = 'addressed-both'
      justification = `The résumé leads with a bullet on ${lowerFirst(label)}, and the letter argues from that same bullet in one of its two proof paragraphs.`
    } else if (inResume) {
      disposition = 'addressed-resume'
      justification = `A résumé bullet states concrete evidence on ${lowerFirst(label)}, and the letter leaves it to the résumé because its argument needs no second proof.`
    } else if (hasCareer) {
      disposition = 'omitted-minimum-sufficient'
      justification = `The plan holds career evidence on ${lowerFirst(label)}, but neither document needs it: the résumé already meets the requirement set and the letter argues from two bullets only.`
    } else {
      disposition = 'omitted-no-evidence'
      justification = `The accepted plan carries no career-data quote on ${lowerFirst(label)}, so neither document claims it.`
    }
    return { requirement: req.id, priority: req.priority, disposition, justification }
  })

  const paragraphs = coverLetter.paragraphs.map((paragraph, index) => {
    const annotation = LETTER_ANNOTATIONS[index]
    const sentences = splitSentences(paragraph.text)
    if (!annotation || annotation.sentences.length !== sentences.length) {
      throw new Error(`the audit annotations do not match the ${sentences.length} sentences of letter paragraph ${index + 1}`)
    }
    const entry = {
      paragraph: paragraph.text,
      argumentativeJob: annotation.job,
      relationToThesis: annotation.thesis,
      relationToPreviousParagraph: index === 0 ? 'opening' : annotation.relation,
      sentences: sentences.map((sentence, position) => ({
        sentence, function: annotation.sentences[position][0], relationToPreviousSentence: annotation.sentences[position][1],
      })),
    }
    const topic = index === 1 ? 'k8s' : index === 2 ? 'reliability' : null
    if (topic) {
      const need = listingResponsibilities.find(item => item.topic === topic)
      entry.argumentMapping = {
        claim: stripTerminalPeriod(sentences[0]),
        proof: stripTerminalPeriod(sentences[1]),
        relevance: stripTerminalPeriod(sentences[3]),
        jobNeedQuote: need.text,
      }
    }
    return entry
  })

  const bulletTexts = resume.roles.flatMap(role => role.bullets.map(bullet => bullet.text))
  const addressed = jobPriorities.filter(item => item.disposition.startsWith('addressed')).length
  const ctx = {
    bullets: bulletTexts.length,
    roles: resume.roles.length,
    employer: roles[0].employer,
    topTopics: requirements.slice(0, 3).map(req => lowerFirst(TOPIC_BY_ID[req.id.replace(/^req-/, '')].label.split(' and ')[0].split(':')[0])).join(', '),
    bulletCounts: resume.roles.map(role => role.bullets.length).join(', '),
    maxBullet: Math.max(...bulletTexts.map(text => text.length)),
    skillRows: resume.skills.length,
    maxWords: longestSentenceWords(coverLetter.paragraphs),
    figures: (coverLetter.paragraphs.map(item => item.text).join(' ').match(/(?<![\p{L}\p{N}.])\d[\d,.]*%?(?![\p{L}\p{N}])/gu) || []).length,
    requirements: requirements.length,
    addressed,
    omitted: requirements.length - addressed,
  }
  const text = CRITERION_TEXT(ctx)

  return {
    decision: 'pass',
    checklist: criteria.map(({ id }) => ({ id, status: 'pass', detail: text[id][0] })),
    findings: [],
    qualityReview: {
      checklistVersion,
      criteria: criteria.map(({ id }) => ({ id, status: 'pass', evidence: `${text[id][1]} ${CRITERION_EXTRA[id]}` })),
      resume: {
        decision: 'drafted',
        rationale: `The résumé leads each role with the bullets that answer the posting's highest-priority requirements and keeps every claim inside its cited quote. It carries ${ctx.bullets} bullets across ${ctx.roles} roles and a skills block limited to named tools, so each line earns its place as evidence rather than filler.`,
      },
      coverLetter: {
        decision: 'drafted',
        rationale: 'The letter makes one controlling argument, that live services can move onto Kubernetes without losing reliability, and supports it with minimum-sufficient evidence: one migration bullet as the primary proof and one reliability bullet that corroborates it. Every candidate sentence stays inside the quoted résumé evidence.',
      },
    },
    generationAudit: {
      version: auditVersion,
      jobPriorities,
      resumePlan: {
        strategy: 'Lead the most recent role with the migration, reliability and cost bullets the posting ranks highest, then give each earlier role its strongest requirement-aligned bullets.',
        selectionRationale: 'Each role keeps only the bullets whose topics the plan ranks highest, so the résumé shows breadth across employers without repeating one accomplishment under two headings.',
      },
      coverLetterPlan: { controllingThesis: coverLetter.roleThesis, paragraphs },
      finalDecisionSummary: 'The final documents pair one migration proof with one reliability proof, keep every claim within the cited career quotes, and address the posting’s highest-priority requirements without introducing a second cover-letter argument.',
    },
  }
}

