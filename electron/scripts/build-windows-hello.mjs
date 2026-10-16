// Build the Windows Hello addon against this shell's Electron headers and copy it to
// build/windows-hello.node, which electron-builder ships as resources/windows-hello.node.
// Windows only; elsewhere it does nothing.
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const shell = join(dirname(fileURLToPath(import.meta.url)), '..');
if (process.platform !== 'win32') {
  console.log('build:windows-hello: skipped, not Windows');
  process.exit(0);
}
const electronVersion = JSON.parse(
  readFileSync(join(shell, 'node_modules/electron/package.json'), 'utf8'),
).version;
const nodeGyp = createRequire(join(shell, 'package.json')).resolve(
  'node-gyp/bin/node-gyp.js',
);
const addon = join(shell, 'native/windows-hello');
const result = spawnSync(
  process.execPath,
  [
    nodeGyp,
    'rebuild',
    `--directory=${addon}`,
    `--target=${electronVersion}`,
    `--arch=${process.env.TRINITY_WINDOWS_HELLO_ARCH ?? 'x64'}`,
    '--dist-url=https://electronjs.org/headers',
  ],
  { stdio: 'inherit' },
);
if (result.status !== 0) process.exit(result.status ?? 1);
mkdirSync(join(shell, 'build'), { recursive: true });
copyFileSync(
  join(addon, 'build/Release/windows_hello.node'),
  join(shell, 'build/windows-hello.node'),
);
