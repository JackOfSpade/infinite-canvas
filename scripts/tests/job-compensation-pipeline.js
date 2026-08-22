import { assert } from '../test-dependencies.js';
import {
  parseGuaranteedCashOffer,
  mergeCompetitiveRanges,
  compensationAssessment,
  resolveCompensationLocation,
  compensationCohortKey,
  isAuditableCompensationSource,
  selectComparableEvidence,
} from '../../electron/ipc/jobCompensation.js';

export default [{
  name: 'Cash compensation parsing, source union, and exact market-floor verdict',
  run: () => {
    const canadian = parseGuaranteedCashOffer({ salary: 'C$70,000–C$95,000 per year' });
    assert(canadian.usable && canadian.max === 95000 && canadian.currency === 'CAD', 'must parse annual stated cash range');
    const oneSymbolRange = parseGuaranteedCashOffer({ salary: '$80,000–100,000 per year', location: 'Austin, Texas, USA' });
    assert(oneSymbolRange.usable && oneSymbolRange.min === 80000 && oneSymbolRange.max === 100000, 'one currency symbol must still preserve both range endpoints');
    const shorthandRange = parseGuaranteedCashOffer({ salary: '$80–100k per year', location: 'Austin, Texas, USA' });
    assert(shorthandRange.usable && shorthandRange.min === 80000 && shorthandRange.max === 100000, 'a shared k suffix must apply to both range endpoints');
    assert(!parseGuaranteedCashOffer({ salary: 'Commission only, uncapped earnings' }).usable, 'variable-only pay cannot be evaluated');
    assert(!parseGuaranteedCashOffer({ salary: 'Equity worth $100k' }).usable, 'equity cannot be converted into guaranteed cash');
    const baseOnly = parseGuaranteedCashOffer({ salary: '$150k OTE, base salary $80k', location: 'Austin, Texas, USA' });
    assert(baseOnly.usable && baseOnly.min === 80000 && baseOnly.max === 80000, 'OTE must not inflate a separately stated base salary');
    const trailingBase = parseGuaranteedCashOffer({ salary: '$80k–$100k base salary + bonus', location: 'Austin, Texas, USA' });
    assert(trailingBase.usable && trailingBase.min === 80000 && trailingBase.max === 100000, 'a base marker after the range must retain both base endpoints');
    const leadingBase = parseGuaranteedCashOffer({ salary: 'Base salary $80k–$100k + bonus', location: 'Austin, Texas, USA' });
    assert(leadingBase.usable && leadingBase.min === 80000 && leadingBase.max === 100000, 'a base marker before the range must retain both base endpoints');
    const trailingOte = parseGuaranteedCashOffer({ salary: 'Base salary $80k, $150k OTE', location: 'Austin, Texas, USA' });
    assert(trailingOte.usable && trailingOte.min === 80000 && trailingOte.max === 80000, 'an OTE label after its amount must not inflate base pay');
    const totalComp = parseGuaranteedCashOffer({ salary: 'Total compensation $150k, base salary $100k', location: 'Austin, Texas, USA' });
    assert(totalComp.usable && totalComp.max === 100000, 'total compensation cannot inflate a separately stated base salary');
    for (const salary of [
      'Commission plus base salary $80k',
      'commission + $80k base salary',
      'base salary $80k and commission',
      'commission + base salary $80k + $20k bonus',
    ]) {
      const mixedPay = parseGuaranteedCashOffer({ salary, location: 'Austin, Texas, USA' });
      assert(mixedPay.usable && mixedPay.min === 80000 && mixedPay.max === 80000,
        `a stated base must survive variable-pay wording on either side: ${salary}`);
    }
    const hourlyBase = parseGuaranteedCashOffer({ salary: 'base pay $45/hour plus commission', description: '40 hours per week', location: 'Austin, Texas, USA' });
    assert(hourlyBase.usable && hourlyBase.max === 93600 && hourlyBase.annualized, 'an extracted base hourly rate must retain its cadence');
    const weeklyBase = parseGuaranteedCashOffer({ salary: 'base pay $2,000/week + bonus', location: 'Austin, Texas, USA' });
    assert(weeklyBase.usable && weeklyBase.max === 104000 && weeklyBase.annualized, 'an extracted base weekly rate must retain its cadence');
    const monthlyBase = parseGuaranteedCashOffer({ salary: 'base salary $8,000/month + equity', location: 'Austin, Texas, USA' });
    assert(monthlyBase.usable && monthlyBase.max === 96000 && monthlyBase.annualized, 'an extracted base monthly rate must retain its cadence');
    for (const salary of ['from $80k', 'minimum $80k', 'starting salary $80k']) {
      assert(parseGuaranteedCashOffer({ salary, location: 'Austin, Texas, USA' }).reasonCode === 'salary_maximum_unstated',
        `a one-sided lower bound cannot be treated as a fixed offer: ${salary}`);
    }
    assert(parseGuaranteedCashOffer({ salary: 'up to $100k', location: 'Austin, Texas, USA' }).max === 100000,
      'an explicit upper bound remains usable for the maximum-vs-floor comparison');
    const bareAnnual = parseGuaranteedCashOffer({ salary: 'Salary: 100000 per year', location: 'Austin, Texas, USA' });
    assert(bareAnnual.usable && bareAnnual.max === 100000 && bareAnnual.currency === 'USD', 'a single annual number uses the unambiguous comparison-location currency');
    const fallbackCompensation = parseGuaranteedCashOffer({ salary: '   ', compensation: '$90k/year', location: 'Austin, Texas, USA' });
    assert(fallbackCompensation.usable && fallbackCompensation.max === 90000, 'a blank primary salary field must not hide a scraper compensation fallback');
    assert(parseGuaranteedCashOffer({ salary: '$45/hour', description: 'Part-time flexible' }).reasonCode === 'hourly_hours_unclear', 'must not invent annual hours');
    assert(parseGuaranteedCashOffer({ salary: '$45/hour', description: 'Full-time, 40 hours per week', location: 'Austin, Texas, USA' }).max === 93600, 'known full-time hourly pay annualizes deterministically');
    const merged = mergeCompetitiveRanges([
      { min: 100000, max: 130000, currency: 'CAD' },
      { min: '85000', max: '115000', currency: ' cad ' },
    ], 'CAD');
    assert(merged.min === 85000 && merged.max === 130000 && merged.currency === 'CAD', 'conflicting comparable sources must union A–D despite normalized currency/numeric strings');
    assert(mergeCompetitiveRanges([{ min: 85000, max: 110000, currency: '' }], 'CAD') === null,
      'market evidence with no currency cannot be treated as the listing currency');
    assert(isAuditableCompensationSource({ sourceName: 'Survey', sourceUrl: 'https://example.test/pay' }), 'an http(s) source with a title is auditable');
    assert(!isAuditableCompensationSource({ sourceName: 'Survey', sourceUrl: 'file:///etc/passwd' }) && !isAuditableCompensationSource({ min: 1, max: 2 }), 'unlinked or unsafe source evidence cannot drive a verdict');
    const evidence = [
      { comparable: true, min: 100000, max: 120000, sourceName: 'one', sourceUrl: 'https://example.test/one' },
      { comparable: true, min: 95000, max: 125000, sourceName: 'two', sourceUrl: 'https://example.test/two' },
      { comparable: true, min: 80000, max: 110000, sourceName: 'floor', sourceUrl: 'https://example.test/floor' },
      { comparable: true, min: 110000, max: 180000, sourceName: 'ceiling', sourceUrl: 'https://example.test/ceiling' },
      { comparable: true, min: 105000, max: 130000, sourceName: 'five', sourceUrl: 'https://example.test/five' },
      { comparable: true, min: 101000, max: 121000, sourceName: 'six', sourceUrl: 'https://example.test/six' },
    ];
    const displayedEvidence = selectComparableEvidence(evidence, 5);
    assert(displayedEvidence.length === 5 && displayedEvidence.some(item => item.sourceName === 'floor') && displayedEvidence.some(item => item.sourceName === 'ceiling'),
      'the capped card evidence must retain the ranges that set the merged floor and ceiling');
    const currencyCompetition = [
      { comparable: true, min: 1, max: 999999, currency: 'USD', sourceName: 'wrong floor', sourceUrl: 'https://example.test/us-floor' },
      { comparable: true, min: 2, max: 1000000, currency: 'EUR', sourceName: 'wrong ceiling', sourceUrl: 'https://example.test/eur-ceiling' },
      ...Array.from({ length: 6 }, (_unused, index) => ({
        comparable: true, min: 85000 + index * 1000, max: 105000 + index * 1000, currency: ' cad ',
        sourceName: `cad-${index}`, sourceUrl: `https://example.test/cad-${index}`,
      })),
    ];
    const cadEvidence = selectComparableEvidence(currencyCompetition, 5, 'CAD');
    assert(cadEvidence.length === 5 && cadEvidence.every(item => item.currency.trim().toUpperCase() === 'CAD'),
      'wrong-currency extrema must not consume capped target-currency evidence slots');
    assert(compensationAssessment({ offer: canadian, competitiveRanges: [merged] }).status === 'competitive', 'offer maximum reaching floor is competitive');
    assert(compensationAssessment({ offer: { ...canadian, max: 84999 }, competitiveRanges: [merged] }).status === 'below_market', 'no hidden buffer below floor');
    const withEvidence = compensationAssessment({
      offer: canadian,
      competitiveRanges: [merged],
      sourceLinks: [{ title: 'Salary survey', url: 'https://example.test/pay', min: 85000, max: 130000, currency: 'CAD', note: 'Senior role in Toronto.' }],
    });
    assert(withEvidence.sourceLinks[0]?.note === 'Senior role in Toronto.' && withEvidence.justification.includes('reaches or exceeds'), 'auditable source details and deterministic verdict must be retained');
    const loc = resolveCompensationLocation({}, { workMode: 'remote', remoteRegion: 'canada' }, { canada: { city: 'Toronto', subdivision: 'Ontario', country: 'Canada' } });
    assert(loc?.display === 'Toronto, Ontario, Canada', 'remote Canada work uses Canada residence');
    const inferredRemote = resolveCompensationLocation(
      { remote: true, location: 'Remote' },
      { workMode: 'unknown', remoteRegion: 'unknown', remoteCountry: 'United States' },
      { usa: { city: 'Denver', subdivision: 'Colorado', country: 'United States' } },
    );
    assert(inferredRemote?.display === 'Denver, Colorado, United States', 'an explicit permitted country repairs an unknown remote-region classification');
    assert(resolveCompensationLocation(
      { remote: true, location: 'Remote' },
      { workMode: 'remote', remoteRegion: 'other', remoteCountry: 'Germany' },
      { other: { city: 'London', subdivision: 'England', country: 'United Kingdom' } },
    ) === null, 'an incompatible other-country residence must stay uncertain');
    const cohortCommon = { job: { title: 'Senior Designer' }, location: loc, offer: canadian };
    assert(compensationCohortKey({ ...cohortCommon, context: { seniority: 'senior', requiredYears: '3 years' } })
      !== compensationCohortKey({ ...cohortCommon, context: { seniority: 'senior', requiredYears: '8 years' } }),
    'different experience asks cannot share a cached compensation cohort');
    return { unionFloor: merged.min };
  },
}];
