import path from 'node:path';

const SHORTLIST_HEADING = /^\s{0,3}#{0,6}\s*EVIDENCE SHORTLIST \(WORKING NOTES\)\s*:?[ \t]*$/iu;
const RESUME_HEADING = /^\s{0,3}#{0,6}\s*(?:RÉSUMÉ|RESUME)\s*:?[ \t]*$/iu;
const LETTER_HEADING = /^\s{0,3}#{0,6}\s*(?:COVER LETTER|LETTER)\s*:?[ \t]*$/iu;
const CATALOG_ID = /host\.career\.[a-z]+\.[a-z0-9-]+\.[0-9]+/gu;
const LIST_MARKER = /^\s*(?:[-*+\u2022\u00b7\u2013\u2014]|\d+[.)]|\(\d+\))\s+/u;
const SHORT_TOKEN = /^\[?([a-z0-9][a-z0-9-]*)\]?(?=$|[\s:)\]\u2013\u2014,;.])/iu;
const ALLOWED_ID = /^host\.career\.([a-z]+)\.([a-z0-9-]+)\.([0-9]+)$/u;
const REASON_PREFIX = /^[\])\s:\u2014\u2013-]+/u;

const LINE_FORM = '"- <catalog ID> - <reason>"';
const FULL_ID_FORM = 'host.career.<kind>.<entity>.<n>';
const ID_MESSAGE = `Every working shortlist item needs one approved catalog ID in the form ${FULL_ID_FORM}, copied byte-for-byte from the FULL APPROVED CATALOG, followed by a one-line reason, one per line as ${LINE_FORM}.`;
const FORM_SUFFIX = `The shortlist lines must read ${LINE_FORM} with the full ID ${FULL_ID_FORM}.`;

function shortIdIndex(allowedIds) {
  const byEntity = new Map();
  for (const id of allowedIds) {
    const match = ALLOWED_ID.exec(String(id));
    if (!match) continue;
    const [, kind, entity, n] = match;
    const rows = byEntity.get(entity) || [];
    rows.push({ id, kind, n: Number(n) });
    byEntity.set(entity, rows);
  }
  return byEntity;
}

function resolveShortId(token, byEntity) {
  const rows = byEntity.get(token);
  if (!rows || !rows.length) return null;
  if (new Set(rows.map(row => row.kind)).size !== 1) return null;
  return rows.reduce((low, row) => (row.n < low.n ? row : low)).id;
}

function shortToken(line) {
  const body = line.replace(LIST_MARKER, '');
  const match = SHORT_TOKEN.exec(body.trimStart());
  if (!match) return null;
  const rest = body.trimStart().slice(match[0].length);
  return { token: match[1], rest };
}

export function splitWriteVerifyWriterResponse(response, allowedIds) {
  if (typeof response !== 'string' || !response.trim() || response.trim().startsWith('{')) {
    throw new Error('Writer must return a plain-text résumé and cover letter with no JSON.');
  }
  const lines = response.split(/\r?\n/u);
  const heading = lines.findIndex(line => SHORTLIST_HEADING.test(line));
  const resume = lines.findIndex((line, index) => index > heading && RESUME_HEADING.test(line));
  if (heading < 0 || lines.slice(0, heading).some(line => line.trim()) || resume <= heading + 1) {
    throw new Error(`Writer must begin with EVIDENCE SHORTLIST (WORKING NOTES), then a RÉSUMÉ heading. ${FORM_SUFFIX}`);
  }
  const allowedList = Array.isArray(allowedIds) ? allowedIds : [...(allowedIds || [])];
  const allowed = new Set(allowedList);
  const byEntity = shortIdIndex(allowedList);
  const workingLines = lines.slice(heading + 1, resume).filter(line => line.trim());
  const items = workingLines.filter(line => {
    if (LIST_MARKER.test(line)) return true;
    if ([...line.matchAll(CATALOG_ID)].length) return true;
    const short = shortToken(line);
    return Boolean(short && resolveShortId(short.token, byEntity));
  });
  if (items.length < 6 || items.length > 10) {
    throw new Error(`Writer working shortlist must list 6–10 items, one per line as ${LINE_FORM} with the full ID (${FULL_ID_FORM}) copied from the FULL APPROVED CATALOG; ${items.length} item lines were found.`);
  }
  const ids = [];
  for (const line of items) {
    const matches = [...line.matchAll(CATALOG_ID)];
    let id;
    let rest;
    if (matches.length > 1) throw new Error(ID_MESSAGE);
    if (matches.length === 1) {
      id = matches[0][0];
      if (!allowed.has(id)) throw new Error(ID_MESSAGE);
      rest = line.slice(matches[0].index + id.length);
    } else {
      const short = shortToken(line);
      id = short ? resolveShortId(short.token, byEntity) : null;
      if (!id) throw new Error(ID_MESSAGE);
      rest = short.rest;
    }
    if (!rest.replace(REASON_PREFIX, '').trim()) throw new Error(ID_MESSAGE);
    ids.push(id);
  }
  if (new Set(ids).size !== ids.length) {
    throw new Error(`Writer working shortlist IDs must be distinct: use each catalog ID once, one per line as ${LINE_FORM} with the full ID ${FULL_ID_FORM}.`);
  }
  const letter = lines.findIndex((line, index) => index > resume && LETTER_HEADING.test(line));
  if (letter < 0 || !lines.slice(resume + 1, letter).some(line => line.trim())
    || !lines.slice(letter + 1).some(line => line.trim())) {
    throw new Error(`Writer must return nonempty résumé and cover letter sections with a COVER LETTER heading. ${FORM_SUFFIX}`);
  }
  const plainText = lines.slice(resume).join('\n').trim();
  if (/EVIDENCE SHORTLIST\s*\(WORKING NOTES\)/iu.test(plainText)) {
    throw new Error(`Working shortlist must stay before the résumé, outside application text. ${FORM_SUFFIX}`);
  }
  if (plainText.match(CATALOG_ID)) {
    throw new Error(`Résumé and letter text must not contain catalog evidence IDs; keep ${FULL_ID_FORM} IDs only in shortlist lines of the form ${LINE_FORM}.`);
  }
  return { shortlist: workingLines.join('\n'), plainText, ids };
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
