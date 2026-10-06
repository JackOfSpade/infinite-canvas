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
      const requestedSources = ['indeed', 'google', 'dice', 'usajobs', 'remoteok'];
      for (const conflicting of [
        { city: 'Toronto', stateCode: 'Ontario', country: 'United States' },
        { city: 'Denver', subdivision: 'Colorado', country: 'Canada' },
      ]) {
        const classified = classifyJobTargetLocation('', conflicting);
        assert(classified.countryConflict && classified.boardReady === '',
          `structured cross-country subdivision must remain rejected at source admission: ${JSON.stringify(conflicting)}`);
        assert(getCountryApplicableJobSourceIds(requestedSources, '', conflicting).length === 0,
          'a contradictory structured location must dispatch no source, including global/best-effort sources');
      }
      const freeform = classifyJobTargetLocation('', {
        city: 'Leeds', subdivision: 'West Yorkshire', country: 'United Kingdom',
      });
      assert(!freeform.countryConflict && freeform.boardReady === 'Leeds, West Yorkshire, United Kingdom',
        'a free-form foreign subdivision remains valid at source admission');
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
        // locKeyword is deliberately NOT sent: Glassdoor ignores the location
        // TEXT, and it was the measured trigger for the country redirect. The
        // resolver scope below is the real carrier of location intent.
        assert(new URL(glassdoor.url).searchParams.get('locKeyword') === null, `${input}: Glassdoor is not sent the ignored locKeyword text`);
        assert(new URL(glassdoor.url).hostname === (normalizeLocationInput(input).countryCode === 'CA' ? 'www.glassdoor.ca' : 'www.glassdoor.com'),
          `${input}: Glassdoor uses the verified country site`);
        assert(glassdoor.resolveGlassdoorLocation === canonical, `${input}: Glassdoor strict resolver receives the same canonical scope`);
        assert(!glassdoor.glassdoorLocationSoftScope, `${input}: a location the user asked for is a HARD boundary — a failed locId lookup must skip the source, not widen it`);
        // The location is always appended (Google parses a place name as a
        // location SCOPE that overrides geolocation), but the vestigial " jobs"
        // suffix is not — udm=8 is already the jobs vertical.
        assert(new URL(google.url).searchParams.get('q') === `Systems Architect ${canonical}`,
          `${input}: Google receives the canonical location as a scope`);
      }
      return { inputs: inputs.length };
    },
  },
{
    name: 'Glassdoor country scope on a remote-only search is a SOFT hint, not a boundary',
    run: () => {
      // A remote-only search flattens to no location filter (correct — "Remote,
      // United States" must never reach a board's location field), which used to
      // leave Glassdoor with no locId at all, so the geo-redirect silently chose
      // the market. The country now pins the market — but because nationwide is
      // ALREADY the right answer for a remote search, a failed locId lookup must
      // continue unscoped rather than skip the source and return zero rows.
      const remote = buildJobTasks(
        ['Systems Architect'], 21, { onlySources: new Set(['glassdoor']) },
        '',            // no location filter — remote-only
        null,
        'United States', // country scope
      ).find(task => task.sourceId === 'glassdoor');
      assert(remote, 'a remote-only search still builds a Glassdoor task');
      assert(remote.resolveGlassdoorLocation === 'United States', 'the country pins the market');
      assert(remote.glassdoorLocationSoftScope === true, 'a country-only scope is soft — a failed lookup must not zero the source');
      assert(new URL(remote.url).hostname === 'www.glassdoor.com', 'a US country scope selects the US host');

      // Google pins the BARE template to the egress metro — measured from a
      // Canadian exit, a bare query returned 0/159 US cards, all Toronto/Ontario.
      // A remote search produces an empty location FILTER by design, so without
      // the country it was answered with jobs near whatever IP the run left from.
      // Remote IS nationwide, so the country is the correct scope exactly here.
      const remoteGoogle = buildJobTasks(
        ['Systems Architect'], 21, { onlySources: new Set(['google']) }, '', null, 'United States',
      ).find(task => task.sourceId === 'google');
      assert(new URL(remoteGoogle.url).searchParams.get('q') === 'Systems Architect United States',
        'a remote search sends Google the country scope instead of a metro-pinned bare query');
      const remoteGoogleCa = buildJobTasks(
        ['Systems Architect'], 21, { onlySources: new Set(['google']) }, '', null, 'Canada',
      ).find(task => task.sourceId === 'google');
      assert(new URL(remoteGoogleCa.url).searchParams.get('q') === 'Systems Architect Canada',
        'the remote country scope is not US-specific');
      const noScopeGoogle = buildJobTasks(
        ['Systems Architect'], 21, { onlySources: new Set(['google']) }, '', null, '',
      ).find(task => task.sourceId === 'google');
      assert(new URL(noScopeGoogle.url).searchParams.get('q') === 'Systems Architect',
        'with neither a location nor a country there is nothing to append');
      assert(new URL(remote.url).searchParams.get('locKeyword') === null, 'the ignored locKeyword text is never sent');

      const remoteCa = buildJobTasks(
        ['Systems Architect'], 21, { onlySources: new Set(['glassdoor']) }, '', null, 'Canada',
      ).find(task => task.sourceId === 'glassdoor');
      assert(new URL(remoteCa.url).hostname === 'www.glassdoor.ca', 'a Canadian country scope selects the Canadian host even with no location filter');

      const noScope = buildJobTasks(
        ['Systems Architect'], 21, { onlySources: new Set(['glassdoor']) }, '',
      ).find(task => task.sourceId === 'glassdoor');
      assert(!noScope.resolveGlassdoorLocation, 'with neither a location nor a country there is nothing to resolve');
      return { softScope: true };
    },
  },
];
