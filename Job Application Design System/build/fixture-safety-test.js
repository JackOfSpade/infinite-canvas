/* ============================================================
   build/fixture-safety-test.js — authoring-fixture provenance gate
   ----------------------------------------------------------
   Handoff and upload examples are committed developer references, not
   private application archives. Keep one explicit synthetic identity
   across both HTML copies, and keep the application-sync shape without
   retaining a usable endpoint or bearer capability.

   Three layers, cheapest first:

   1. Contact + sync capability. Only the reserved synthetic email,
      telephone, and the visibly inert sync token may appear.
   2. Career facts, structurally. Every employer, school, role location,
      project, and the listing company in a fixture must be a member of
      the fictional PERSONA below. A real employer or project can only
      get in by someone editing the PERSONA list on purpose, so this
      layer needs no knowledge of any real person and runs everywhere
      (CI included).
   3. Career facts, against a real source (optional). When ORACLE_PATH
      names a real career-source file OUTSIDE this repo, its person,
      contact, school, employer, city, project, certification, and date
      facts are derived from that file at run time and every fixture is
      scanned for them. No real token is ever written into the repo,
      and a failure names only the KIND of fact that leaked, never its
      value.

        ORACLE_PATH="/path/to/real/career-source.md" npm test

   Without ORACLE_PATH, layer 3 is skipped with a visible notice.
   ============================================================ */

'use strict';

var fs = require('fs');
var path = require('path');
var H = require('./harness.js');
var header = H.header, assert = H.assert;
var DIM = H.DIM, RESET = H.RESET;

var ROOT = path.join(__dirname, '..');
var REPO_ROOT = path.join(ROOT, '..');
var FIXTURES = [
  'uploads/Application.html',
  'handoff/Application-paginated-example.html'
];
var SYNTHETIC = {
  name: 'Riley Okafor',
  email: 'riley.okafor@example.test',
  telephoneHref: 'tel:+12025550147',
  telephoneText: '(202) 555-0147',
  token: 'INERT_FIXTURE_TOKEN'
};

/* The fictional persona's career facts. Every name here is invented; the
   fixtures keep the STRUCTURE of a real application (a school-district
   role, a health role, a short logistics role, three projects) without
   any real employer, school, or project. */
var PERSONA = {
  school: 'Halden University',
  employers: [
    'Maple Ridge School District',
    'Cedar Valley Health Alliance',
    'Tandem (Corvane Freight International)'
  ],
  locations: [
    'Brookfield, Ohio',
    'Marlow Heights, New York',
    'Port Alder, Ontario'
  ],
  projects: ['SlateBoard', 'RouteDesk', 'PantryLog'],
  listingCompany: 'Tessera Harbor'
};

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function bundleData(html) {
  var match = /<script\b[^>]*id="ic-application-bundle-data"[^>]*>([\s\S]*?)<\/script>/i.exec(html);
  if (!match) return null;
  try { return JSON.parse(match[1]); } catch { return null; }
}

function decodeEntities(text) {
  return text
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0*39;/g, "'").replace(/&nbsp;/g, ' ');
}

function textOf(fragment) {
  return decodeEntities(fragment.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/* Text of every element matched by `re` (group 1 is the inner markup). */
function collect(html, re) {
  var out = [];
  var match;
  re.lastIndex = 0;
  while ((match = re.exec(html))) out.push(textOf(match[1]));
  return out;
}

function afterLastComma(text) {
  var i = text.lastIndexOf(',');
  return (i === -1 ? text : text.slice(i + 1)).trim();
}

function uniqueSorted(list) {
  return list.filter(function (item, i) { return list.indexOf(item) === i; }).sort();
}

function sameSet(actual, expected) {
  return JSON.stringify(uniqueSorted(actual)) === JSON.stringify(uniqueSorted(expected));
}

/* How many distinct names in `actual` are not in `allowed`. Only the COUNT is
   reported, so a failure never prints the offending (possibly real) name. */
function outside(actual, allowed) {
  return uniqueSorted(actual).filter(function (name) { return allowed.indexOf(name) === -1; }).length;
}

/* What a reader of the document sees: the markup with the runtime
   <script> and <style> bodies removed (that is application code, not
   document content) plus the embedded bundle payload, which is data. */
function documentText(html, payload) {
  var visible = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ');
  return textOf(visible) + ' ' + (payload ? JSON.stringify(payload) : '');
}

/* Lowercase, accent-free, letters and digits only: "Slate-Board" and
   "Slate Board" and "slate board" all squash to one string. */
function squash(text) {
  return text.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/* "May, 2023", "June 2026", "Oct 2022" -> "may 2023", "jun 2026", "oct 2022". */
function monthYears(text) {
  var found = [];
  var re = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?,?\s+(\d{4})\b/gi;
  var match;
  while ((match = re.exec(text))) found.push(match[1].toLowerCase() + ' ' + match[2]);
  return found;
}

/* Digits of every phone-looking run in the text. */
function phoneDigits(text) {
  var runs = text.match(/\+?\d[\d\s().-]{8,}\d/g) || [];
  return runs.map(function (run) { return run.replace(/\D/g, ''); });
}

/* Derive career-fact tokens from a real career-source Markdown file.
   Recognises the layout the app's career-source files use (bold
   Name/Email/Phone fields; "## Education" with a "### Degree, School"
   heading and an italic "City · Graduated YYYY" line; "## ... Jobs" with a
   bold "Employer — City, Region" line and an italic date line; a
   "## Personal Projects" list of "Name - description" lines; a
   "## Certification" bullet list). Regions (the part after a comma) are
   deliberately NOT tokens: a fictional persona may legitimately sit in the
   same state or province. Returns [{ kind, value }]. */
function oracleTokens(markdown) {
  var tokens = [];
  var section = '';
  function add(kind, value) {
    value = (value || '').trim();
    if (value) tokens.push({ kind: kind, value: value });
  }
  markdown.split(/\r?\n/).forEach(function (raw) {
    var line = raw.trim();
    if (!line || /^-{3,}$/.test(line)) return;
    var sectionHead = /^##\s+(?!#)(.*)$/.exec(line);
    if (sectionHead) { section = sectionHead[1].toLowerCase(); return; }

    var field = /^\*\*(Name|Email|Phone):\*\*\s*(.+)$/i.exec(line);
    if (field) {
      var key = field[1].toLowerCase();
      add(key === 'name' ? 'person' : key === 'email' ? 'email' : 'phone', field[2]);
      return;
    }
    if (/education/.test(section)) {
      var degree = /^###\s+(.*)$/.exec(line);
      if (degree) { add('school', afterLastComma(degree[1])); return; }
      var graduated = /^\*([^*·]+?)\s*·.*\*$/.exec(line);
      if (graduated) { add('place', graduated[1]); return; }
    }
    if (/certification/.test(section)) {
      var cert = /^[-*]\s+(.*)$/.exec(line);
      if (cert) { add('certification', cert[1]); return; }
    }
    if (/past jobs|work|experience/.test(section)) {
      var employer = /^\*\*(.+?)\s+[—–-]\s+(.+?)\*\*$/.exec(line);
      if (employer) {
        var withParens = /^(.*?)\s*\(([^)]*)\)\s*$/.exec(employer[1]);
        if (withParens) { add('employer', withParens[1]); add('employer', withParens[2]); }
        else add('employer', employer[1]);
        add('place', employer[2].split(',')[0]);
        return;
      }
      if (/^\*[^*]+\*$/.test(line)) {
        monthYears(line).forEach(function (date) { add('date', date); });
        return;
      }
    }
    if (/project/.test(section)) {
      var project = /^([^#*\-\s][\s\S]*?)\s+-\s+\S/.exec(line);
      if (project && project[1].length <= 60) { add('project', project[1]); return; }
    }
  });
  return tokens;
}

function summarize(hits) {
  var counts = {};
  hits.forEach(function (hit) { counts[hit.kind] = (counts[hit.kind] || 0) + 1; });
  return Object.keys(counts).sort().map(function (kind) {
    return kind + ' x' + counts[kind];
  }).join(', ');
}

/* Tokens of `tokens` that occur in the fixture's document text. */
function oracleHits(tokens, html, payload) {
  var text = documentText(html, payload);
  var squashed = squash(text);
  var dates = monthYears(text);
  var phones = phoneDigits(text);
  return tokens.filter(function (token) {
    if (token.kind === 'date') return dates.indexOf(token.value) !== -1;
    if (token.kind === 'phone') {
      var digits = token.value.replace(/\D/g, '').slice(-10);
      return digits.length === 10 && phones.some(function (run) { return run.indexOf(digits) !== -1; });
    }
    if (token.kind === 'email') {
      var local = squash(token.value.split('@')[0]);
      return (local.length >= 6 && squashed.indexOf(local) !== -1)
        || text.toLowerCase().indexOf(token.value.toLowerCase()) !== -1;
    }
    var needle = squash(token.value);
    return needle.length >= 5 && squashed.indexOf(needle) !== -1;
  });
}

header(DIM + 'fixture safety' + RESET);

FIXTURES.forEach(function (rel) {
  var html = read(rel);
  var payload = bundleData(html);
  var emails = html.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
  var telHrefs = html.match(/tel:[^"'\s<]+/gi) || [];

  assert(emails.length > 0 && emails.every(function (email) {
    return email.toLowerCase() === SYNTHETIC.email;
  }), rel + ' contains only the reserved synthetic email', emails.join(', '));
  assert(telHrefs.length > 0 && telHrefs.every(function (href) {
    return href === SYNTHETIC.telephoneHref;
  }), rel + ' contains only the synthetic telephone link', telHrefs.join(', '));
  assert(html.indexOf(SYNTHETIC.telephoneText) !== -1,
    rel + ' renders the synthetic telephone number');
  assert((html.match(new RegExp(SYNTHETIC.name, 'g')) || []).length >= 3,
    rel + ' uses the synthetic identity in résumé, letter, and metadata');
  assert(!!payload, rel + ' carries parseable application bundle metadata');
  if (payload) {
    assert(payload.candidateName === SYNTHETIC.name,
      rel + ' metadata names the synthetic candidate');
    assert(payload.sync && payload.sync.endpoint === '',
      rel + ' application-sync endpoint is deliberately disabled');
    assert(payload.sync && payload.sync.token === SYNTHETIC.token,
      rel + ' keeps only the visibly inert fixture token');
  }
  assert(!/"token"\s*:\s*"[a-f0-9]{32,}"/i.test(html),
    rel + ' contains no production-looking hex bearer token');
});

header(DIM + 'fixture career facts belong to the fictional persona' + RESET);

FIXTURES.forEach(function (rel) {
  var html = read(rel);
  var payload = bundleData(html);
  var employers = collect(html, /<span class="company">([\s\S]*?)<\/span>/g);
  var locations = collect(html, /<p class="role-location">([\s\S]*?)<\/p>/g);
  var projects = collect(html, /<span class="project-name">([\s\S]*?)<\/span>/g);
  var credentials = collect(html, /<span class="credential">([\s\S]*?)<\/span>/g)
    .concat(collect(html, /<p class="tagline" itemprop="jobTitle">([\s\S]*?)<\/p>/g));
  var salutations = collect(html, /<p class="salutation">([\s\S]*?)<\/p>/g);

  assert(employers.length > 0 && sameSet(employers, PERSONA.employers),
    rel + ' names exactly the fictional persona\'s employers',
    outside(employers, PERSONA.employers) + ' employer(s) outside the persona');
  assert(locations.length > 0 && sameSet(locations, PERSONA.locations),
    rel + ' places roles exactly in the fictional persona\'s locations',
    outside(locations, PERSONA.locations) + ' location(s) outside the persona');
  assert(projects.length > 0 && sameSet(projects, PERSONA.projects),
    rel + ' lists exactly the fictional persona\'s projects',
    outside(projects, PERSONA.projects) + ' project(s) outside the persona');
  assert(credentials.length > 0 && credentials.every(function (credential) {
    return afterLastComma(credential) === PERSONA.school;
  }), rel + ' names only the fictional persona\'s school',
  outside(credentials.map(afterLastComma), [PERSONA.school]) + ' school(s) outside the persona');
  assert(!!payload && payload.company === PERSONA.listingCompany,
    rel + ' addresses the fictional listing company in its bundle metadata');
  assert(salutations.length > 0 && salutations.every(function (salutation) {
    return salutation === 'Dear ' + PERSONA.listingCompany + ' Hiring Team,';
  }), rel + ' opens the letter to the fictional listing company');
  if (payload && typeof payload.jobMarkdown === 'string') {
    var hosts = (payload.jobMarkdown.match(/https?:\/\/[^\s/>)]+/gi) || [])
      .map(function (url) { return url.replace(/^https?:\/\//i, '').toLowerCase(); });
    assert(hosts.every(function (host) { return /\.(test|example|invalid)$/.test(host); }),
      rel + ' embeds only reserved-TLD listing URLs, never a real job board',
      hosts.filter(function (host) { return !/\.(test|example|invalid)$/.test(host); }).length
        + ' URL(s) on a real domain');
  }
});

header(DIM + 'fixture career facts against a real source (ORACLE_PATH)' + RESET);

var ORACLE_PATH = process.env.ORACLE_PATH;
if (!ORACLE_PATH) {
  console.log(DIM + '  - skipped: set ORACLE_PATH to a real career-source file outside this repo'
    + ' to also scan the fixtures for its employers, schools, projects, and dates' + RESET);
} else {
  var oracleSource = null;
  try { oracleSource = fs.readFileSync(ORACLE_PATH, 'utf8'); } catch { oracleSource = null; }
  assert(oracleSource !== null, 'ORACLE_PATH is readable');
  assert(oracleSource === null || path.relative(REPO_ROOT, path.resolve(ORACLE_PATH)).startsWith('..'),
    'ORACLE_PATH points outside this repository, so no real token is stored in it');
  if (oracleSource !== null) {
    var tokens = oracleTokens(oracleSource);
    var kinds = uniqueSorted(tokens.map(function (token) { return token.kind; }));
    assert(['person', 'school', 'employer', 'project'].every(function (kind) {
      return kinds.indexOf(kind) !== -1;
    }), 'ORACLE_PATH yields person, school, employer, and project tokens', 'kinds: ' + kinds.join(', '));
    console.log(DIM + '  scanning for ' + tokens.length + ' derived career-fact tokens (' + summarize(tokens) + ')' + RESET);
    FIXTURES.forEach(function (rel) {
      var html = read(rel);
      var hits = oracleHits(tokens, html, bundleData(html));
      assert(hits.length === 0, rel + ' contains no career fact from ORACLE_PATH',
        hits.length + ' leaked: ' + summarize(hits));
    });
  }
}

assert(!fs.existsSync(path.join(ROOT, 'uploads', 'Resume.pdf')),
  'uploads/ contains no private candidate résumé PDF');

H.report();
