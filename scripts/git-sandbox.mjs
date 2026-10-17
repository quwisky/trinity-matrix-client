import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * A throwaway repository on `main` committing as t <t@t>. With `bare`, `dir` is a clone of an
 * empty bare `origin` (also on `main`); `root` holds both and is what `cleanup` removes.
 */
export function gitSandbox({ prefix = 'git-sandbox-', bare = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const origin = join(root, 'origin.git');
  const dir = bare ? join(root, 'work') : root;
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: dir,
      encoding: 'utf8',
      stdio: 'pipe',
    }).trim();
  if (bare) {
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
    execFileSync('git', ['clone', '-q', origin, dir], { stdio: 'pipe' });
  } else {
    git('init', '-q', '-b', 'main');
  }
  git('config', 'user.name', 't');
  git('config', 'user.email', 't@t');
  /** Writes the files (creating directories) and stages everything. */
  const write = (files) => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    git('add', '-A');
  };
  /** Commits what is staged; returns the new HEAD sha. */
  const commit = (message) => {
    git('commit', '-qm', message);
    return git('rev-parse', 'HEAD');
  };
  const cleanup = () => rmSync(root, { recursive: true, force: true });
  return { root, origin, dir, git, write, commit, cleanup };
}
