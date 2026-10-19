// Tuwunel OAuth adapter (TRINITY_E2E_HOMESERVER=tuwunel-oauth): ../tuwunel with the
// built-in OAuth server and QR sign-in instead of Dex SSO. Tuwunel serves the same
// readiness and registration endpoints, so only the config and compose file differ.
import { tuwunel } from '../tuwunel/adapter.mjs';
import { STATE_DIR } from '../paths.mjs';
import { join } from 'node:path';

const CONFIG_FILES = [
  'tuwunel-oauth/tuwunel.toml',
  'tuwunel/tuwunel-remote.toml',
];

export const tuwunelOauth = {
  ...tuwunel,
  kind: 'tuwunel-oauth',
  /** The `server.name` /_matrix/federation/v1/version reports. */
  software: 'tuwunel',
  /** No identity provider: start.mjs skips the Dex polls and lists `sso` as unavailable. */
  sso: false,
  configFiles: CONFIG_FILES,
  mountedConfig: {
    homeserver: join(STATE_DIR, CONFIG_FILES[0]),
    'homeserver-remote': join(STATE_DIR, CONFIG_FILES[1]),
  },
  // The primary no longer lives in Dex's network namespace.
  restartWith: {},
};
