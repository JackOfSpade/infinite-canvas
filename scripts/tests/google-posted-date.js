import { JSDOM, assert } from '../test-dependencies.js';
import { GOOGLE_JOBS_EXTRACTOR } from '../../electron/extractors/jobs.js';
import { GOOGLE_POSTED_TEXT_PATTERN, readGooglePanelPostedDate } from '../../electron/ipc/browser/googlePostedDate.js';
import { POSTED_DATE_PATTERN, parsePostedDate } from '../../electron/ipc/jobDateFilter.js';

// Exact-equality assertion: the shared `assert` only takes a boolean, and these
// cases are about the precise label text ("45 minutes ago"), not a substring.
function assertEqual(actual, expected, message) {
  if (!Object.is(actual, expected)) {
    throw new Error(`${message} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// A Google udm=8 list card: .GoEOPd holds [title, company, location]; the date
// chip sits beside it. `dateClass` empty => bare <span> (the legacy shape).
// `logo` renders the company-logo initials leaf BEFORE .GoEOPd, matching live
// cards where that short leaf ("3D") precedes the real date span in DOM order.
function googleCard({
  title, date = '', dateClass = '', salary = '',
  company = 'Acme', location = 'Toronto, ON • via Acme', logo = '',
}) {
  const classAttr = dateClass ? ` class="${dateClass}"` : '';
  return `<div class="EimVGf" jscontroller="b11o3b"
      data-share-url="https://www.google.com/search?q=Systems+Architect&amp;htidocid=abc">
      ${logo ? `<div class="p761wc">${logo}</div>` : ''}
      <div class="GoEOPd">
        <div class="tNxQIb" role="heading">${title}</div>
        <div>${company}</div>
        <div>${location}</div>
      </div>
      ${date ? `<span${classAttr}>${date}</span>` : ''}
      ${salary ? `<span class="pay">${salary}</span>` : ''}
      <span>Full-time</span>
    </div>`;
}

function withDom(html, run) {
  const dom = new JSDOM(`<html><body>${html}</body></html>`, {
    url: 'https://www.google.com/search?q=Systems+Architect&udm=8',
    runScripts: 'outside-only',
  });
  // jsdom intentionally lacks innerText; Google extraction runs in Chrome,
  // where it is present. This compatible getter lets the test exercise the
  // exact shipped extractor string rather than a copied approximation.
  Object.defineProperty(dom.window.HTMLElement.prototype, 'innerText', {
    configurable: true,
    get() { return this.textContent || ''; },
  });
  try {
    return run(dom);
  } finally {
    dom.window.close();
  }
}

function extractPosted(cardOptions) {
  const jobs = withDom(googleCard(cardOptions), dom => dom.window.eval(GOOGLE_JOBS_EXTRACTOR));
  assertEqual(jobs.length, 1, 'one Google card must produce exactly one row');
  return jobs[0];
}

export default [
  {
    name: 'Google posted date: classed "45 minutes ago" chip is read (not only bare spans)',
    run: () => {
      const job = extractPosted({ title: 'Systems Architect', date: '45 minutes ago', dateClass: 'z1cS8e' });
      assertEqual(job.posted, '45 minutes ago', 'a classed date span must still be read');
      assertEqual(job.employmentType, 'Full-time', 'employment type must keep coming from the bare chip');
    },
  },
  {
    name: 'Google posted date: "30+ days ago" and compact "5h ago" keep their labels',
    run: () => {
      const old = extractPosted({ title: 'Platform Engineer', date: '30+ days ago', dateClass: 'z1cS8e' });
      assertEqual(old.posted, '30+ days ago', 'the 30+ bucket must be read verbatim');
      const compact = extractPosted({ title: 'Data Engineer', date: '5h ago', dateClass: 'z1cS8e' });
      assertEqual(compact.posted, '5h ago', 'the compact hour form must be read verbatim');
    },
  },
  {
    name: 'Google posted date: "Yesterday" whole label is read',
    run: () => {
      const job = extractPosted({ title: 'Backend Engineer', date: 'Yesterday', dateClass: 'z1cS8e' });
      assertEqual(job.posted, 'Yesterday', 'a whole-label "Yesterday" must be read');
    },
  },
  {
    name: 'Google posted date: a "3D" logo leaf before the date span is never the posting age',
    run: () => {
      const job = extractPosted({ title: 'Systems Architect', logo: '3D', date: '2 days ago', dateClass: 'z1cS8e' });
      assertEqual(job.posted, '2 days ago', 'the real date span must win over a logo initials leaf');
    },
  },
  {
    name: 'Google posted date: legacy unclassed "3 days ago" bare span still works',
    run: () => {
      const job = extractPosted({ title: 'Frontend Engineer', date: '3 days ago' });
      assertEqual(job.posted, '3 days ago', 'the legacy bare-span date must keep working');
    },
  },
  {
    name: 'Google posted date: dateless card yields "" and never a salary or title fragment',
    run: () => {
      const job = extractPosted({
        title: '24 hours support analyst',
        salary: '$50K–70K a year',
      });
      assertEqual(job.posted, '', 'a card with no date must not fall back to a title or pay fragment');
      assertEqual(job.title, '24 hours support analyst', 'the title must be untouched');
      assertEqual(job.salary, '$50K–70K a year', 'the salary chip must be untouched');
    },
  },
  {
    name: 'Google posted date: pattern reuses POSTED_DATE_PATTERN and every label it captures parses',
    run: () => {
      assert(GOOGLE_POSTED_TEXT_PATTERN.includes(POSTED_DATE_PATTERN),
        'the Google pattern must embed the shared POSTED_DATE_PATTERN rather than restate the units');
      const pattern = new RegExp(GOOGLE_POSTED_TEXT_PATTERN, 'i');
      const labels = [
        '45 minutes ago', '30+ days ago', '5h ago', '3d ago', '28 days ago', '1 week ago',
        '2 months ago', '1 year ago', 'just posted', 'posted today', 'just now',
        '3 days', 'Today', 'Yesterday',
      ];
      for (const label of labels) {
        const match = pattern.exec(label);
        assert(Boolean(match), `pattern must match "${label}"`);
        const parsed = parsePostedDate(match[0]);
        assert(parsed instanceof Date && Number.isFinite(parsed.getTime()),
          `parsePostedDate must convert "${match[0]}" captured from "${label}"`);
      }
      // Compact initials and prose are NOT posting ages. "3D" is a live
      // company-logo leaf that sits before the card's real date span; "5h"
      // and "1y" lost their space; "40 hours a week" is schedule prose.
      for (const nonLabel of ['3D', '5h', 'd1g1t', 'H1', '40 hours a week']) {
        assertEqual(pattern.exec(nonLabel), null, `pattern must not match "${nonLabel}"`);
      }
      // Whole-label only: prose that merely mentions a day is never a date.
      assertEqual(pattern.exec('Apply today'), null, 'prose "Apply today" must not match');
      assertEqual(pattern.exec('Apply yesterday'), null, 'prose "Apply yesterday" must not match');
      assertEqual(pattern.exec('today only'), null, '"today only" must not match');
    },
  },
  {
    name: 'Google posted date: panel reader ignores stale aria-hidden panels and list-card dates',
    run: () => {
      const dom = new JSDOM(`<html><body>
        <div id="surface">
          <div class="resultsColumn">
            <div class="EimVGf" jscontroller="b11o3b" data-share-url="https://www.google.com/search?q=x&amp;htidocid=abc">
              <span class="chip">5 days ago</span>
            </div>
          </div>
          <div class="detailsColumn">
            <div class="panelHeader"><span class="chip">2 days ago</span></div>
            <div aria-hidden="true"><span class="OOyDTc">Stale preloaded description.</span><span class="chip">3 weeks ago</span></div>
            <span class="OOyDTc">Full-time role building services.</span>
          </div>
        </div>
      </body></html>`, { url: 'https://www.google.com/search?q=x&udm=8' });
      try {
        assertEqual(
          readGooglePanelPostedDate(dom.window.document, 'span.OOyDTc', GOOGLE_POSTED_TEXT_PATTERN),
          '2 days ago',
          'the active panel header wins over the hidden stale panel and the list card',
        );
      } finally {
        dom.window.close();
      }
    },
  },
  {
    name: 'Google posted date: panel reader stops before a level that holds list cards',
    run: () => {
      const dom = new JSDOM(`<html><body>
        <div id="surface">
          <div class="resultsColumn">
            <div class="EimVGf" jscontroller="b11o3b" data-share-url="https://www.google.com/search?q=x&amp;htidocid=abc">
              <span class="chip">5 days ago</span>
            </div>
          </div>
          <div class="detailsColumn">
            <span class="OOyDTc">Description with no posting age beside it.</span>
          </div>
        </div>
      </body></html>`, { url: 'https://www.google.com/search?q=x&udm=8' });
      try {
        assertEqual(
          readGooglePanelPostedDate(dom.window.document, 'span.OOyDTc', GOOGLE_POSTED_TEXT_PATTERN),
          '',
          'a list card date outside the panel container must never be returned',
        );
      } finally {
        dom.window.close();
      }
    },
  },
];
