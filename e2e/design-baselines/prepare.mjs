import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const captureRoot = resolve(
  root,
  'dist/.playwright/current-baselines/captures',
);
const trackedStatus = execFileSync(
  'git',
  ['status', '--porcelain=v1', '--untracked-files=no'],
  { cwd: root, encoding: 'utf8' },
).trim();

if (trackedStatus) {
  throw new Error(
    'Current-interface evidence requires a clean tracked worktree. Commit or restore tracked changes before capturing.',
  );
}

const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: root,
  encoding: 'utf8',
}).trim();
const sourceTree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], {
  cwd: root,
  encoding: 'utf8',
}).trim();

rmSync(captureRoot, { force: true, recursive: true });
mkdirSync(captureRoot, { recursive: true });
writeFileSync(
  join(captureRoot, 'capture-provenance.json'),
  `${JSON.stringify(
    {
      sourceCommit,
      sourceTree,
      capturedAt: new Date().toISOString(),
      trackedWorktreeClean: true,
    },
    null,
    2,
  )}\n`,
);
