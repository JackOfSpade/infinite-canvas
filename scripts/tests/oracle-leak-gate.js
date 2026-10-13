// The acceptance leak gate (scripts/check-oracle-leak.mjs) against synthetic
// oracles only.  No real career data is used or needed: each domain below is an
// invented career file, and every scanned tree is a temporary fixture.
//
// The gate must report a leak however WIDE it is (a name copied into many files
// is the worst leak, not shared vocabulary), whatever its letter case, and a
// career sentence copied verbatim even when it is all lower case and the name
// beside it was changed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assert } from './testHelpers.js';
import {
  DEFAULT_NGRAM_WORDS, backgroundVocabulary, oracleNgrams, oracleTokens, scanForLeaks,
} from '../check-oracle-leak.mjs';

const GATE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'check-oracle-leak.mjs');

// Three invented careers.  `sentence` is one oracle line written in lower case
// in the oracle itself, so its first word is never a name candidate: only the
// n-gram check can find it.
const DOMAINS = Object.freeze([
  {
    domain: 'clinic', name: 'Marrowfield', run: 'Marrowfield Health Partners', email: 'dana.reyes@example.test',
    sentence: 'rebuilt the specimen courier handoff log for eleven satellite clinics after two lost samples',
    ordinary: 'Ledger',
  },
  {
    domain: 'logistics', name: 'Quarrytide', run: 'Quarrytide Freight Lines', email: 'omar.lindqvist@example.test',
    sentence: 'merged partial pallets from nine cross dock terminals into full overnight loads every weekday',
    ordinary: 'Manifests',
  },
  {
    domain: 'school', name: 'Brindlemoor', run: 'Brindlemoor Unified Schools', email: 'ines.okafor@example.test',
    sentence: 'enrolled three thousand classroom laptops in device management before the autumn term began',
    ordinary: 'Carts',
  },
]);

function oracleOf(spec) {
  return [
    `## ${spec.run}`,
    'Operations Lead, 2015 - 2021',
    `- ${spec.sentence}.`,
    `- ${spec.ordinary} were tracked in a shared sheet.`,
    `- Contact: ${spec.email}`,
    '',
  ].join('\n');
}
// An oracle-free vocabulary: ordinary lower-case words, plus a capitalised
// entry that a word list would hold as a proper noun (never an ordinary word).
const BACKGROUND = backgroundVocabulary(['operations', 'lead', 'contact', 'health', 'partners', 'freight', 'lines', 'unified', 'schools',
  'ledger', 'manifests', 'carts', 'were', 'tracked', 'shared', 'sheet', 'Marrowfield', 'Quarrytide', 'Brindlemoor'].join('\n'));

function fixtureTree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-leak-gate-'));
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, 'utf8');
  }
  return root;
}
function withTree(files, body) {
  const root = fixtureTree(files);
  try { return body(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
const TREES = ['electron', 'scripts'];
const scan = (spec, root, options = {}) => scanForLeaks(oracleOf(spec), { root, trees: TREES, background: BACKGROUND, ...options });
const filesFor = (findings, token) => findings.filter(finding => finding.token === token).map(finding => finding.file).sort();
const filler = index => `// generic helper ${index}\nexport const value${index} = ${index};\n`;

export default [
  {
    name: 'oracle leak gate: a one-word name is reported in every file it leaked into, however many (1, 2, 3 and 6 files; 3 careers)',
    run: () => {
      for (const spec of DOMAINS) {
        for (const width of [1, 2, 3, 6]) {
          const files = { 'electron/clean.js': filler(0) };
          for (let index = 0; index < width; index += 1) files[`${index % 2 ? 'scripts' : 'electron'}/leak-${index}.js`] = `${filler(index)}const employer = '${spec.name}';\n`;
          withTree(files, root => {
            const found = filesFor(scan(spec, root), spec.name);
            assert(found.length === width, `${spec.domain}: "${spec.name}" in ${width} file(s) is reported in all of them (got ${found.length}: ${found.join(', ')})`);
            assert(!found.includes('electron/clean.js'), `${spec.domain}: a file without the name is not reported`);
          });
        }
      }
    },
  },
  {
    name: 'oracle leak gate: names match case-insensitively and as whole words, across a line wrap for a multi-word name (A / B / C)',
    run: () => {
      for (const spec of DOMAINS) {
        const [first, ...rest] = spec.run.split(' ');
        withTree({
          'electron/upper.js': `const a = '${spec.name.toUpperCase()}';\n`,
          'electron/lower.js': `const b = '${spec.name.toLowerCase()}';\n`,
          'scripts/wrapped.md': `Worked at ${first}\n${rest.join(' ')} for six years.\n`,
          'scripts/longer-word.js': `const c = '${spec.name}ish ${spec.name.toLowerCase()}ville';\n`,
          'scripts/mail.txt': `Reach ${spec.email.toUpperCase()} today.\n`,
        }, root => {
          const findings = scan(spec, root);
          // A: every case of the name is the name.
          assert(filesFor(findings, spec.name).join() === 'electron/lower.js,electron/upper.js,scripts/wrapped.md', `${spec.domain}/A: upper and lower case are both reported (${filesFor(findings, spec.name)})`);
          // B: a longer word that merely starts with the name is not the name.
          assert(!findings.some(finding => finding.file === 'scripts/longer-word.js'), `${spec.domain}/B: "${spec.name}ish" is not "${spec.name}"`);
          // C: a multi-word name split over two lines, and a contact address in another case, are still found.
          assert(filesFor(findings, spec.run).join() === 'scripts/wrapped.md' && findings.find(finding => finding.token === spec.run).lines[0] === 1,
            `${spec.domain}/C: the wrapped multi-word name is found at its first line`);
          assert(filesFor(findings, spec.email).join() === 'scripts/mail.txt', `${spec.domain}/C: the contact address is found whatever its case`);
        });
      }
    },
  },
  {
    name: 'oracle leak gate: a career sentence copied verbatim is found in lower case, re-punctuated, wrapped, and beside a changed name; one word fewer than the window is not (A / B / C)',
    run: () => {
      for (const spec of DOMAINS) {
        const words = spec.sentence.split(' ');
        assert(!oracleTokens(oracleOf(spec), { background: BACKGROUND }).some(token => token.toLowerCase().startsWith(words[0])), `${spec.domain}: the sentence's own words are not name candidates`);
        assert(oracleNgrams(oracleOf(spec)).has(words.slice(0, DEFAULT_NGRAM_WORDS).join(' ')), `${spec.domain}: the sentence yields n-grams`);
        const half = Math.floor(words.length / 2);
        const window = words.slice(2, 2 + DEFAULT_NGRAM_WORDS);
        withTree({
          'scripts/fixture-a.js': `const bullet = 'At Some Other Employer I ${spec.sentence}.';\n`,
          'scripts/fixture-b.js': `const bullet = "${words.slice(0, half).join(' ').toUpperCase()},\n  ${words.slice(half).join(' — ')}";\n`,
          'electron/exact-window.js': `// ${window.join(' ')}\n`,
          'electron/short-window.js': `// ${window.slice(0, -1).join(' ')} and then something else entirely\n`,
          'electron/scrambled.js': `// ${[...words].reverse().join(' ')}\n`,
        }, root => {
          const ngrams = scan(spec, root).filter(finding => finding.kind === 'ngram').map(finding => finding.file).sort();
          // A: verbatim (beside a changed employer), upper-cased, re-punctuated and wrapped copies are found.
          assert(ngrams.includes('scripts/fixture-a.js') && ngrams.includes('scripts/fixture-b.js'), `${spec.domain}/A: verbatim copies are found (${ngrams})`);
          // B: exactly one window of consecutive words is enough; one word fewer is not.
          assert(ngrams.includes('electron/exact-window.js') && !ngrams.includes('electron/short-window.js'), `${spec.domain}/B: the window size decides (${ngrams})`);
          // C: the same words in another order are not a copied sentence.
          assert(!ngrams.includes('electron/scrambled.js'), `${spec.domain}/C: the words of the sentence in another order are not reported`);
        });
        // Mutation: removing the copied sentence from the fixture removes the finding, and putting it back restores it.
        const files = { 'scripts/fixture.js': `const bullet = '${spec.sentence}';\n` };
        withTree(files, root => {
          const file = path.join(root, 'scripts/fixture.js');
          assert(scan(spec, root).some(finding => finding.kind === 'ngram'), `${spec.domain}: the copy is reported`);
          fs.writeFileSync(file, `const bullet = '${words.slice(0, DEFAULT_NGRAM_WORDS - 1).join(' ')}';\n`, 'utf8');
          assert(!scan(spec, root).some(finding => finding.kind === 'ngram'), `${spec.domain}: the edited fixture is clean`);
          fs.writeFileSync(file, files['scripts/fixture.js'], 'utf8');
          assert(scan(spec, root).some(finding => finding.kind === 'ngram'), `${spec.domain}: restoring the copy restores the finding`);
        });
      }
    },
  },
  {
    name: 'oracle leak gate: only an explicit allowlist or an ordinary lower-case background word silences a name; a capitalised word-list entry, and a name made of ordinary words, never do',
    run: () => {
      for (const spec of DOMAINS) {
        withTree({
          'electron/a.js': `const a = '${spec.name}'; const b = '${spec.ordinary}';\n`,
          'electron/b.js': `const run = '${spec.run}';\n`,
          'scripts/c.js': `const copy = '${spec.sentence}';\n`,
        }, root => {
          const plain = scan(spec, root);
          assert(filesFor(plain, spec.name).length === 2, `${spec.domain}: the name is reported in both files`);
          // "Partners", "Lines" and "Schools" are ordinary words, but the run that holds the name is still a name.
          assert(filesFor(plain, spec.run).join() === 'electron/b.js', `${spec.domain}: the multi-word name is reported`);
          // An ordinary lower-case word of the background is not a name; without a background it is a candidate.
          assert(filesFor(plain, spec.ordinary).length === 0, `${spec.domain}: "${spec.ordinary}" is an ordinary word of the background`);
          assert(filesFor(scan(spec, root, { background: null }), spec.ordinary).length === 1, `${spec.domain}: without a background "${spec.ordinary}" is a candidate`);
          // The person running the gate allowlists explicitly; an allowlisted phrase also covers the sentence n-grams it contains.
          const ignored = scan(spec, root, { ignore: [spec.name.toLowerCase(), spec.run.toUpperCase(), `x ${spec.sentence} y`] });
          assert(filesFor(ignored, spec.name).length === 0 && filesFor(ignored, spec.run).length === 0 && !ignored.some(finding => finding.kind === 'ngram'),
            `${spec.domain}: allowlisted tokens and phrases are not reported (${JSON.stringify(ignored)})`);
          assert(scan(spec, root, { ignore: ['something else'] }).length === plain.length, `${spec.domain}: an unrelated allowlist entry silences nothing`);
        });
      }
    },
  },
  {
    name: 'oracle leak gate: a clean tree, skipped output directories and skipped file types report nothing',
    run: () => {
      for (const spec of DOMAINS) {
        withTree({
          'electron/clean.js': filler(1),
          'scripts/clean.md': 'A generic note about operations and shared sheets.\n',
          'electron/node_modules/pkg/index.js': `const a = '${spec.name}';\n`,
          'scripts/image.bin': `${spec.name}\n`,
          'other/not-scanned.js': `const a = '${spec.name}';\n`,
        }, root => {
          const findings = scan(spec, root);
          assert(findings.length === 0, `${spec.domain}: nothing is reported (${JSON.stringify(findings)})`);
        });
      }
    },
  },
  {
    name: 'oracle leak gate: the command blocks copied sentences, reports names as noise, and refuses an invalid oracle',
    run: () => {
      const spec = DOMAINS[1];
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-leak-oracle-'));
      try {
        const oraclePath = path.join(outside, 'career.md');
        const backgroundPath = path.join(outside, 'words.txt');
        fs.writeFileSync(oraclePath, oracleOf(spec), 'utf8');
        fs.writeFileSync(backgroundPath, [...BACKGROUND].join('\n'), 'utf8');
        const runGate = (root, env = {}) => spawnSync(process.execPath, [GATE], {
          encoding: 'utf8', env: { PATH: process.env.PATH, CAREER_ORACLE_PATH: oraclePath, CAREER_ORACLE_SCAN_ROOT: root, CAREER_ORACLE_BACKGROUND: backgroundPath, ...env },
        });
        withTree({ 'electron/a.js': `const a = '${spec.name}';\n`, 'scripts/b.js': `const b = '${spec.sentence}';\n` }, root => {
          const leaked = runGate(root);
          assert(leaked.status === 1 && leaked.stderr.includes('ngram /') && leaked.stderr.includes('name (noise)') && leaked.stderr.includes('scripts/b.js'),
            `a copied sentence fails the gate and reports both finding classes (${leaked.status}: ${leaked.stderr}${leaked.stdout})`);
          assert(!leaked.stderr.includes('electron/a.js'), 'name noise does not flood the blocking diagnostics');
          const allowed = runGate(root, { CAREER_ORACLE_IGNORE: `${spec.name},${spec.sentence}` });
          assert(allowed.status === 0, `an explicit allowlist passes it (${allowed.status}: ${allowed.stderr})`);
          const inTree = path.join(root, 'career.md');
          fs.writeFileSync(inTree, oracleOf(spec), 'utf8');
          assert(runGate(root, { CAREER_ORACLE_PATH: inTree }).status === 2, 'an oracle inside the scanned tree is refused');
        });
        withTree({ 'electron/clean.js': filler(2) }, root => {
          const clean = runGate(root);
          assert(clean.status === 0 && clean.stdout.includes('0 ngram / 0 name (noise)'), `a clean tree passes (${clean.status}: ${clean.stderr})`);
          assert(runGate(root, { CAREER_ORACLE_PATH: '' }).status === 2, 'a missing oracle path is a usage error');
          assert(runGate(root, { CAREER_ORACLE_NGRAM: '2' }).status === 2, 'a window shorter than three words is a usage error');
        });
        withTree({ 'electron/name-only.js': `const employer = '${spec.name}';\n` }, root => {
          const namesOnly = runGate(root);
          assert(namesOnly.status === 0 && namesOnly.stdout.includes('0 ngram / 1 name (noise)'),
            `a name-only finding is reported but does not block (${namesOnly.status}: ${namesOnly.stderr}${namesOnly.stdout})`);
        });
      } finally { fs.rmSync(outside, { recursive: true, force: true }); }
    },
  },
];
