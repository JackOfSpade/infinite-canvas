import { indentedReportCode, reportFilterCodes, sanitizeReportProse } from './helpers.js';

// The current producer bounds its complete visible-text projection to the
// accepted-result envelope (1 MiB). Leave room for Markdown framing and
// redaction markers, while treating malformed/future telemetry as unavailable
// instead of silently sampling its document.
const MAX_COMPLETE_OUTPUT_RENDER_BYTES = 1_250_000;

const APPLICATION_OUTPUT_FILTER_CODE = 'APPOUTPUT';

export function codeIncludesApplicationOutput(filterCode) {
  const codes = reportFilterCodes(filterCode);
  // FULL is the user's broad, explicit report selection. New diagnostics must
  // be present there; APPOUTPUT remains useful as the narrow output-only code.
  return codes.includes(APPLICATION_OUTPUT_FILTER_CODE) || codes.includes('FULL');
}

const sanitizeOutputText = value => sanitizeReportProse(value, { stripTrailingSpaces: true });

const indentedCode = text => indentedReportCode(text, 4);

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function digest(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value) ? value.toLowerCase() : null;
}

function appendLiteral(lines, label, value) {
  const text = sanitizeOutputText(value);
  if (!text) return;
  lines.push(`  - ${label}:`);
  lines.push(indentedCode(text));
}

function appendLiteralList(lines, label, values) {
  const usable = (Array.isArray(values) ? values : []).map(sanitizeOutputText).filter(Boolean);
  if (!usable.length) return;
  lines.push(`  - ${label} (${usable.length}):`);
  usable.forEach((value, index) => {
    lines.push(`    - Item ${index + 1}:`);
    lines.push(indentedCode(value));
  });
}

const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const plainObjects = value => (Array.isArray(value) ? value.filter(isPlainObject) : []);

function renderResumeLines(resume) {
  const lines = ['', '### Résumé'];
  const roles = plainObjects(resume.roles);
  const projects = plainObjects(resume.projects);
  const skills = plainObjects(resume.skills);
  const identity = isPlainObject(resume.identity) ? resume.identity : {};
  appendLiteral(lines, 'Name', identity.name);
  appendLiteral(lines, 'Tagline', identity.tagline);
  appendLiteral(lines, 'Subtitle role', identity.subtitleRole);
  appendLiteral(lines, 'Credential', identity.credential);
  appendLiteralList(lines, 'Contact line(s)', identity.contact);
  if (roles.length) {
    lines.push(`- Experience roles (${roles.length}):`);
    roles.forEach((role, index) => {
      lines.push(`  - Role ${index + 1}:`);
      appendLiteral(lines, 'Title', role.title);
      appendLiteral(lines, 'Company', role.company);
      appendLiteral(lines, 'Dates', role.dates);
      appendLiteral(lines, 'Location', role.location);
      appendLiteral(lines, 'Summary', role.summary);
      appendLiteralList(lines, 'Bullets', role.bullets);
    });
  } else lines.push('- Experience roles: none in final résumé.');
  if (projects.length) {
    lines.push(`- Projects (${projects.length}):`);
    projects.forEach((project, index) => {
      lines.push(`  - Project ${index + 1}:`);
      appendLiteral(lines, 'Name', project.name);
      appendLiteral(lines, 'Description', project.description);
      appendLiteral(lines, 'Metrics', project.metrics);
    });
  } else lines.push('- Projects: none in final résumé.');
  if (skills.length) {
    lines.push(`- Skill groups (${skills.length}):`);
    skills.forEach((group, index) => {
      lines.push(`  - Skill group ${index + 1}:`);
      appendLiteral(lines, 'Group', group.group);
      appendLiteralList(lines, 'Items', group.items);
    });
  } else lines.push('- Skill groups: none in final résumé.');
  appendLiteralList(lines, 'Education / credential line(s)', resume.education);
  return lines;
}

function renderLetterLines(coverLetter) {
  const lines = ['', '### Cover Letter'];
  appendLiteral(lines, 'Name', coverLetter.name);
  appendLiteral(lines, 'Tagline', coverLetter.tagline);
  appendLiteral(lines, 'Subtitle role', coverLetter.subtitleRole);
  appendLiteral(lines, 'Credential', coverLetter.credential);
  appendLiteralList(lines, 'Contact line(s)', coverLetter.contact);
  appendLiteral(lines, 'Date', coverLetter.date);
  appendLiteral(lines, 'Recipient', coverLetter.recipient);
  appendLiteral(lines, 'Salutation', coverLetter.salutation);
  appendLiteralList(lines, 'Final paragraphs', coverLetter.paragraphs);
  appendLiteral(lines, 'Closing', coverLetter.closing);
  appendLiteral(lines, 'Signature title', coverLetter.signatureTitle);
  return lines;
}

/**
 * Render only a typed, in-memory projection created beside final Local-AI
 * telemetry.  This function never follows a file path supplied by a renderer
 * or a card, and never reads an application artifact from disk.
 */
function renderV2Output(output, documentScope = null) {
  const resume = output?.documents?.resume;
  const coverLetter = output?.documents?.coverLetter;
  if (!isPlainObject(resume) || !isPlainObject(coverLetter)) return null;
  const lines = [
    '',
    '## Application Output Evidence (APPOUTPUT)',
    '- Scope: the complete, typed visible-text projection of the final accepted résumé and cover letter, retained in this process at final-output validation. `FULL` includes this section; `APPOUTPUT` selects it directly.',
    '- Safety: this is an in-memory projection, never a renderer-provided path or a disk reread. Final prose is rendered as literal code and report redaction runs again at this boundary.',
    '- Completeness: no role, bullet, project, skill group/item, education/credential line, or visible cover-letter header/body field is selected as a sample.',
  ];
  // A one-document job has no other document. Saying "none in final résumé"
  // for a letter-only run read as a résumé that had lost its content.
  if (documentScope === 'cover') lines.push('', '### Résumé', '- Not part of this job: it produced only a cover letter. The résumé in the saved folder came from an earlier job and is not shown here.');
  else lines.push(...renderResumeLines(resume));
  if (documentScope === 'resume') lines.push('', '### Cover Letter', '- Not part of this job: it produced only a résumé.');
  else lines.push(...renderLetterLines(coverLetter));

  const metadata = isPlainObject(output.metadata) ? output.metadata : {};
  const resumeMetadata = isPlainObject(metadata.resume) ? metadata.resume : {};
  const letterMetadata = isPlainObject(metadata.coverLetter) ? metadata.coverLetter : {};
  const digests = isPlainObject(metadata.digests) ? metadata.digests : {};
  const countLines = [
    ['Retained projection bytes', nonNegativeInteger(metadata.retainedBytes)],
    ['Résumé roles', nonNegativeInteger(resumeMetadata.roleCount)],
    ['Résumé bullets', nonNegativeInteger(resumeMetadata.bulletCount)],
    ['Résumé projects', nonNegativeInteger(resumeMetadata.projectCount)],
    ['Skill groups', nonNegativeInteger(resumeMetadata.skillGroupCount)],
    ['Skill items', nonNegativeInteger(resumeMetadata.skillItemCount)],
    ['Education / credential lines', nonNegativeInteger(resumeMetadata.educationCount)],
    ['Cover-letter paragraphs', nonNegativeInteger(letterMetadata.paragraphCount)],
  ].filter(([, value]) => value !== null)
    .filter(([label]) => documentScope === 'cover' ? label === 'Retained projection bytes' || label.startsWith('Cover-letter')
      : documentScope === 'resume' ? !label.startsWith('Cover-letter') : true);
  lines.push('', '### Result Metadata');
  countLines.forEach(([label, value]) => lines.push(`- ${label}: ${value}`));
  const resumeDigest = digest(digests.resume);
  const coverDigest = digest(digests.coverLetter);
  if (resumeDigest && documentScope !== 'cover') lines.push(`- Résumé visible-text digest (SHA-256): \`${resumeDigest}\``);
  if (coverDigest && documentScope !== 'resume') lines.push(`- Cover-letter visible-text digest (SHA-256): \`${coverDigest}\``);
  const markdown = `${lines.join('\n')}\n`;
  return Buffer.byteLength(markdown, 'utf8') <= MAX_COMPLETE_OUTPUT_RENDER_BYTES ? markdown : null;
}

function renderLegacyV1Output(output) {
  const lines = [
    '',
    '## Application Output Evidence (APPOUTPUT)',
    '- Incomplete legacy snapshot: this process retained an older sampled projection, so a full black-box quality assessment is not possible. Regenerate once to obtain the complete current-format evidence.',
  ];
  appendLiteralList(lines, 'Legacy cover-letter excerpts', output?.coverLetterParagraphs);
  appendLiteralList(lines, 'Legacy résumé excerpts', output?.resumeSamples);
  return `${lines.join('\n')}\n`;
}

export function buildApplicationOutputMarkdown(application) {
  const output = application?.applicationOutput;
  if (!output || typeof output !== 'object') {
    return '\n## Application Output Evidence (APPOUTPUT)\n- Unavailable/removed: no final application-output snapshot is retained in this running app process. It was not audited. Reports from an earlier app process or after a discard cannot reconstruct it.\n';
  }
  if (output.version === 2 && output.state === 'available') {
    const rendered = renderV2Output(output, application?.documentScope === 'cover' || application?.documentScope === 'resume' ? application.documentScope : null);
    if (rendered) return rendered;
    return '\n## Application Output Evidence (APPOUTPUT)\n- Unavailable/removed: the retained final-output projection was malformed or exceeded the complete-report safety envelope. It was not partially sampled, so no complete prose-quality conclusion can be drawn.\n';
  }
  if (output.version === 2 && output.state === 'unavailable-too-large') {
    return '\n## Application Output Evidence (APPOUTPUT)\n- Unavailable/removed: the final output exceeded the retained complete-projection safety envelope. It was not partially sampled, so no complete prose-quality conclusion can be drawn.\n';
  }
  if (output.version === 1 && output.state === 'available') return renderLegacyV1Output(output);
  return '\n## Application Output Evidence (APPOUTPUT)\n- Unavailable/removed: no usable final application-output snapshot is retained in this running app process. It was not audited.\n';
}
