import { assert } from './testHelpers.js';
import { buildJobTasks } from '../test-dependencies.js';
import { normalizeLocationInput } from '../../src/utils/jobLocation.js';
import {
  JOB_SOURCE_COUNTRY_FILTER_STRENGTH,
  classifyJobTargetLocation,
  getCountryApplicableJobSourceIds,
  getJobSourceCountryPolicy,
  summarizeJobSourceCountryPolicies,
} from '../../src/utils/jobSourceCountryScope.js';

export default [
  {
    name: 'job source country scope: parses country, province/state, and city scopes',
    run: () => {
      const cases = [
        ['Canada', 'Canada', 'country', null],
        ['USA', 'United States', 'country', null],
        ['Ontario, Canada', 'Canada', 'subdivision', 'on'],
        ['Colorado, USA', 'United States', 'subdivision', 'co'],
        ['Toronto, Ontario, Canada', 'Canada', 'city', 'on'],
        ['Denver, Colorado, USA', 'United States', 'city', 'co'],
      ];
      for (const [input, country, scope, subdivision] of cases) {
        const actual = classifyJobTargetLocation(input);
        assert(actual.country === country, `${input}: country should be ${country}`);
        assert(actual.scope === scope, `${input}: scope should be ${scope}`);
        assert((actual.subdivision?.code || null) === subdivision, `${input}: subdivision should be ${subdivision}`);
      }
      const inferred = classifyJobTargetLocation('Denver, Colorado');
      assert(inferred.country === 'United States' && inferred.scope === 'city', 'state-only legacy target should infer United States');
      const structured = classifyJobTargetLocation('Toronto, ON', { city: 'Toronto', stateCode: 'ON', country: 'Canada' });
      assert(structured.country === 'Canada' && structured.scope === 'city', 'structured location should preserve country scope');
      return { cases: cases.length };
    },
  },
  {
    name: 'job source country scope: Canada excludes only country-inapplicable sources',
    run: () => {
      const ids = ['indeed', 'linkedin', 'ziprecruiter', 'glassdoor', 'google', 'dice', 'usajobs', 'remoteok', 'weworkremotely'];
      const scoped = getCountryApplicableJobSourceIds(ids, 'Toronto, Ontario, Canada');
      assert(!scoped.includes('dice') && !scoped.includes('usajobs'), 'Canada must skip Dice and USAJobs');
      assert(scoped.length === ids.length - 2, 'Canada should retain all non-inapplicable sources');
      const glassdoor = getJobSourceCountryPolicy('glassdoor', 'Canada');
      assert(glassdoor.include && glassdoor.requiresResolvedLocation, 'Glassdoor requires verified location resolution');
      assert(getJobSourceCountryPolicy('google', 'Canada').filterStrength === JOB_SOURCE_COUNTRY_FILTER_STRENGTH.BEST_EFFORT, 'Google should be explicitly best-effort');
      assert(getJobSourceCountryPolicy('remoteok', 'Canada').filterStrength === JOB_SOURCE_COUNTRY_FILTER_STRENGTH.GLOBAL_REMOTE, 'RemoteOK should be global remote');
      return { scoped };
    },
  },
  {
    name: 'job source country scope: United States includes Dice and USAJobs with honest treatment',
    run: () => {
      const ids = ['dice', 'usajobs', 'indeed'];
      const scoped = getCountryApplicableJobSourceIds(ids, 'Denver, Colorado, USA');
      assert(scoped.join(',') === ids.join(','), 'U.S. targets should include Dice and USAJobs');
      const dice = getJobSourceCountryPolicy('dice', 'Colorado, USA');
      assert(dice.include && dice.filterStrength === JOB_SOURCE_COUNTRY_FILTER_STRENGTH.CONDITIONAL, 'Dice must remain conditional, not falsely hard-filtered');
      const usaJobs = getJobSourceCountryPolicy('usajobs', 'USA');
      assert(usaJobs.include && usaJobs.filterStrength === JOB_SOURCE_COUNTRY_FILTER_STRENGTH.HARD, 'USAJobs should be U.S.-available');
      assert(!getJobSourceCountryPolicy('usajobs', '').include && !getJobSourceCountryPolicy('dice', '').include,
        'U.S.-only sources must not run when the target country is unclassified');
      const policies = summarizeJobSourceCountryPolicies(ids, 'USA');
      assert(policies.length === ids.length && policies.every(p => p.location.country === 'United States'), 'diagnostics should carry canonical country');
      return { scoped };
    },
  },
  {
    name: 'job source location transport: every requested form reaches browser boards canonically',
    run: () => {
      const inputs = [
        'Canada', 'USA', 'Ontario, Canada', 'Colorado, USA',
        'Toronto, Ontario, Canada', 'Denver, Colorado, USA',
      ];
      for (const input of inputs) {
        const canonical = normalizeLocationInput(input).boardReady;
        const tasks = buildJobTasks(
          ['Systems Architect'],
          21,
          { onlySources: new Set(['ziprecruiter', 'glassdoor', 'google']) },
          canonical,
        );
        const zip = tasks.find(task => task.sourceId === 'ziprecruiter');
        const glassdoor = tasks.find(task => task.sourceId === 'glassdoor');
        const google = tasks.find(task => task.sourceId === 'google');
        assert(new URL(zip.url).searchParams.get('location') === canonical, `${input}: ZipRecruiter receives canonical location`);
        assert(new URL(glassdoor.url).searchParams.get('locKeyword') === canonical, `${input}: Glassdoor receives canonical resolver text`);
        assert(new URL(glassdoor.url).hostname === (normalizeLocationInput(input).countryCode === 'CA' ? 'www.glassdoor.ca' : 'www.glassdoor.com'),
          `${input}: Glassdoor uses the verified country site`);
        assert(glassdoor.resolveGlassdoorLocation === canonical, `${input}: Glassdoor strict resolver receives the same canonical scope`);
        assert(new URL(google.url).searchParams.get('q') === `Systems Architect ${canonical} jobs`, `${input}: Google receives canonical location as best-effort query text`);
      }
      return { inputs: inputs.length };
    },
  },
];
