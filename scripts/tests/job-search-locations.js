import { assert } from '../test-dependencies.js';
import {
  getSearchLocation,
  hasRequiredLocations,
  locationValidationMessage,
  locationToLegacyText,
  normalizeRemoteResidences,
  normalizeStructuredLocation,
} from '../../src/utils/jobSearchLocations.js';

export default [
  {
    name: 'Job Search structured locations normalize US/Canada without guessing other countries',
    run: () => {
      const usa = normalizeStructuredLocation({ city: 'Denver', subdivision: 'Colorado', country: 'USA' });
      assert(usa.country === 'United States' && usa.subdivision === 'Colorado' && usa.countryCode === 'US', 'US aliases and subdivisions normalize deterministically');
      assert(locationToLegacyText(usa) === 'Denver, Colorado, United States', 'legacy projection remains board-compatible');
      const foreign = normalizeStructuredLocation({ city: 'Leeds', subdivision: 'West Yorkshire', country: 'United Kingdom' });
      assert(foreign.subdivision === 'West Yorkshire' && foreign.countryCode === null, 'non-US/Canada subdivisions remain field-shaped for AI validation');
      return { usa, foreign };
    },
  },
  {
    name: 'Job Search remote residences require a non-US/Canada outside country and preserve legacy safely',
    run: () => {
      const remote = normalizeRemoteResidences({
        usa: { city: 'Denver', subdivision: 'CO' },
        canada: { city: 'Toronto', subdivision: 'ON' },
        other: { country: 'United Kingdom' },
      });
      assert(remote.usa.country === 'United States' && remote.canada.country === 'Canada', 'fixed remote countries cannot be overwritten');
      assert(hasRequiredLocations({ country: 'Canada' }, remote), 'all three residence groups make a run valid');
      assert(!hasRequiredLocations({ country: 'Canada' }, { ...remote, other: { country: 'Canada' } }), 'outside residence rejects Canada');
      const legacy = getSearchLocation({ preferredLocation: 'Toronto, Ontario, Canada' });
      assert(legacy.city === 'Toronto' && legacy.country === 'Canada', 'legacy location text migrates safely');
      return { legacy };
    },
  },
  {
    name: 'Job Search dedicated country fields resolve US/Canada aliases and cannot bypass the outside-country guard',
    run: () => {
      const usa = normalizeStructuredLocation({ country: 'U.S.' });
      const canada = normalizeStructuredLocation({ country: 'CA' });
      const can = normalizeStructuredLocation({ country: 'CAN' });
      assert(usa.country === 'United States', 'U.S. resolves in the dedicated Country field');
      assert(canada.country === 'Canada' && can.country === 'Canada', 'CA and CAN resolve to Canada in the dedicated Country field');
      const remote = normalizeRemoteResidences({ other: { country: 'CA' } });
      assert(!hasRequiredLocations({ country: 'Canada' }, remote), 'CA cannot bypass the outside-US/Canada requirement');
      assert(/other than the United States or Canada/i.test(locationValidationMessage({ country: 'Canada' }, remote)), 'outside-country validation explains the alias rejection');
      return { usa: usa.country, canada: canada.country };
    },
  },
  {
    name: 'Job Search rejects contradictory US/Canada subdivisions before a run and preserves legacy locations from empty structured shells',
    run: () => {
      const badSearch = normalizeStructuredLocation({ city: 'Denver', subdivision: 'Ontario', country: 'US' });
      assert(badSearch.countryConflict, 'Ontario + United States remains a deterministic conflict');
      const remote = normalizeRemoteResidences({
        usa: { city: 'Denver', subdivision: 'Ontario' },
        canada: { city: 'Toronto', subdivision: 'Colorado' },
        other: { country: 'United Kingdom' },
      });
      assert(remote.usa.countryConflict && remote.canada.countryConflict, 'fixed USA/Canada groups validate their subdivisions under the group country');
      assert(!hasRequiredLocations({ country: 'Canada' }, remote), 'contradictory remote residences block the run before AI work');
      assert(/Job is in USA/i.test(locationValidationMessage({ country: 'Canada' }, remote)), 'the first conflicting remote group is named in the validation error');
      const legacyShell = getSearchLocation({
        searchLocation: { city: '', subdivision: '', country: '' },
        preferredLocation: 'Toronto, Ontario, Canada',
      });
      assert(legacyShell.city === 'Toronto' && legacyShell.subdivision === 'Ontario' && legacyShell.country === 'Canada', 'empty migrated shells fall back to the old location safely');
      const legacyCanonical = normalizeStructuredLocation({ city: 'Denver', stateCode: 'CO', country: 'United States' });
      assert(legacyCanonical.subdivision === 'Colorado', 'legacy canonical stateCode retains deterministic subdivision normalization');
      const legacyString = getSearchLocation({ searchLocation: 'Denver, CO, USA' });
      assert(legacyString.city === 'Denver' && legacyString.subdivision === 'Colorado' && legacyString.country === 'United States', 'a pre-release string-shaped searchLocation remains readable');
      const canonicalObject = getSearchLocation({ canonicalLocation: { city: 'Toronto', stateCode: 'ON', country: 'Canada' } });
      assert(canonicalObject.city === 'Toronto' && canonicalObject.subdivision === 'Ontario', 'a legacy structured canonicalLocation remains readable');
      const emptyShellWithCanonical = getSearchLocation({
        searchLocation: { city: '', subdivision: '', country: '' },
        canonicalLocation: { city: 'Toronto', stateCode: 'ON', country: 'Canada' },
      });
      assert(emptyShellWithCanonical.city === 'Toronto' && emptyShellWithCanonical.subdivision === 'Ontario' && emptyShellWithCanonical.country === 'Canada', 'an empty structured shell falls through to a populated legacy canonical object');
      return { badSearch, legacyShell, legacyString, canonicalObject, emptyShellWithCanonical };
    },
  },
];
