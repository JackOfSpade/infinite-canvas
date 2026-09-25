import React from 'react';

const inputClass = 'min-w-0 px-2 bg-white/5 border border-white/10 rounded text-white/70 text-[10px] py-1 focus:outline-none focus:border-blue-400/50 placeholder:text-white/25';

function LocationInputs({ value, onChange, fixedCountry = null, countryPlaceholder = 'Country (required)', residence = false, disabled = false }) {
  const update = (field, next) => onChange?.({ ...value, [field]: next });
  const cityLabel = residence ? 'Your city while working remotely' : 'Search city';
  const subdivisionLabel = residence ? 'Your state or province while working remotely' : 'Search state or province';
  const countryLabel = residence ? 'Your country while working remotely' : 'Search country';
  return (
    <div className="grid grid-cols-2 gap-1">
      <input
        type="text"
        data-native-undo="true"
        value={value?.city || ''}
        onChange={(e) => update('city', e.target.value)}
        placeholder={residence ? 'Your city (optional)' : 'City (optional)'}
        aria-label={cityLabel}
        disabled={disabled}
        className={`${inputClass} disabled:cursor-not-allowed disabled:opacity-50`}
      />
      <input
        type="text"
        data-native-undo="true"
        value={value?.subdivision || ''}
        onChange={(e) => update('subdivision', e.target.value)}
        placeholder={residence ? 'Your state / province' : 'State / province (optional)'}
        aria-label={subdivisionLabel}
        disabled={disabled}
        className={`${inputClass} disabled:cursor-not-allowed disabled:opacity-50`}
      />
      <input
        type="text"
        data-native-undo="true"
        value={fixedCountry || value?.country || ''}
        onChange={(e) => update('country', e.target.value)}
        placeholder={countryPlaceholder}
        readOnly={!!fixedCountry}
        aria-readonly={!!fixedCountry}
        aria-label={countryLabel}
        disabled={disabled}
        className={`${inputClass} col-span-2 ${fixedCountry ? 'text-white/40 cursor-default' : ''} disabled:cursor-not-allowed disabled:opacity-50`}
      />
    </div>
  );
}

/** Compact structured locations used before a first drop and before reruns. */
export function JobSearchLocationFields({
  searchLocation,
  setSearchLocation,
  remoteResidences,
  setRemoteResidence,
  compact = false,
  disabled = false,
}) {
  return (
    <div className={`w-full flex flex-col gap-1.5 ${compact ? '' : 'text-[10px] text-white/40'}`}>
      <p className="text-[10px] text-blue-200/60 font-medium">Search location</p>
      <LocationInputs value={searchLocation} onChange={setSearchLocation} disabled={disabled} />

      <div className="pt-1 border-t border-white/5">
        <p className="text-[10px] text-blue-200/60 font-medium mb-1">Remote salary location <span className="text-white/25">(optional)</span></p>
        <p className="text-[9px] text-white/35 mb-1">Where you will live while working remotely; used only for salary comparison.</p>
        <div className="flex flex-col gap-1.5">
          <div>
            <p className="text-[9px] text-white/35 mb-0.5">U.S. employer</p>
            <LocationInputs
              value={remoteResidences?.usa}
              onChange={(next) => setRemoteResidence?.('usa', next)}
              fixedCountry="United States"
              residence
              disabled={disabled}
            />
          </div>
          <div>
            <p className="text-[9px] text-white/35 mb-0.5">Canadian employer</p>
            <LocationInputs
              value={remoteResidences?.canada}
              onChange={(next) => setRemoteResidence?.('canada', next)}
              fixedCountry="Canada"
              residence
              disabled={disabled}
            />
          </div>
          <div>
            <p className="text-[9px] text-white/35 mb-0.5">Other / worldwide employer</p>
            <LocationInputs
              value={remoteResidences?.other}
              onChange={(next) => setRemoteResidence?.('other', next)}
              countryPlaceholder="Your country (optional)"
              residence
              disabled={disabled}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
