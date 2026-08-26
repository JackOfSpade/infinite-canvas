import { assert, filterJobsByDescriptionEvidence, fs, path } from '../test-dependencies.js';
import { normalizeJobsMarkup, repairJobsMojibake } from '../../src/utils/textEncoding.js';

export default [
  {
    name: 'job-source resume and generic Solve use the normal evidence-safe ingestion contract',
    run: () => {
      const recovered = [{
        source: 'indeed',
        title: 'Solutions Architect',
        company: 'Acme',
        url: 'https://example.test/jobs/1',
        snippet: `<p>Weâ€™re building reliable systems. ${'Detailed architecture and delivery evidence. '.repeat(14)}</p>`,
      }, {
        source: 'indeed',
        title: 'List-card placeholder',
        company: 'Acme',
        url: 'https://example.test/jobs/2',
        snippet: '',
      }];
      repairJobsMojibake(recovered);
      normalizeJobsMarkup(recovered);
      const evidence = filterJobsByDescriptionEvidence(recovered);
      assert(evidence.jobs.length === 1 && evidence.dropped.length === 1,
        'the shared cleanup/evidence contract keeps a full recovered JD and defers a blank list card');
      assert(!/<\/?p>/i.test(evidence.jobs[0].snippet),
        'recovered provider text is markup-normalized before scoring evidence is tested');

      const source = fs.readFileSync(path.resolve('electron/ipc/jobs.js'), 'utf8');
      const genericStart = source.indexOf("handleSafe('resolve-job-source'");
      const resumeStart = source.indexOf("handleSafe('resume-job-source'");
      const mergeStart = source.indexOf("ipcMain.handle('record-resolve-merge'", resumeStart);
      const generic = source.slice(genericStart, resumeStart);
      const resume = source.slice(resumeStart, mergeStart);
      assert(source.includes('salaryRangeMetadata: salaryRangeMetadata(job.salary)')
        && source.includes('salaryAnomaly,'),
      'taxonomy audit retains both universal salary-range provenance and the existing anomaly signal');
      assert(generic.includes('const descriptionEvidence = filterJobsByDescriptionEvidence(items);')
        && generic.includes('buildResolvedDescriptionWarning(')
        && generic.includes('removedItemKeys: descriptionEvidence.dropped.map(sourceJobKey).filter(Boolean)')
        && generic.includes('providerGathered: Math.max(0, Number(prior.providerGathered ?? prior.gathered ?? prior.count) || 0) + extractedRaw.length')
        && generic.includes('resolveFunnel: {')
        && generic.includes('recordJobSourceProgress(resolveProgress, { updatePipeline: false, expectedNodeId: nodeId })'),
      'generic non-LinkedIn Solve preserves its actionable warning, removes rejected rows, and records a terminal post-search progress event');
      assert(resume.includes('historyDropSamples = deduped.samples || [];')
        && resume.includes('repairJobsMojibake(items);')
        && resume.includes('normalizeJobsMarkup(items);')
        && resume.includes('const descriptionEvidence = filterJobsByDescriptionEvidence(items);')
        && resume.includes('tagJobLanguages(items);')
        && resume.includes('jobsTelemetry.resolves[sourceId] = {')
        && resume.includes('resumeFunnel: {')
        && resume.includes('providerGathered: Math.max(0, Number(prior.providerGathered ?? prior.gathered ?? prior.count) || 0) + gathered')
        && resume.includes('count: Math.max(0, Number(prior.count) || 0) + retained')
        && resume.includes('recordJobSourceProgress(resumeProgress, { updatePipeline: false, expectedNodeId: nodeId })')
        && resume.includes('removedItemKeys: descriptionEvidence.dropped.map(sourceJobKey).filter(Boolean)'),
      'native Indeed resume records the complete funnel, history samples, evidence drops, and a terminal source event without reactivating the gather pipeline');
      return { kept: evidence.jobs.length, deferred: evidence.dropped.length };
    },
  },
];
