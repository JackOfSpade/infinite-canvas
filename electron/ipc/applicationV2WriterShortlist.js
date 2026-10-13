import path from 'node:path';

const SHORTLIST_HEADING = /^\s{0,3}#{0,6}\s*EVIDENCE SHORTLIST \(WORKING NOTES\)\s*:?[ \t]*$/iu;
const RESUME_HEADING = /^\s{0,3}#{0,6}\s*(?:RÉSUMÉ|RESUME)\s*:?[ \t]*$/iu;
const LETTER_HEADING = /^\s{0,3}#{0,6}\s*(?:COVER LETTER|LETTER)\s*:?[ \t]*$/iu;
const CATALOG_ID = /host\.career\.[a-z]+\.[a-z0-9-]+\.[0-9]+/gu;

export function splitWriteVerifyWriterResponse(response, allowedIds) {
  if (typeof response !== 'string' || !response.trim() || response.trim().startsWith('{')) {
    throw new Error('Writer must return a plain-text résumé and cover letter with no JSON.');
  }
  const lines = response.split(/\r?\n/u);
  const heading = lines.findIndex(line => SHORTLIST_HEADING.test(line));
  const resume = lines.findIndex((line, index) => index > heading && RESUME_HEADING.test(line));
  if (heading < 0 || lines.slice(0, heading).some(line => line.trim()) || resume <= heading + 1) {
    throw new Error('Writer must begin with EVIDENCE SHORTLIST (WORKING NOTES), then a RÉSUMÉ heading.');
  }
  const workingLines = lines.slice(heading + 1, resume).filter(line => line.trim());
  const shortlist = workingLines.filter(line => /^\s*(?:[-*]\s+|\d+[.)]\s+)/u.test(line));
  if (shortlist.length < 6 || shortlist.length > 10) {
    throw new Error('Writer working shortlist must contain 6–10 evidence items with IDs and reasons.');
  }
  const allowed = new Set(allowedIds);
  const ids = [];
  for (const line of shortlist) {
    const matches = [...line.matchAll(CATALOG_ID)].map(match => match[0]);
    if (matches.length !== 1 || !allowed.has(matches[0])
      || !line.slice(line.indexOf(matches[0]) + matches[0].length).replace(/^[\]\s:—–-]+/u, '').trim()) {
      throw new Error('Every working shortlist item needs one approved catalog ID and a one-line reason.');
    }
    ids.push(matches[0]);
  }
  if (new Set(ids).size !== ids.length) throw new Error('Writer working shortlist IDs must be distinct.');
  const letter = lines.findIndex((line, index) => index > resume && LETTER_HEADING.test(line));
  if (letter < 0 || !lines.slice(resume + 1, letter).some(line => line.trim())
    || !lines.slice(letter + 1).some(line => line.trim())) {
    throw new Error('Writer must return nonempty résumé and cover letter sections with a COVER LETTER heading.');
  }
  const plainText = lines.slice(resume).join('\n').trim();
  if (/EVIDENCE SHORTLIST\s*\(WORKING NOTES\)/iu.test(plainText)) {
    throw new Error('Working shortlist must stay before the résumé, outside application text.');
  }
  if (plainText.match(CATALOG_ID)) throw new Error('Résumé and letter text must not contain catalog evidence IDs.');
  return { shortlist: workingLines.join('\n'), plainText };
}

export function v2WriterShortlistEvidencePaths(jobDir, jobId, filename) {
  if (path.basename(jobDir) !== jobId || path.basename(path.dirname(jobDir)) !== 'jobs'
    || path.basename(path.dirname(path.dirname(jobDir))) !== '.local-ai'
    || !/^revision-[0-9]+-write-[a-f0-9]{64}\.json$/u.test(filename)) {
    throw new Error('Invalid v2 writer shortlist evidence path.');
  }
  return {
    working: path.join(jobDir, 'writer-shortlists', filename),
    retained: path.join(path.dirname(path.dirname(jobDir)), 'writer-shortlists', jobId, filename),
  };
}
