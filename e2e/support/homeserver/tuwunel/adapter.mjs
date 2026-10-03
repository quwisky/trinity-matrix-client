// Tuwunel adapter: committed TOML config (tuwunel.toml, tuwunel-remote.toml) and the
// compose services in docker-compose.yml beside this file. start.mjs drives readiness
// and registration, which Tuwunel serves at the same endpoints as Synapse.
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DATA, REMOTE_DATA, STATE_DIR } from '../paths.mjs';

const CONFIG_FILES = ['tuwunel/tuwunel.toml', 'tuwunel/tuwunel-remote.toml'];

export const tuwunel = {
  kind: 'tuwunel',
  configFiles: CONFIG_FILES,
  mountedConfig: {
    homeserver: join(STATE_DIR, CONFIG_FILES[0]),
    'homeserver-remote': join(STATE_DIR, CONFIG_FILES[1]),
  },
  // The primary lives in Dex's network namespace; restarting Dex takes its network away.
  restartWith: { dex: ['homeserver'] },
  async prepare() {
    // Created here, as us: the daemon would create a missing bind source as root, and the
    // container (running as us) could then not open its database.
    await Promise.all([
      mkdir(join(DATA, 'tuwunel'), { recursive: true }),
      mkdir(join(REMOTE_DATA, 'tuwunel'), { recursive: true }),
    ]);
  },
};
