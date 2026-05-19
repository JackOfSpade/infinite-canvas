import React, { useState } from 'react';

/**
 * PlatformBadge — small circular brand identifier for source/platform cards.
 *
 * Prefers a locally-bundled favicon (src/assets/favicons/<domain>.png) so the
 * app renders correctly offline and doesn't depend on a third-party service
 * staying up. Falls back to the colored letter circle if no local file exists
 * for the domain or the image fails to load. Same dimensions in both states
 * so card layout never shifts.
 *
 * Adding a new platform: drop a `<domain>.png` into src/assets/favicons/ and
 * set the `domain` field on the source config in constants.js — the badge
 * picks it up automatically via Vite's glob import below.
 *
 * Used by CompSourceCardNode, JobSourceCardNode, MarketplaceCardNode.
 */

// Vite resolves these to hashed asset URLs at build time, eager so the lookup
// is synchronous and the badge never flashes a missing icon on first paint.
const FAVICON_URLS = import.meta.glob('../assets/favicons/*.png', {
  eager: true,
  query: '?url',
  import: 'default',
});

function urlForDomain(domain) {
  if (!domain) return null;
  return FAVICON_URLS[`../assets/favicons/${domain}.png`] || null;
}

export function PlatformBadge({ name, letter, color, domain, size = 24 }) {
  const [imgFailed, setImgFailed] = useState(false);
  const src = urlForDomain(domain);
  const showImg = !!src && !imgFailed;
  const dim = { width: size, height: size };

  if (showImg) {
    return (
      <div
        className="rounded-full flex items-center justify-center shrink-0 overflow-hidden bg-white"
        style={dim}
        title={name}
      >
        <img
          src={src}
          alt={name}
          width={size}
          height={size}
          onError={() => setImgFailed(true)}
          style={{ width: size, height: size, objectFit: 'contain' }}
          draggable={false}
        />
      </div>
    );
  }

  return (
    <div
      className="rounded-full flex items-center justify-center text-white font-bold shrink-0"
      style={{ ...dim, background: color, fontSize: Math.round(size * 0.42) }}
      title={name}
    >
      {letter}
    </div>
  );
}
