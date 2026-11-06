# deepmerge (patched)

Upstream deepmerge 4.3.1 (MIT, https://github.com/TehShrike/deepmerge) with one change in `dist/cjs.js`: `propertyIsUnsafe` rejects the keys `__proto__`, `constructor` and `prototype`, fixing GHSA-gcqx-w48m-w2h4 / CVE-2026-93753 (unfixed upstream as of 2026-11-05).

The root `package.json` `overrides` points every `deepmerge` dependency (puppeteer-extra and its plugins) here. Remove this folder and the override once upstream releases a fixed version.
