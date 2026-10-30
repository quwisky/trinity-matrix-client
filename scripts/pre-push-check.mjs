#!/usr/bin/env node
/**
 * Git pre-push hook (.husky/pre-push): runs the checks lint-staged applies on commit, without
 * fixing, on the files the push adds. Rebases, cherry-picks and `--no-verify` commits skip
 * pre-commit, so this catches what they let through before CI does. `git push --no-verify` skips it.
 * Files are read from the working tree, so only the checked-out commit is checked, and only while
 * its files match HEAD.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const CHUNK = 200;
const isZero = (sha) => /^0+$/.test(sha);

/** @returns {string | null} stdout, or null when git exits non-zero */
const git = (cwd, ...args) => {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 1 << 26,
  });
  return result.status === 0 ? result.stdout : null;
};

/** One `<local ref> <local sha> <remote ref> <remote sha>` line per ref git is about to push. */
export function parsePushLines(text) {
  return text
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length === 4)
    .map(([localRef, localSha, remoteRef, remoteSha]) => ({
      localRef,
      localSha,
      remoteRef,
      remoteSha,
    }));
}

/** The commit the pushed commits start from, or null when none can be found. */
export function baseOf({ remoteSha, localSha }, cwd = process.cwd()) {
  // A fast-forward only; after a rebase and force-push the remote tip is not an ancestor and
  // diffing from it would cover everything main gained meanwhile.
  if (
    !isZero(remoteSha) &&
    git(cwd, 'merge-base', '--is-ancestor', remoteSha, localSha) !== null
  )
    return remoteSha;
  const mergeBase = git(cwd, 'merge-base', 'origin/main', localSha);
  if (mergeBase) return mergeBase.trim();
  // No origin/main: the parent of the oldest commit no remote-tracking branch has.
  const oldest = git(
    cwd,
    'rev-list',
    '--reverse',
    localSha,
    '--not',
    '--remotes',
  )?.split('\n')[0];
  return oldest ? (git(cwd, 'rev-parse', `${oldest}^`)?.trim() ?? null) : null;
}

/** Files added or changed from `base` to `localSha`; deleted files, symlinks and submodules are left out. */
export function changedFiles(base, localSha, cwd = process.cwd()) {
  const raw = git(
    cwd,
    'diff',
    '-z',
    '--raw',
    '--no-renames',
    '--diff-filter=d',
    base,
    localSha,
  );
  // Per file: `:<old mode> <new mode> <old sha> <new sha> <status>` NUL `<path>` NUL.
  const parts = (raw ?? '').split('\0');
  const files = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const mode = parts[i].split(' ')[1];
    if (mode !== '120000' && mode !== '160000') files.push(parts[i + 1]);
  }
  return files;
}

/** The lint-staged tools in check mode, each with the files it covers. */
export function plan(files) {
  return [
    { tool: 'prettier', files, args: ['--check', '--ignore-unknown'] },
    {
      tool: 'eslint',
      files: files.filter((file) =>
        /^(apps|libs|electron)\/.+\.ts$/.test(file),
      ),
      args: ['--no-warn-ignored'],
    },
    {
      tool: 'stylelint',
      files: files.filter((file) => file.endsWith('.scss')),
      args: ['--allow-empty-input'],
    },
  ].filter((check) => check.files.length > 0);
}

/** The files of `files` with staged or unstaged changes. */
function modified(files, cwd) {
  const status = git(
    cwd,
    'status',
    '--porcelain',
    '-z',
    '--no-renames',
    '--untracked-files=no',
  );
  const changed = new Set(
    (status ?? '')
      .split('\0')
      .filter(Boolean)
      .map((entry) => entry.slice(3)),
  );
  return files.filter((file) => changed.has(file));
}

export function main(stdin, cwd = process.cwd()) {
  const head = git(cwd, 'rev-parse', 'HEAD')?.trim();
  const files = new Set();
  const bases = new Set();
  for (const push of parsePushLines(stdin)) {
    if (isZero(push.localSha) || !push.remoteRef.startsWith('refs/heads/'))
      continue;
    if (push.localSha !== head) {
      console.error(
        `pre-push: ${push.localRef} is not the checked-out commit; its files are not checked.`,
      );
      continue;
    }
    const base = baseOf(push, cwd);
    if (!base) {
      console.error(
        `pre-push: no origin/main or other remote-tracking branch to compare ${push.localRef} with; its files are not checked.`,
      );
      continue;
    }
    bases.add(base);
    for (const file of changedFiles(base, push.localSha, cwd)) files.add(file);
  }
  const checks = plan([...files]);
  if (checks.length === 0) return 0;

  const dirty = modified([...files], cwd);
  if (dirty.length > 0) {
    console.error(
      `pre-push: commit or stash these first; the check reads the working tree and they differ from HEAD:\n  ${dirty.join('\n  ')}\n\nTo push anyway: git push --no-verify`,
    );
    return 1;
  }

  console.error(`pre-push: checking ${files.size} changed file(s)...`);
  let failed = false;
  for (const { tool, files: covered, args } of checks) {
    let output = '';
    let toolFailed = false;
    for (let i = 0; i < covered.length; i += CHUNK) {
      const result = spawnSync(
        join(root, 'node_modules/.bin', tool),
        [...args, '--', ...covered.slice(i, i + CHUNK)],
        { cwd, encoding: 'utf8', maxBuffer: 1 << 26 },
      );
      if (result.error) {
        console.error(
          `pre-push: could not run ${tool}: ${result.error.message} - run \`pnpm install\`; skipping ${tool} (CI still checks it).`,
        );
        break;
      }
      output += `${result.stdout}${result.stderr}`;
      toolFailed ||= result.status !== 0;
    }
    if (toolFailed) process.stderr.write(output);
    failed ||= toolFailed;
  }
  if (!failed) return 0;

  const fixes = [...bases].map(
    (base) => `pnpm exec lint-staged --diff="${base.slice(0, 12)}...HEAD"`,
  );
  console.error(
    `\npre-push: the files this push adds fail the commit-time checks (rebases, cherry-picks and\n` +
      `--no-verify commits skip pre-commit). Fix and stage them, fix what is left by hand, commit and\n` +
      `push again:\n\n  ${fixes.join('\n  ')}\n\nTo push anyway: git push --no-verify`,
  );
  return 1;
}

if (import.meta.main) process.exitCode = main(readFileSync(0, 'utf8'));
