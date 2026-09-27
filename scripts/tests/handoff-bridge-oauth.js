import fs from 'node:fs';
import { assert } from './testHelpers.js';
import CONSTANTS from '../../electron/ipc/handoffBridge/constants.js';

const metadataUrl = new URL('./fixtures/handoff-bridge/chatgpt-client-metadata.json', import.meta.url);

export default [{
  name: 'handoff bridge: oauth: client metadata and OAuth security constants are pinned',
  run: () => {
    const metadata = JSON.parse(fs.readFileSync(metadataUrl, 'utf8'));
    assert(metadata.client_id === 'https://chatgpt.com/oauth/client.json', 'client id drifted');
    assert(JSON.stringify(metadata.redirect_uris) === JSON.stringify(['https://chatgpt.com/connector_platform_oauth_redirect']), 'redirect URI drifted');
    assert(metadata.token_endpoint_auth_method === 'private_key_jwt', 'client authentication preference drifted');
    assert(JSON.stringify(metadata.token_endpoint_auth_methods_supported) === JSON.stringify(['none', 'private_key_jwt']), 'staging authentication methods drifted');
    assert(metadata.jwks_uri === CONSTANTS.JWKS_URL, 'JWKS URL must match the client document');
    assert(metadata.token_endpoint_auth_signing_alg === CONSTANTS.JWT_ALGORITHM, 'only the pinned signing algorithm is accepted');
    assert(JSON.stringify(CONSTANTS.CIMD_CLIENT_IDS) === JSON.stringify([metadata.client_id]), 'CIMD client allow-list drifted');
    assert(CONSTANTS.ACCESS_TTL_MS === 3_600_000, 'access tokens must last one hour');
    assert(CONSTANTS.REFRESH_IDLE_MS === 3 * 24 * 60 * 60_000, 'refresh idle lifetime must be three days');
    assert(CONSTANTS.REFRESH_ABSOLUTE_MS === 14 * 24 * 60 * 60_000, 'refresh absolute lifetime must be fourteen days');
    assert(CONSTANTS.ACTIVE_GRANTS_MAX_COUNT === 1 && CONSTANTS.CIMD_MAX_REDIRECTS_COUNT === 0, 'single-grant and no-redirect rules must stay closed');
  },
}];
