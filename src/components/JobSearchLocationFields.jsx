import React from 'react';

const inputClass = 'min-w-0 px-2 bg-white/5 border border-white/10 rounded text-white/70 text-[10px] py-1 focus:outline-none focus:border-blue-400/50 placeholder:text-white/25';

function LocationInputs({ value, onChange, fixedCountry = null, countryPlaceholder = 'Country (required)' }) {
  const update = (field, next) => onChange?.({ ...value, [field]: next });
  return (
    <div className="grid grid-cols-2 gap-1">
      <input
        type="text"
        data-native-undo="true"
        value={value?.city || ''}
        onChange={(e) => update('city', e.target.value)}
        placeholder="City (optional)"
        className={inputClass}
      />
      <input
        type="text"
        data-native-undo="true"
        value={value?.subdivision || ''}
        onChange={(e) => update('subdivision', e.target.value)}
        placeholder="State / province (optional)"
        className={inputClass}
      />
      <input
        type="text"
        data-native-undo="true"
        value={fixedCountry || value?.country || ''}
        onChange={(e) => update('country', e.target.value)}
        placeholder={countryPlaceholder}
        readOnly={!!fixedCountry}
        aria-readonly={!!fixedCountry}
        className={`${inputClass} col-span-2 ${fixedCountry ? 'text-white/40 cursor-default' : ''}`}
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
}) {
  return (
    <div className={`w-full flex flex-col gap-1.5 ${compact ? '' : 'text-[10px] text-white/40'}`}>
      <p className="text-[10px] text-blue-200/60 font-medium">Search location</p>
      <LocationInputs value={searchLocation} onChange={setSearchLocation} />

      <div className="pt-1 border-t border-white/5">
        <p className="text-[10px] text-blue-200/60 font-medium mb-1">Where would you live while working remotely?</p>
        <div className="flex flex-col gap-1.5">
          <div>
            <p className="text-[9px] text-white/35 mb-0.5">Job is in USA</p>
            <LocationInputs
              value={remoteResidences?.usa}
              onChange={(next) => setRemoteResidence?.('usa', next)}
              fixedCountry="United States"
            />
          </div>
          <div>
            <p className="text-[9px] text-white/35 mb-0.5">Job is in Canada</p>
            <LocationInputs
              value={remoteResidences?.canada}
              onChange={(next) => setRemoteResidence?.('canada', next)}
              fixedCountry="Canada"
            />
          </div>
          <div>
            <p className="text-[9px] text-white/35 mb-0.5">Job is outside US/Canada</p>
            <LocationInputs
              value={remoteResidences?.other}
              onChange={(next) => setRemoteResidence?.('other', next)}
              countryPlaceholder="Country (required; not US or Canada)"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
