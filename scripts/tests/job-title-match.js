import { assert, formatRemoteOkSalary, linkedInPageStopReason, remoteOkTagsFromQueries, wwrCategoriesFromQueries } from '../test-dependencies.js';
import {
  tokenizeTargetRole,
  titleMatchesTargetRole,
  titleMatchesTargetRoleTokens,
  filterJobsByTargetRole,
  detectQueryOperators,
} from '../../src/utils/jobTitleMatch.js';

export default [
  {
    name: 'Target-role gate keeps every title containing all typed words in any order or position',
    run: () => {
      const role = 'System Architect';
      const keeps = [
        'System Architect',
        'System Architect II',
        'System and Computer Architect',
        'grocery system Architect',
        'SYSTEM ARCHITECT',
        'Architect, System',                      // reversed order
        'Hybrid Cloud System Architect Senior',
        'System Engineer/Architect (OT/ICS)',     // punctuation is a separator, not part of a word
      ];
      for (const title of keeps) {
        assert(titleMatchesTargetRole(title, role), `"${title}" contains both typed words and must be kept`);
      }
      return { kept: keeps.length };
    },
  },
  {
    name: 'Target-role gate drops titles missing any typed word, including near-miss roles',
    run: () => {
      const role = 'System Architect';
      const drops = [
        'Construction Architect',        // no system*
        'System Engineer',               // no architect*
        'Solution Architect',            // the exact fuzzy match observed on Dice
        'Software Architect',
        'Salesforce Field Service Architect',
        '',                              // no title = no evidence of a match
      ];
      for (const title of drops) {
        assert(!titleMatchesTargetRole(title, role), `"${title}" is missing a typed word and must be dropped`);
      }
      return { dropped: drops.length };
    },
  },
  {
    name: 'Target-role gate absorbs inflection by prefix, one direction only',
    run: () => {
      // Prefix matching exists so the canonical plural title is not lost: on live
      // Dice data 18 of the first 100 on-target titles used "Systems".
      assert(titleMatchesTargetRole('Systems Architect', 'System Architect'), 'system → systems must match');
      assert(titleMatchesTargetRole('Enterprise Systems Architect', 'System Architect'), 'plural with leading words must match');
      assert(titleMatchesTargetRole('Software Systems Architecture', 'System Architect'), 'architect → architecture must match');
      assert(titleMatchesTargetRole('Systems Architects', 'System Architect'), 'both words may inflect at once');

      // The reverse is deliberately NOT true — inflection only lengthens a word,
      // so matching both ways would admit unrelated shorter words.
      assert(!titleMatchesTargetRole('System Architect', 'Systems Architect'), 'typing the plural must not match the singular');
      return { directional: true };
    },
  },
  {
    name: 'Target-role gate requires whole-word equality for words under three characters',
    run: () => {
      // "C++ Developer" tokenizes to ["c", "developer"]; a prefix rule would let
      // "c" match Cloud/Customer/Consulting and quietly restore fuzzy matching.
      assert(titleMatchesTargetRole('Senior C++ Developer', 'C++ Developer'), 'the real C++ role still matches');
      assert(!titleMatchesTargetRole('Cloud Developer', 'C++ Developer'), 'a short token must not prefix-match a longer word');
      assert(!titleMatchesTargetRole('Customer Success Developer', 'C++ Developer'), 'short-token guard holds across candidates');

      assert(titleMatchesTargetRole('IT Support Specialist', 'IT Support'), 'a real two-letter word matches whole');
      assert(!titleMatchesTargetRole('Italian Support Specialist', 'IT Support'), '"IT" must not prefix-match "Italian"');
      return { guarded: true };
    },
  },
  {
    name: 'Target-role tokenizer normalizes case, punctuation, accents and duplicates',
    run: () => {
      assert(JSON.stringify(tokenizeTargetRole('  System   Architect  ')) === JSON.stringify(['system', 'architect']), 'whitespace collapses');
      assert(JSON.stringify(tokenizeTargetRole('Systems, Systems Engineer')) === JSON.stringify(['systems', 'engineer']), 'duplicate words collapse to one requirement');
      assert(JSON.stringify(tokenizeTargetRole('Señior Ingeniero')) === JSON.stringify(['senior', 'ingeniero']), 'accents fold so they compare against folded titles');
      assert(titleMatchesTargetRole('Señior Ingeniero de Datos', 'Senior Ingeniero'), 'accented titles match unaccented input and vice versa');
      return { normalized: true };
    },
  },
  {
    name: 'Target-role gate is a no-op when no role is pinned',
    run: () => {
      // An exploratory (LLM-generated query) run must never be narrowed by this
      // rule — the gate only exists for an explicitly pinned role.
      for (const blank of ['', '   ', null, undefined]) {
        assert(tokenizeTargetRole(blank).length === 0, 'a blank role yields no tokens');
        assert(titleMatchesTargetRoleTokens('literally anything', tokenizeTargetRole(blank)), 'a blank role keeps every job');
      }
      const jobs = [{ title: 'Construction Architect' }, { title: 'Chef' }];
      const result = filterJobsByTargetRole(jobs, '');
      assert(result.jobs === jobs, 'a no-op run returns the input array untouched');
      assert(result.dropped === 0, 'a no-op run drops nothing');
      return { noop: true };
    },
  },
  {
    name: 'Target-role filter reports per-source drops and samples for the run report',
    run: () => {
      const jobs = [
        { title: 'System Architect II', source: 'dice' },
        { title: 'Solution Architect', source: 'dice' },
        { title: 'Systems Architect', source: 'linkedin' },
        { title: 'System Engineer', source: 'linkedin' },
        { title: 'Construction Architect', source: 'glassdoor' },
        { title: '', source: 'remoteok' },
      ];
      const result = filterJobsByTargetRole(jobs, 'System Architect');

      assert(result.jobs.length === 2, 'only the two all-words titles survive');
      assert(result.jobs.every(j => j.title === 'System Architect II' || j.title === 'Systems Architect'), 'survivors are the expected rows');
      assert(result.dropped === 4, 'drop count matches');
      assert(result.droppedBySource.dice === 1 && result.droppedBySource.linkedin === 1, 'per-source accounting is exact');
      assert(result.droppedBySource.glassdoor === 1 && result.droppedBySource.remoteok === 1, 'untitled rows are attributed, not absorbed');
      assert(result.samples.length === 4 && result.samples[0].title === 'Solution Architect', 'samples are verbatim titles for the report');
      assert(JSON.stringify(result.tokens) === JSON.stringify(['system', 'architect']), 'tokens are surfaced for the report line');
      return { kept: result.jobs.length, dropped: result.dropped };
    },
  },
  {
    name: 'Tech vocabulary: symbol-bearing language names stay distinct from each other',
    run: () => {
      // Stripping punctuation would collapse C++, C# and C into one token "c".
      assert(titleMatchesTargetRole('Senior C++ Developer', 'C++ Developer'), 'C++ matches C++');
      assert(!titleMatchesTargetRole('C# Developer', 'C++ Developer'), 'C++ must not match C#');
      assert(!titleMatchesTargetRole('C Developer', 'C++ Developer'), 'C++ must not match plain C');
      assert(!titleMatchesTargetRole('C++ Developer', 'C# Developer'), 'C# must not match C++');
      assert(titleMatchesTargetRole('C# Backend Developer', 'C# Developer'), 'C# matches C#');
      // "cpp" is the same language written without symbols.
      assert(titleMatchesTargetRole('C++ Engineer', 'CPP Engineer'), 'cpp is an alias for C++');
      return { distinct: true };
    },
  },
  {
    name: 'Tech vocabulary: .NET does not prefix-match Network',
    run: () => {
      // ".NET" naively becomes "net", and "net" prefix-matches "network" —
      // a .NET search would return networking roles.
      assert(!titleMatchesTargetRole('Network Developer', '.NET Developer'), '.NET must not match Network');
      assert(!titleMatchesTargetRole('Network Engineer', '.NET Engineer'), '.NET must not match Network Engineer');
      // NOT an identity check — titleMatchesTargetRole(X, X) is true by
      // construction, so it would pass with the whole vocabulary deleted.
      assert(JSON.stringify(tokenizeTargetRole('.NET Developer')) === JSON.stringify(['dotnet', 'developer']),
        '.NET canonicalizes to a token that cannot collide with network*');
      assert(titleMatchesTargetRole('Senior .NET Core Developer', '.NET Developer'), '.NET matches with extra words');
      assert(titleMatchesTargetRole('ASP.NET Developer', '.NET Developer'), 'ASP.NET contains .NET');
      return { collisionRemoved: true };
    },
  },
  {
    name: 'Tech vocabulary: the JS ecosystem is one token however it is spelled',
    run: () => {
      for (const title of ['Node.js Developer', 'NodeJS Developer', 'Node JS Developer', 'Node-js Developer']) {
        assert(titleMatchesTargetRole(title, 'Node.js Developer'), `"${title}" is the same role as Node.js Developer`);
        assert(titleMatchesTargetRole(title, 'NodeJS Developer'), `"${title}" matches when the role is typed NodeJS`);
      }
      assert(titleMatchesTargetRole('React.js Engineer', 'ReactJS Engineer'), 'React.js and ReactJS unify');
      // Only known runtimes/frameworks absorb a trailing "js" — a general rule
      // would fuse unrelated pairs such as "Full Stack JS" into "stackjs".
      assert(!titleMatchesTargetRole('Node Engineer', 'Node.js Engineer'), 'bare "Node" is not "Node.js"');
      return { spellings: 4 };
    },
  },
  {
    name: 'Tech vocabulary: compound role names split and join freely',
    run: () => {
      for (const typed of ['Full Stack Engineer', 'Full-Stack Engineer', 'Fullstack Engineer']) {
        for (const title of ['Full Stack Engineer', 'Full-Stack Engineer', 'Fullstack Engineer']) {
          assert(titleMatchesTargetRole(title, typed), `"${typed}" must match "${title}"`);
        }
      }
      assert(titleMatchesTargetRole('Frontend Developer', 'Front End Developer'), 'front end → frontend');
      assert(titleMatchesTargetRole('Back End Developer', 'Backend Developer'), 'backend → back end');
      // The *Ops family must unify in BOTH directions and reach the spelled-out
      // form. Joining these into one token broke all three: "SecOps" and
      // "Sec Ops" matched neither way, and "ML Ops" could not reach
      // "ML Operations".
      for (const [a, b] of [
        ['DevOps Engineer', 'Dev Ops Engineer'],
        ['SecOps Engineer', 'Sec Ops Engineer'],
        ['FinOps Analyst', 'Fin Ops Analyst'],
        ['MLOps Engineer', 'ML Ops Engineer'],
      ]) {
        assert(titleMatchesTargetRole(a, b), `"${b}" must match "${a}"`);
        assert(titleMatchesTargetRole(b, a), `"${a}" must match "${b}" (the reverse direction too)`);
      }
      assert(titleMatchesTargetRole('ML Operations Engineer', 'ML Ops Engineer'), 'ML Ops reaches ML Operations');
      assert(titleMatchesTargetRole('Development Operations Engineer', 'Dev Ops Engineer'), 'Dev Ops reaches the fully spelled-out form');
      assert(titleMatchesTargetRole('E-Commerce Manager', 'Ecommerce Manager'), 'ecommerce spellings unify');
      // The compound is still a real requirement, not a wildcard.
      assert(!titleMatchesTargetRole('Backend Engineer', 'Full Stack Engineer'), 'fullstack is not backend');
      return { compounds: true };
    },
  },
  {
    name: 'Tech vocabulary: Java must not match JavaScript',
    run: () => {
      // The classic tech-recruiting false positive: prefix matching would make
      // every JavaScript posting a Java hit.
      assert(!titleMatchesTargetRole('JavaScript Developer', 'Java Developer'), 'Java must not match JavaScript');
      assert(!titleMatchesTargetRole('Senior JavaScript Engineer', 'Java Engineer'), 'blocked with extra words');
      assert(JSON.stringify(tokenizeTargetRole('Java Developer')) === JSON.stringify(['java', 'developer']),
        'Java stays its own token');
      // The block is a precise word pair, not a whole-word requirement, so real
      // Java inflections still match.
      assert(titleMatchesTargetRole('JavaEE Developer', 'Java Developer'), 'Java still matches JavaEE');
      assert(titleMatchesTargetRole('Java8 Backend Developer', 'Java Developer'), 'Java still matches Java8');
      return { blocked: 'javascript' };
    },
  },
  {
    name: 'Tech vocabulary: seniority abbreviations unify',
    run: () => {
      assert(titleMatchesTargetRole('Sr. Data Engineer', 'Senior Data Engineer'), 'Sr. matches Senior');
      assert(titleMatchesTargetRole('Sr Data Engineer', 'Senior Data Engineer'), 'Sr matches Senior');
      assert(titleMatchesTargetRole('Senior Data Engineer', 'Sr Data Engineer'), 'Senior matches a typed Sr');
      assert(titleMatchesTargetRole('Jr Software Engineer', 'Junior Software Engineer'), 'Jr matches Junior');
      // Seniority is still a requirement when typed.
      assert(!titleMatchesTargetRole('Data Engineer', 'Senior Data Engineer'), 'an unlevelled title still fails');
      return { abbreviations: true };
    },
  },
  {
    name: 'Tech vocabulary: short tech tokens stay whole-word',
    run: () => {
      assert(titleMatchesTargetRole('Go Backend Engineer', 'Go Engineer'), 'Go matches Go');
      assert(!titleMatchesTargetRole('Google Cloud Engineer', 'Go Engineer'), 'Go must not prefix-match Google');
      assert(titleMatchesTargetRole('AI Research Engineer', 'AI Engineer'), 'AI matches AI');
      assert(!titleMatchesTargetRole('Air Traffic Engineer', 'AI Engineer'), 'AI must not prefix-match Air');
      assert(titleMatchesTargetRole('QA Automation Engineer', 'QA Engineer'), 'QA matches QA');
      // An ampersand name is ONE name. Shredding "M&A" into ["m","a"] made two
      // single-letter tokens, and single letters match whole — so any title
      // containing a stray "A" and "M" satisfied a pinned "M&A Analyst".
      assert(JSON.stringify(tokenizeTargetRole('R&D Engineer')) === JSON.stringify(['rd', 'engineer']),
        'R&D is one token, not two initials');
      assert(titleMatchesTargetRole('Senior M&A Analyst', 'M&A Analyst'), 'a real M&A posting still matches');
      assert(!titleMatchesTargetRole('Senior Analyst, A M Best Company', 'M&A Analyst'),
        'stray initials must NOT satisfy an ampersand name');
      return { shortTokens: true };
    },
  },
  {
    name: 'Tech vocabulary: desirable prefix matches still work',
    run: () => {
      // The vocabulary must not over-correct — these are the inflections the
      // prefix rule exists for.
      assert(titleMatchesTargetRole('Security Operations Engineer', 'Sec Ops Engineer'), 'sec/ops abbreviations expand');
      assert(titleMatchesTargetRole('Testing Engineer', 'Test Engineer'), 'test → testing');
      assert(titleMatchesTargetRole('Developer Advocate', 'Develop Advocate'), 'develop → developer');
      assert(titleMatchesTargetRole('Kubernetes Administrator', 'Kubernetes Admin'), 'admin → administrator');
      return { inflections: true };
    },
  },
  {
    name: 'Operator advisory detects Boolean syntax typed into the role box',
    run: () => {
      // Broadcast operators are unsafe: ignored on three boards, destructive on
      // Google/USAJobs, and intent-inverting on ZipRecruiter.
      assert(detectQueryOperators('Controller NOT carpenter').includes('NOT'), 'NOT is detected');
      assert(detectQueryOperators('Engineer -manager').includes('-term'), 'leading minus is detected');
      assert(detectQueryOperators('Nurse OR Physician').includes('OR'), 'OR is detected');
      assert(detectQueryOperators('title:"System Architect"').includes('field:'), 'field syntax is detected');
      assert(detectQueryOperators('"System Architect"').includes('"quotes"'), 'quotes are detected');
      // Ordinary roles must not trip the advisory, including hyphenated ones.
      for (const clean of ['System Architect', 'Full-Stack Engineer', 'Sr. Data Engineer', 'C++ Developer', 'R&D Manager']) {
        assert(detectQueryOperators(clean).length === 0, `"${clean}" is not operator syntax`);
      }
      return { detected: true };
    },
  },
  {
    name: 'LinkedIn walk: cross-query overlap is not exhaustion',
    run: () => {
      const walk = (cardsOnPage, newToThisQuery, nextStart = 50, maxResults = 150) =>
        linkedInPageStopReason({ cardsOnPage, newToThisQuery, nextStart, maxResults });

      // THE BUG: freshness was measured against the run-wide dedup set, so a page
      // whose rows an EARLIER query had already returned looked identical to
      // exhaustion and ended this query's walk on page 1. The generator emits
      // several near-synonym queries, so that overlap is the expected case.
      assert(walk(25, 25) === null, 'a full page of new rows keeps walking');
      assert(walk(25, 25, 25, 150) === null, 'still walking well inside the offset budget');

      // Genuine stops remain distinguishable from each other.
      assert(walk(0, 0) === 'exhausted', 'no cards at all is real exhaustion');
      assert(walk(25, 0) === 'no-new-rows', 'cards present but none new to THIS query = pager not advancing');
      assert(walk(25, 25, 150, 150) === 'result-ceiling', 'the offset budget bound the walk, not the data');
      assert(walk(25, 25, 175, 150) === 'result-ceiling', 'past the budget is still ceiling-bound');

      // Exhaustion outranks the ceiling: an empty page is empty regardless of offset.
      assert(walk(0, 0, 150, 150) === 'exhausted', 'an empty final page reports exhaustion, not a ceiling');
      return { ok: true };
    },
  },
  {
    name: 'RemoteOK tag fan-out is derived, deduped and bounded',
    run: () => {
      // The bare feed is a HARD 99-posting cap (limit/offset are ignored), and a
      // tag-scoped fetch returns DIFFERENT inventory — measured live, ?tag=react
      // returned 100 postings with ZERO overlap with the bare feed. Tags are the
      // only way to reach the rest, so they are derived from the run's queries.
      assert(JSON.stringify(remoteOkTagsFromQueries(['System Architect'])) === JSON.stringify(['system', 'architect']),
        'query words become candidate tags in order');
      assert(remoteOkTagsFromQueries(['alpha beta gamma delta epsilon']).length === 3,
        'the request count is capped regardless of query length (RemoteOK ToS threatens suspension for misuse)');
      assert(remoteOkTagsFromQueries(['senior remote jobs']).length === 0,
        'stopwords that would match half the feed are excluded');
      assert(remoteOkTagsFromQueries(['React react REACT']).length === 1,
        'case-insensitive dedup — never two requests for the same tag');
      for (const empty of [[], null, undefined, [''], ['  ']]) {
        assert(remoteOkTagsFromQueries(empty).length === 0, 'no queries means no extra requests');
      }
      // A wrong guess is harmless by construction: an unknown tag returns the
      // metadata element only, which is zero rows after the slice(1).
      assert(remoteOkTagsFromQueries(['zzqxnotatag']).length === 1, 'an unknown word is still attempted — a miss costs one empty response, not an error');
      return { ok: true };
    },
  },
  {
    name: 'WeWorkRemotely category fan-out is query-derived and bounded',
    run: () => {
      // The main feed has no keyword parameter (?search= is a verified no-op) and
      // caps around 90 postings. Category feeds carry different inventory —
      // measured live, three of them held 78 postings the main feed did not list.
      assert(wwrCategoriesFromQueries(['System Architect']).includes('remote-programming-jobs'),
        'an engineering role implies the programming feed');
      assert(wwrCategoriesFromQueries(['Senior UX Designer']).includes('remote-design-jobs'),
        'a design role implies the design feed');
      assert(!wwrCategoriesFromQueries(['Senior UX Designer']).includes('remote-programming-jobs'),
        'an unrelated taxonomy branch is not pulled just to be discarded by the title gate');
      assert(wwrCategoriesFromQueries(['engineer devops design product support']).length === 3,
        'the extra request count is capped (WWR rate-limits and 403s on excess)');
      for (const empty of [[], null, undefined, [''], ['   ']]) {
        assert(wwrCategoriesFromQueries(empty).length === 0, 'no queries means no extra requests');
      }
      return { ok: true };
    },
  },
  {
    name: 'RemoteOK salary never emits a half-formed range',
    run: () => {
      // The feed uses 0 (not null) for "no figure", and only salary_min used to
      // be guarded — so a min-only posting rendered "$120000 - $undefined" on the
      // card and in the scoring prompt, and a max-only posting reported nothing
      // at all (bucketed Unspecified, excluded from the 75+ compensation gate).
      assert(formatRemoteOkSalary(120000, 160000) === '$120,000 - $160,000', 'a real range formats both bounds');
      assert(formatRemoteOkSalary(120000, 0) === '$120,000', 'min-only yields a single figure, never "$X - $undefined"');
      assert(formatRemoteOkSalary(0, 160000) === '$160,000', 'max-only is no longer dropped');
      assert(formatRemoteOkSalary(120000, undefined) === '$120,000', 'a missing max is not interpolated');
      assert(formatRemoteOkSalary(150000, 150000) === '$150,000', 'a degenerate range collapses to one figure');
      assert(formatRemoteOkSalary(0, 0) === '', 'no figures yields an empty string');
      assert(formatRemoteOkSalary(null, null) === '', 'nulls yield an empty string');
      for (const out of [formatRemoteOkSalary(1, undefined), formatRemoteOkSalary(undefined, 1), formatRemoteOkSalary('x', 'y')]) {
        assert(!/undefined|NaN/.test(out), `"${out}" must never contain undefined or NaN`);
      }
      return { ok: true };
    },
  },
  {
    name: 'Target-role gate handles multi-word roles beyond two words',
    run: () => {
      const role = 'Senior Data Engineer';
      assert(titleMatchesTargetRole('Senior Data Engineer', role), 'the plain three-word title matches');
      assert(titleMatchesTargetRole('Senior Staff Data Platform Engineer', role), 'all three words present with gaps');
      assert(titleMatchesTargetRole('Data Engineer, Senior', role), 'order does not matter');
      assert(!titleMatchesTargetRole('Senior Data Scientist', role), 'missing engineer* drops');
      assert(!titleMatchesTargetRole('Data Engineer', role), 'missing senior* drops');
      return { words: 3 };
    },
  },
];
