import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const electronDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const require = createRequire(import.meta.url);
const nodeGyp = require.resolve('node-gyp/bin/node-gyp.js');
const result = spawnSync(
  process.execPath,
  [
    nodeGyp,
    'rebuild',
    '--directory',
    path.join(electronDir, 'native-location'),
    '--target=43.2.0',
    '--dist-url=https://electronjs.org/headers',
  ],
  { cwd: electronDir, stdio: 'inherit' },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
