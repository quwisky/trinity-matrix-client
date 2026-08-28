import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

function run(command, args, environment = {}) {
  const result = spawnSync(command, args, {
    cwd: workspaceRoot,
    env: { ...process.env, ...environment },
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (process.env['TRINITY_E2E_PREBUILT_WWW']) {
  run(process.execPath, [
    'scripts/web-bundle-manifest.mjs',
    'verify',
    'dist/web-bundle-manifest.json',
    'www',
  ]);
} else {
  run(pnpm, ['run', 'build']);
  run(process.execPath, ['scripts/web-bundle-manifest.mjs', 'write', 'www']);
}

run(
  pnpm,
  [
    'exec',
    'playwright',
    'test',
    '-c',
    'e2e/playwright.phase7.config.mts',
    ...process.argv.slice(2),
  ],
  { TRINITY_E2E_PREBUILT_WWW: '1' },
);
