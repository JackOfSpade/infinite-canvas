// Focused tests for the application-generation half of multi-location posting
// consolidation. The Board package supplies `job.postingVariants` (a bounded
// array of per-mirror targets) while `job.location` is the display string
// "Multiple locations"; these tests pin the shared normalizer's bounds and
// security, the single-description Markdown companion, the generated
// Application.html link list (and its legacy one-link shape), and the
// JobCard/local-AI hand-off that carries the variants end to end. Board
// grouping and any AI call are out of scope here.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assert,
  buildResumeDocument,
  formatOriginalJobListingMarkdown,
  normaliseResumeDownloadBundle,
} from '../test-dependencies.js';
import {
  MAX_POSTING_VARIANTS,
  MAX_POSTING_VARIANT_LOCATION_LENGTH,
  MAX_POSTING_VARIANT_URL_LENGTH,
  normaliseJobPostingVariants,
  normalizeJobListingExternalUrl,
} from '../../electron/ipc/applicationBundle.js';
import { normalisePostingVariants } from '../../electron/ipc/resumeHtml.js';
import { projectOfficialPostingGenerationJob } from '../../src/utils/officialPostingPreparation.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const read = relative => fs.readFileSync(path.join(REPO_ROOT, relative), 'utf8');

const countOccurrences = (haystack, needle) => haystack.split(needle).length - 1;

const RESUME_MAIN = '<main class="page"><section class="section"><h1 class="title">Jane Doe</h1>'
  + '<p class="role-summary">Engineer.</p></section></main>';

const renderApplication = (downloadBundle) => buildResumeDocument({
  resumeMainHtml: RESUME_MAIN,
  ledger: [],
  docId: 'multi-posting-test',
  jobContext: { jobTitle: 'Platform Engineer', company: 'Acme' },
  downloadBundle: { company: 'Acme', candidateName: 'Jane Doe', jobMarkdown: '# listing', ...downloadBundle },
});

export default [
  {
    name: 'posting variants: shared normalizer bounds, dedup, and security policy',
    run: () => {
      // Non-arrays and empty input are the legacy shape and must stay empty.
      assert(Array.isArray(normaliseJobPostingVariants(undefined)) && normaliseJobPostingVariants(undefined).length === 0, 'missing postingVariants must normalize to []');
      assert(normaliseJobPostingVariants({ url: 'https://jobs.example.test/a' }).length === 0, 'a non-array postingVariants must normalize to []');

      const normalized = normaliseJobPostingVariants([
        { location: 'Lakeview', url: 'https://jobs.example.test/a', source: 'linkedin', posted: '2 days ago', salary: '$1', applySource: 'direct' },
        { location: 'Lakeview', url: 'https://jobs.example.test/a' }, // exact duplicate URL+location
        { location: 'Lakeview', url: 'https://jobs.example.test/a/' }, // distinct canonical href (trailing slash)
        { location: '  Berlin\u0000 ', url: 'https://jobs.example.test/b' }, // control char + trim
        { location: 'No URL' }, // no target at all
        { location: 'Credentialed', url: 'https://user:pass@jobs.example.test/c' },
        { location: 'Javascript', url: 'javascript:alert(1)' },
        { location: 'Ftp', url: 'ftp://jobs.example.test/d' },
        { location: 'Data', url: 'data:text/html;base64,PHNjcmlwdD4=' },
        { location: 'Relative', url: '/jobs/1' },
        null,
        'string',
        ['https://jobs.example.test/e'],
        { location: 'Google only', googleCardUrl: 'https://jobs.example.test/g' },
      ]);
      assert(normalized.length === 4, `expected 4 retained variants, saw ${normalized.length}`);
      assert(normalized[0].url === 'https://jobs.example.test/a', 'first safe URL must be canonical https');
      assert(normalized[0].source === 'linkedin' && normalized[0].posted === '2 days ago' && normalized[0].salary === '$1' && normalized[0].applySource === 'direct', 'safe scalar fields must survive');
      assert(normalized[2].location === 'Berlin', 'control characters must be stripped and whitespace collapsed');
      assert(normalized[3].url === '' && normalized[3].googleCardUrl === 'https://jobs.example.test/g', 'a Google-card-only target is retained with an empty url');
      const urls = normalized.map(variant => variant.url || variant.googleCardUrl);
      assert(!urls.some(url => /javascript|data:|ftp:|user:pass/.test(url)), 'unsafe or credentialed URLs must never be retained');
      assert(!normalized.some(variant => variant.location === 'No URL'), 'a variant with no safe URL is rejected');

      // Count bound and per-field length bound.
      const many = Array.from({ length: MAX_POSTING_VARIANTS + 10 }, (_value, index) => ({ location: `L${index}`, url: `https://jobs.example.test/${index}` }));
      assert(normaliseJobPostingVariants(many).length === MAX_POSTING_VARIANTS, 'variant count must be bounded');
      const longLocation = 'x'.repeat(MAX_POSTING_VARIANT_LOCATION_LENGTH + 50);
      const bounded = normaliseJobPostingVariants([{ location: longLocation, url: 'https://jobs.example.test/bounded' }]);
      assert(bounded[0].location.length === MAX_POSTING_VARIANT_LOCATION_LENGTH, 'location must be length-bounded');
      const longUrl = `https://jobs.example.test/${'a'.repeat(MAX_POSTING_VARIANT_URL_LENGTH)}`;
      assert(normaliseJobPostingVariants([{ location: 'Long', url: longUrl }]).length === 0, 'over-long URLs must be rejected, not truncated');

      // The URL helper is the single policy: absolute, public, credential-free.
      assert(normalizeJobListingExternalUrl('https://jobs.example.test/path?q=1') === 'https://jobs.example.test/path?q=1', 'plain https URL must pass');
      assert(normalizeJobListingExternalUrl('https://user:pass@jobs.example.test/x') === '', 'credentials must be rejected');
      assert(normalizeJobListingExternalUrl('https://jobs.example.test/a\nb') === '', 'control characters must be rejected');
      assert(normalizeJobListingExternalUrl('mailto:jobs@example.test') === '', 'non-http schemes must be rejected');
      assert(normalizeJobListingExternalUrl('') === '', 'empty URLs must be rejected');
    },
  },
  {
    name: 'original listing Markdown: description once, every safe location and URL listed without injection',
    run: () => {
      const sharedDescription = 'Build `systems` and ``` ship them.';
      const markdown = formatOriginalJobListingMarkdown({
        title: '# Platform [Engineer]',
        company: 'A * B <script>',
        location: 'Multiple locations',
        description: sharedDescription,
        postingVariants: [
          { location: 'Lakeview, ON', url: 'https://jobs.example.test/lakeview' },
          { location: 'Berlin', url: 'https://jobs.example.test/berlin' },
          { location: 'Unsafe', url: 'javascript:alert(1)' },
          { location: 'Creds', url: 'https://token:secret@jobs.example.test/creds' },
        ],
      });
      assert(countOccurrences(markdown, sharedDescription) === 1, 'the shared description must appear exactly once');
      assert(markdown.includes('- **Lakeview, ON:** <https://jobs.example.test/lakeview>'), 'each safe location must list with its URL');
      assert(markdown.includes('- **Berlin:** <https://jobs.example.test/berlin>'), 'the second safe location must be listed');
      assert(!markdown.includes('javascript:alert'), 'an unsafe variant URL must not become a Markdown link');
      assert(!markdown.includes('token:secret'), 'credentialed variant URLs must not be printed');
      assert(markdown.includes('\\# Platform \\[Engineer\\]'), 'title Markdown syntax must be escaped');
      assert(!markdown.includes('<script>'), 'raw HTML from untrusted fields must not survive');
      assert(markdown.includes('A \\* B'), 'company Markdown syntax must be escaped');

      // A single/legacy posting (no variants) must keep its exact prior shape:
      // no posting-target section, one fenced description.
      const legacy = formatOriginalJobListingMarkdown({
        title: 'Platform Engineer', company: 'Acme', location: 'Lakeview', url: 'https://jobs.example.test/one',
        description: sharedDescription,
      });
      assert(!legacy.includes('## Posting locations'), 'legacy output must not grow a posting-locations section');
      assert(countOccurrences(legacy, sharedDescription) === 1, 'legacy output has exactly one description');
      assert(legacy.includes('**Listing URL:** <https://jobs.example.test/one>'), 'legacy listing URL line must be preserved');
    },
  },
  {
    name: 'Application.html: one labelled safe link per posting, legacy single-link label unchanged',
    run: () => {
      const multi = renderApplication({
        jobUrl: 'https://jobs.example.test/primary',
        postingVariants: [
          { location: 'Lakeview', url: 'https://jobs.example.test/lakeview' },
          { location: 'Berlin', url: 'https://jobs.example.test/berlin' },
          { location: 'Unsafe', url: 'javascript:alert(1)' },
        ],
      });
      const postingLinkPattern = /<a class="ic-job-posting-link" href="[^"]+" target="_blank" rel="noopener noreferrer">/g;
      assert((multi.match(postingLinkPattern) || []).length === 1, 'multiple variants still render exactly one posting link');
      assert(countOccurrences(multi, 'View original job posting</a>') === 1, 'the one link keeps the plain original label');
      assert(!multi.includes('View original job posting —'), 'no location-labelled link is rendered');
      assert(!multi.includes('<div class="ic-job-posting-links">'), 'no posting-links container is rendered');
      assert(!multi.includes('javascript:alert'), 'a javascript: variant URL must be omitted from the document');
      assert(/href="https:\/\/jobs\.example\.test\/primary"/.test(multi), 'the open job URL is the one link');
      assert(!/href="https:\/\/jobs\.example\.test\/(?:lakeview|berlin)"/.test(multi), 'variant URLs are not linked while the job URL is open');
      const officialMulti = renderApplication({ jobUrl: 'https://jobs.example.test/primary',
        officialPosting: { level: 'L2', sourceUrl: 'https://careers.example.test/official', officialApplyUrl: 'https://careers.example.test/apply' },
        postingVariants: [{ location: 'Lakeview', url: 'https://jobs.example.test/lakeview' }, { location: 'Berlin', url: 'https://jobs.example.test/berlin' }],
      });
      const officialAt = officialMulti.indexOf('View official job posting</a>');
      assert(officialAt >= 0 && !officialMulti.includes('View original job posting'), 'with an official page, that is the only posting link');
      assert((officialMulti.match(postingLinkPattern) || []).length === 1 && !officialMulti.includes('<div class="ic-job-posting-links">'), 'a confirmed official posting renders exactly one link and no container');
      assert(officialMulti.includes('href="https://careers.example.test/official"'), 'official page URL wins over its apply form');

      // An older closure not read on the full page is not trusted, so the open listing stays the one link.
      const olderClosure = renderApplication({ jobUrl: 'https://jobs.example.test/only',
        officialPosting: { level: 'L2', outcome: 'closed', sourceUrl: 'https://careers.example.test/official', trail: ['closed', 'semantic-match-v1'] } });
      assert(countOccurrences(olderClosure, 'View original job posting</a>') === 1, 'an untrusted closure leaves the listing link');
      assert(olderClosure.includes('href="https://jobs.example.test/only"'), 'the open listing is that link');

      // Legacy one-link: with no variants, the exact legacy label must remain
      // and the new multi-link container must not appear.
      const legacy = renderApplication({ jobUrl: 'https://jobs.example.test/only' });
      assert(countOccurrences(legacy, 'View original job posting</a>') === 1, 'legacy single link must keep the exact label');
      assert(!legacy.includes('View original job posting —'), 'legacy output must not use the location-labelled form');
      assert(!legacy.includes('<div class="ic-job-posting-links">'), 'legacy output must not add the multi-link container');
      assert(/href="https:\/\/jobs\.example\.test\/only"/.test(legacy), 'legacy href must be preserved');

      // A single safe variant still uses the legacy label: it is not "multiple".
      const singleVariant = renderApplication({
        jobUrl: '',
        postingVariants: [{ location: 'Lakeview', url: 'https://jobs.example.test/solo' }],
      });
      assert(countOccurrences(singleVariant, 'View original job posting</a>') === 1, 'one variant keeps the legacy label');
      assert(!singleVariant.includes('<div class="ic-job-posting-links">'), 'one variant does not trigger the multi-link container');

      // Location labels never reach a link, so nothing is rendered from them.
      const escaped = renderApplication({
        jobUrl: 'https://jobs.example.test/primary',
        postingVariants: [
          { location: 'A "quoted" <b>', url: 'https://jobs.example.test/a' },
          { location: 'B & C', url: 'https://jobs.example.test/b' },
        ],
      });
      assert(!escaped.includes('A &quot;quoted&quot; &lt;b&gt; </a>') && (escaped.match(postingLinkPattern) || []).length === 1, 'location labels are not rendered as link text');

      // Rule 1: exactly one link in each case.
      const count = html => (html.match(postingLinkPattern) || []).length;
      const hrefOf = html => (html.match(/<a class="ic-job-posting-link" href="([^"]+)"/) || [])[1];
      const closedVariant = (location, url) => ({ location, url, liveness: 'closed' });

      // A closed job URL with an open variant links the open variant, labelled original.
      const closedPrimary = renderApplication({
        jobUrl: 'https://jobs.example.test/primary',
        postingVariants: [closedVariant('Lakeview', 'https://jobs.example.test/primary'), { location: 'Berlin', url: 'https://jobs.example.test/berlin' }],
      });
      assert(count(closedPrimary) === 1 && hrefOf(closedPrimary) === 'https://jobs.example.test/berlin', 'a closed job URL is replaced by the first open variant');
      assert(countOccurrences(closedPrimary, 'View original job posting</a>') === 1, 'the open variant is labelled original');
      assert(!closedPrimary.includes('<div class="ic-job-posting-links">'), 'no container for the open variant');

      // The selected open alternate wins over the job URL and every variant.
      const selectedAlternate = renderApplication({
        jobUrl: 'https://jobs.example.test/primary', listingLinkUrl: 'https://alt.example.test/open',
        postingVariants: [{ location: 'Lakeview', url: 'https://jobs.example.test/lakeview' }, { location: 'Berlin', url: 'https://jobs.example.test/berlin' }],
      });
      assert(count(selectedAlternate) === 1 && hrefOf(selectedAlternate) === 'https://alt.example.test/open', 'the selected alternate is the one link');

      // Every variant closed and no job URL: no link at all.
      const allClosed = renderApplication({ jobUrl: '', postingVariants: [closedVariant('Lakeview', 'https://jobs.example.test/lakeview')] });
      assert(count(allClosed) === 0 && !allClosed.includes('<div class="ic-job-posting-links">'), 'nothing open means no link');

      // A confirmed official posting is the only link, with its page ahead of its apply form.
      const officialOnly = renderApplication({ jobUrl: 'https://jobs.example.test/primary',
        officialPosting: { level: 'L2', sourceUrl: 'https://careers.example.test/official' },
        postingVariants: [{ location: 'Lakeview', url: 'https://jobs.example.test/lakeview' }] });
      assert(count(officialOnly) === 1 && hrefOf(officialOnly) === 'https://careers.example.test/official', 'the official posting is the one link');
      assert(countOccurrences(officialOnly, 'View official job posting</a>') === 1 && !officialOnly.includes('View original job posting'), 'only the official label appears');

      // A closed official posting leaves no link, however open the scraped URLs look.
      const officialClosed = renderApplication({ jobUrl: 'https://jobs.example.test/primary', listingLinkUrl: 'https://alt.example.test/open',
        officialPosting: { level: 'L2', outcome: 'closed', employer: 'Example Co', sourceUrl: 'https://careers.example.test/official', trail: ['closed', 'closure-page-read', 'semantic-match-v1'] },
        postingVariants: [{ location: 'Lakeview', url: 'https://jobs.example.test/lakeview' }] });
      assert(officialClosed.includes('data-ic-official-posting-status="closed"'), 'control: the official posting reads as closed');
      assert(count(officialClosed) === 0 && !officialClosed.includes('<div class="ic-job-posting-links">'), 'a closed official posting means no link at all');
    },
  },
  {
    name: 'inert workspace bundle JSON stores only normalized posting variants',
    run: () => {
      const bundle = normaliseResumeDownloadBundle({
        company: 'Acme',
        jobUrl: 'https://jobs.example.test/primary',
        postingVariants: [
          { location: 'Lakeview', url: 'https://jobs.example.test/a' },
          { location: 'Lakeview', url: 'https://jobs.example.test/a' },
          { location: 'Creds', url: 'https://user:pass@jobs.example.test/c' },
          { location: 'Unsafe', url: 'javascript:void(0)' },
        ],
      });
      assert(Array.isArray(bundle.postingVariants) && bundle.postingVariants.length === 1, 'duplicate/unsafe variants must be dropped before serialization');
      assert(bundle.postingVariants[0].url === 'https://jobs.example.test/a', 'only the normalized URL survives');
      assert(normaliseResumeDownloadBundle({}).postingVariants.length === 0, 'a legacy bundle with no variants exposes an empty list');
      assert(normalisePostingVariants([{ location: 'X', url: 'https://jobs.example.test/x' }]).length === 1, 'resumeHtml must re-use the shared normalizer');

      const html = renderApplication({
        jobUrl: 'https://jobs.example.test/primary',
        postingVariants: [{ location: 'Lakeview', url: 'https://jobs.example.test/a' }, { location: 'Berlin', url: 'https://jobs.example.test/b' }],
      });
      assert(/"postingVariants":/.test(html), 'the inert bundle JSON must carry postingVariants');
      assert(!/user:pass|javascript:/.test(html), 'no unsafe URL text may reach the generated document');
    },
  },
  {
    name: 'pipeline: JobCard and local-AI carry postingVariants end to end through the shared normalizer',
    run: () => {
      const jobCard = read('src/nodes/JobCardNode.jsx');
      // The handoff payload must forward variants, and each external URL must
      // pass the same normalizer used for the primary listing before IPC.
      assert(jobCard.includes('projectOfficialPostingGenerationJob(sourceCard.data)')
        && jobCard.includes('projectOfficialPostingGenerationJob(cardBeforeQueue.data)')
        && jobCard.includes('job: sourceJob,') && jobCard.includes('job: queueJob,'),
      'research and queue payloads must forward the shared live posting projection');
      const payload = projectOfficialPostingGenerationJob({ title: 'Platform Engineer', company: 'Acme',
        postingVariants: [{ location: 'Lakeview', url: 'https://jobs.example.test/lakeview' },
          { location: 'Unsafe', url: 'javascript:alert(1)' }] });
      assert(payload.postingVariants[0].url === 'https://jobs.example.test/lakeview'
        && payload.postingVariants[1].url === '', 'each variant URL must be normalized before IPC');
      assert(jobCard.includes('const subtitleLocation = useMemo(') && jobCard.includes('Multiple locations'),
        'the card subtitle must resolve a bounded "Multiple locations" label');

      const localAi = read('electron/ipc/localAiApplication.js');
      assert(localAi.includes('postingVariants: normaliseJobPostingVariants(raw.postingVariants)'),
        'safeJob must retain only shared-normalized postingVariants');
      assert(/buildResumeDocument\(\{[\s\S]{0,4000}postingVariants: input\.job\?\.postingVariants/.test(localAi),
        'the successful import must pass variants to buildResumeDocument');
      assert(localAi.includes("import { EMPTY_JOB_LISTING_BODY_NOTE, formatOriginalJobListingMarkdown, normaliseJobPostingVariants"),
        'local-AI must import the shared normalizer from applicationBundle');

      const resumeHtml = read('electron/ipc/resumeHtml.js');
      assert(resumeHtml.includes("} from './applicationBundle.js';") && resumeHtml.includes('normaliseJobPostingVariants'),
        'resumeHtml must use the shared normalizer rather than a duplicate policy');
    },
  },
];
