export const COMP_SOURCE_LOGIN_PLATFORM = {
  'ebay-sold': 'ebay',
  'ebay-active': 'ebay',
  poshmark: 'poshmark',
  mercari: 'mercari',
  swappa: 'swappa',
  'swappa-sold': 'swappa',
};

export function getRequiredCompLoginPlatformIds(sources = []) {
  return [...new Set(
    (Array.isArray(sources) ? sources : [])
      .map(source => COMP_SOURCE_LOGIN_PLATFORM[typeof source === 'string' ? source : source?.id])
      .filter(Boolean),
  )];
}
