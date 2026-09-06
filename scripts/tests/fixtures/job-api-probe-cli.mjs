import { runJobApiProbeCli } from '../../run-api-tests.js';

const mode = process.argv[2] || 'success';
const job = (source) => ({
  items: [{ title: 'Software Engineer', company: `${source} Co`, source }],
});

const extractors = {
  fetchLinkedInJobs: async () => job('linkedin'),
  fetchRemoteOKJobs: async () => {
    if (mode === 'failure') throw new Error('fake HTTP 429');
    return job('remoteok');
  },
  fetchWeWorkRemotelyJobs: async () => job('weworkremotely'),
  fetchDiceListings: async () => job('dice'),
};

await runJobApiProbeCli({ extractors });
