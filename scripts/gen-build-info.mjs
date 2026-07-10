// Regenerates apps/trinity/src/app/build-info.ts from package.json + git so Settings
// can show the running build's version and commit. Run before build/serve (wired via
// the `build-info` Nx target). Idempotent: it only writes when the values change, so a
// rebuild on the same commit doesn't dirty the working tree.
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'apps/trinity/src/app/build-info.ts');

/** Render the build-info.ts source for the given values (pure). */
export function renderBuildInfo({ version, commit, builtAt }) {
  return `import { type BuildInfo } from '@trinity/platform-native';

// Generated (and git-ignored) by scripts/gen-build-info.mjs from package.json + git.
// The build/serve targets regenerate it via the \`build-info\` Nx dependency, so it is
// never committed; nothing but main.ts imports it.
export const BUILD_INFO_VALUE: BuildInfo = {
  version: '${version}',
  commit: '${commit}',
  builtAt: '${builtAt}',
};
`;
}

/** Blank out the timestamp so an unchanged version/commit doesn't count as a change. */
export function stripTimestamp(source) {
  return source.replace(/builtAt: '[^']*'/, "builtAt: ''");
}

/** The commit label: short hash (or `unknown`), suffixed `-dirty` on a modified tree. */
export function commitLabel(shortHash, porcelain) {
  return `${shortHash || 'unknown'}${porcelain ? '-dirty' : ''}`;
}

/** Default git runner: returns stdout trimmed, or '' when git isn't available. */
function runGit(root, command) {
  try {
    return execSync(command, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return '';
  }
}

/**
 * Read version + git state and (re)write `outFile` only when the version/commit changed
 * (the timestamp alone never triggers a write). `git` and `now` are injectable for tests.
 * Returns `{ version, commit, wrote }`.
 */
export function generate({
  root,
  outFile,
  git = runGit,
  now = () => new Date().toISOString(),
}) {
  const version = JSON.parse(
    readFileSync(join(root, 'package.json'), 'utf8'),
  ).version;
  const commit = commitLabel(
    git(root, 'git rev-parse --short HEAD'),
    git(root, 'git status --porcelain'),
  );
  const contents = renderBuildInfo({ version, commit, builtAt: now() });

  let current = '';
  try {
    current = readFileSync(outFile, 'utf8');
  } catch {
    // No existing file — write below.
  }
  const wrote = stripTimestamp(current) !== stripTimestamp(contents);
  if (wrote) {
    writeFileSync(outFile, contents);
  }
  return { version, commit, wrote };
}

// Run only when invoked directly (not when imported by a test).
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { version, commit, wrote } = generate({ root: ROOT, outFile: OUT });
  if (wrote) {
    console.log(`[build-info] ${version} (${commit})`);
  }
}
