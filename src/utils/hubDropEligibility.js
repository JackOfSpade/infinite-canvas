const ACTIVE_INPUT_STATES = new Set([
  'analyzing',
  'parsing',
  'querying',
  'researching',
  'scoring',
  'scoring-batch',
  'searching',
]);

function hasItems(value) {
  return Array.isArray(value) && value.some(Boolean);
}

export function hubHasAcceptedInitialDrop(hub) {
  const data = hub?.data || {};
  if (data.inputLocked) return true;

  if (hub?.type === 'jobhub') {
    return !!(
      data.careerData ||
      data.resumeProfile ||
      data.filePath ||
      hasItems(data.filePaths) ||
      hasItems(data.careerFilePaths)
    );
  }

  if (hub?.type === 'sellhub') {
    return !!(data.product || hasItems(data.imagePaths));
  }

  return false;
}

export function canSellHubReplaceFailedInitialPhotos(hub) {
  if (!hub || hub.type !== 'sellhub') return false;
  const data = hub.data || {};
  return !!(
    !data.locked &&
    (data.hubState || 'empty') === 'empty' &&
    data.errorMessage &&
    !data.product
  );
}

export function getHubDropLockReason(hub) {
  if (!hub) return 'missing';
  if (hub.type !== 'jobhub' && hub.type !== 'sellhub') return 'unsupported';

  const data = hub.data || {};
  if (data.locked) return 'locked';

  const hubState = data.hubState || 'empty';
  if (ACTIVE_INPUT_STATES.has(hubState)) return 'busy';
  if (canSellHubReplaceFailedInitialPhotos(hub)) return null;
  if (hubHasAcceptedInitialDrop(hub)) return 'started';
  if (hubState !== 'empty') return 'started';

  return null;
}

export function canHubAcceptInitialDrop(hub) {
  return getHubDropLockReason(hub) === null;
}

export function canSellHubAcceptDisplayPhotoDrop(hub) {
  if (!hub || hub.type !== 'sellhub') return false;
  const data = hub.data || {};
  if (data.locked) return false;
  return (data.hubState || 'empty') === 'priced';
}

export function getHubFileDropMode(hub) {
  if (canSellHubAcceptDisplayPhotoDrop(hub)) return 'display-photos';
  if (canHubAcceptInitialDrop(hub)) return 'initial-input';
  return null;
}

export function getHubDropRejectLabel(hub) {
  switch (getHubDropLockReason(hub)) {
    case 'locked':
      return 'Locked';
    case 'busy':
      return 'Busy';
    case 'started':
      return 'Already started';
    case 'missing':
    case 'unsupported':
      return 'Unsupported target';
    default:
      return null;
  }
}
