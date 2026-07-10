// Regenerates apps/trinity/src/app/build-info.ts from package.json + git so Settings
// can show the running build's version and commit. Run before build/serve (wired via
// the `build-info` Nx target). Idempotent: it only writes when the values change, so a
// rebuild on the same commit doesn't dirty the working tree.
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'apps/trinity/src/app/build-info.ts');

const version = JSON.parse(
  readFileSync(join(ROOT, 'package.json'), 'utf8'),
).version;

function git(command) {
  try {
    return execSync(command, { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return '';
  }
}

// Append `-dirty` when there are uncommitted changes, so a build off a modified tree
// is honest about not matching the named commit.
const commit = git('git rev-parse --short HEAD') || 'unknown';
const dirty = git('git status --porcelain') ? '-dirty' : '';

const contents = `import { type BuildInfo } from '@trinity/platform-native';

// Generated (and git-ignored) by scripts/gen-build-info.mjs from package.json + git.
// The build/serve targets regenerate it via the \`build-info\` Nx dependency, so it is
// never committed; nothing but main.ts imports it.
export const BUILD_INFO_VALUE: BuildInfo = {
  version: '${version}',
  commit: '${commit}${dirty}',
  builtAt: '${new Date().toISOString()}',
};
`;

// Compare ignoring builtAt so an unchanged version/commit doesn't rewrite the file.
const stripTimestamp = (source) =>
  source.replace(/builtAt: '[^']*'/, "builtAt: ''");
let current = '';
try {
  current = readFileSync(OUT, 'utf8');
} catch {
  // No existing file — write below.
}
if (stripTimestamp(current) !== stripTimestamp(contents)) {
  writeFileSync(OUT, contents);
  console.log(`[build-info] ${version} (${commit}${dirty})`);
}
