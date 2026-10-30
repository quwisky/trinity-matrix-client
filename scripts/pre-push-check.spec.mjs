import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, posix } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  baseOf,
  changedFiles,
  parsePushLines,
  plan,
} from './pre-push-check.mjs';

const script = join(import.meta.dirname, 'pre-push-check.mjs');
const ZERO = '0'.repeat(40);
const FORMATTED = '{ "a": 1 }\n';
const UNFORMATTED = '{"a":1}\n';
const repo = mkdtempSync(join(tmpdir(), 'pre-push-check-'));
const git = (...args) =>
  execFileSync(
    'git',
    [
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@t',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { cwd: repo, encoding: 'utf8', stdio: 'pipe' },
  ).trim();

function commit(message, { write = {}, remove = [], links = {} }) {
  for (const [path, text] of Object.entries(write)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  for (const [path, target] of Object.entries(links))
    symlinkSync(target, join(repo, path));
  for (const path of remove) unlinkSync(join(repo, path));
  git('add', '-A');
  git('commit', '-q', '-m', message);
  return git('rev-parse', 'HEAD');
}

const line = (localSha, remoteSha, ref = 'refs/heads/topic') =>
  `${ref} ${localSha} ${ref} ${remoteSha}\n`;
const hook = (input, entry = script) =>
  spawnSync(process.execPath, [entry], { cwd: repo, encoding: 'utf8', input });
/** Runs the hook for a branch moving `remoteSha` -> `localSha`, which is checked out first. */
const push = (localSha, remoteSha) => {
  git('checkout', '-q', '--detach', localSha);
  return hook(line(localSha, remoteSha));
};
const withRefs = (fn) => {
  try {
    fn();
  } finally {
    git('reset', '-q', '--hard');
    git('update-ref', '-d', 'refs/remotes/upstream/dev');
    git('update-ref', 'refs/remotes/origin/main', base);
  }
};

let base;
let clean;
let broken;
let pruned;
let lint;

beforeAll(() => {
  git('init', '-q');
  base = commit('base', {
    write: {
      'a.json': FORMATTED,
      'gone.json': UNFORMATTED,
      'untouched.json': FORMATTED,
      'eslint.config.mjs':
        "export default [{ files: ['**/*.ts'], rules: { 'no-debugger': 'error' } }];\n",
      '.stylelintrc.json': '{ "rules": { "property-no-unknown": true } }\n',
    },
  });
  git('update-ref', 'refs/remotes/origin/main', base);
  clean = commit('clean', {
    write: {
      'a.json': '{ "a": 2 }\n',
      'blob.unknown': '<<{ not a language\n',
      '-dash.json': FORMATTED,
      "it's.json": FORMATTED,
    },
    links: { 'link.json': 'a.json' },
    remove: ['gone.json'],
  });
  broken = commit('broken', { write: { 'bad dir/bad.json': UNFORMATTED } });
  pruned = commit('prune', { remove: ['bad dir/bad.json'] });
  lint = commit('lint', {
    write: {
      'libs/x/bad.ts': 'debugger;\n',
      'libs/x/bad.scss': 'a {\n  colour: red;\n}\n',
    },
  });
});

afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe('parsePushLines', () => {
  it('reads new-branch, update and deletion lines', () => {
    const lines = parsePushLines(
      [
        `refs/heads/new aaa refs/heads/new ${ZERO}`,
        'refs/heads/up bbb refs/heads/up ccc',
        `(delete) ${ZERO} refs/heads/old ddd`,
        '',
      ].join('\n'),
    );
    expect(lines).toEqual([
      {
        localRef: 'refs/heads/new',
        localSha: 'aaa',
        remoteRef: 'refs/heads/new',
        remoteSha: ZERO,
      },
      {
        localRef: 'refs/heads/up',
        localSha: 'bbb',
        remoteRef: 'refs/heads/up',
        remoteSha: 'ccc',
      },
      {
        localRef: '(delete)',
        localSha: ZERO,
        remoteRef: 'refs/heads/old',
        remoteSha: 'ddd',
      },
    ]);
  });
});

describe('baseOf', () => {
  it('starts an update at the remote tip', () => {
    expect(baseOf({ localSha: clean, remoteSha: base }, repo)).toBe(base);
  });

  it('starts a new branch at the merge-base with origin/main', () => {
    expect(baseOf({ localSha: broken, remoteSha: ZERO }, repo)).toBe(base);
  });

  it('ignores a remote tip that is not an ancestor, as after a rebase and force-push', () => {
    withRefs(() => {
      git('checkout', '-q', '--detach', base);
      const before = commit('topic', { write: { 'topic.json': FORMATTED } });
      git('checkout', '-q', '--detach', base);
      const main = commit('main churn', {
        write: { 'churn.json': UNFORMATTED },
      });
      git('update-ref', 'refs/remotes/origin/main', main);
      git('checkout', '-q', '--detach', main);
      const after = commit('topic', { write: { 'topic.json': FORMATTED } });
      expect(baseOf({ localSha: after, remoteSha: before }, repo)).toBe(main);
      expect(changedFiles(main, after, repo)).toEqual(['topic.json']);
      expect(push(after, before).status).toBe(0);
    });
  });

  it('falls back to the commits no remote-tracking branch has', () => {
    withRefs(() => {
      git('update-ref', '-d', 'refs/remotes/origin/main');
      git('update-ref', 'refs/remotes/upstream/dev', clean);
      expect(baseOf({ localSha: broken, remoteSha: ZERO }, repo)).toBe(clean);
    });
  });

  it('finds none when nothing has been pushed anywhere', () => {
    withRefs(() => {
      git('update-ref', '-d', 'refs/remotes/origin/main');
      expect(baseOf({ localSha: broken, remoteSha: ZERO }, repo)).toBeNull();
    });
  });
});

describe('changedFiles', () => {
  it('lists what the commits add or change, without deleted files or symlinks', () => {
    expect(changedFiles(base, clean, repo).sort()).toEqual([
      '-dash.json',
      'a.json',
      'blob.unknown',
      "it's.json",
    ]);
    expect(changedFiles(clean, broken, repo)).toEqual(['bad dir/bad.json']);
  });
});

describe('plan', () => {
  it('sends each tool only the files it covers', () => {
    const files = ['apps/x/a.ts', 'libs/y/b.scss', 'tools/c.ts', 'd.json'];
    expect(
      plan(files).map(({ tool, files: covered }) => [tool, covered]),
    ).toEqual([
      ['prettier', files],
      ['eslint', ['apps/x/a.ts']],
      ['stylelint', ['libs/y/b.scss']],
    ]);
  });
});

describe('parity with lint-staged', () => {
  const config = JSON.parse(
    readFileSync(join(import.meta.dirname, '..', '.lintstagedrc.json'), 'utf8'),
  );
  // lint-staged matches a glob without a slash against the file name, at any depth
  const lintStaged = (path) =>
    Object.entries(config)
      .filter(([glob]) =>
        posix.matchesGlob(glob.includes('/') ? path : basename(path), glob),
      )
      .flatMap(([, tasks]) => [tasks].flat().map((task) => task.split(' ')[0]));
  const samples = [
    'apps/a/b.ts',
    'libs/x/y/z.ts',
    'electron/main.ts',
    'capacitor.config.ts',
    'e2e/a.ts',
    'tools/b.ts',
    'libs/c.scss',
    'styles.scss',
    'a.json',
    'README.md',
    'x.mjs',
    'y.yml',
    'index.html',
    'z.css',
    'b.png',
  ];

  it('runs only tools the hook knows', () => {
    const tools = new Set(
      Object.values(config).flatMap((tasks) =>
        [tasks].flat().map((task) => task.split(' ')[0]),
      ),
    );
    expect([...tools].sort()).toEqual(['eslint', 'prettier', 'stylelint']);
  });

  it.each(samples)(
    'checks %s with the tools lint-staged runs on it',
    (path) => {
      const hookTools = plan([path]).map(({ tool }) => tool);
      const stagedTools = lintStaged(path);
      for (const tool of ['eslint', 'stylelint'])
        expect(hookTools.includes(tool)).toBe(stagedTools.includes(tool));
      // The hook also formats what lint-staged leaves alone, as CI's format check does.
      if (stagedTools.includes('prettier'))
        expect(hookTools).toContain('prettier');
    },
  );
});

describe('pre-push hook', () => {
  it('passes a clean push; deleted, symlinked and unknown files and odd names are fine', () => {
    const result = push(clean, base);
    expect(result.stderr).not.toMatch(/fail|could not/);
    expect(result.status).toBe(0);
  });

  it('fails a mis-formatted file with the fix command and the bypass', () => {
    const result = push(broken, clean);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('bad dir/bad.json');
    expect(result.stderr).toContain(
      `pnpm exec lint-staged --diff="${clean.slice(0, 12)}...HEAD"`,
    );
    expect(result.stderr).toContain('git push --no-verify');
  });

  it('passes once the offending file is deleted', () => {
    expect(push(pruned, base).status).toBe(0);
  });

  it('runs eslint and stylelint on the files they cover', () => {
    const result = push(lint, pruned);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('libs/x/bad.ts');
    expect(result.stderr).toContain('no-debugger');
    expect(result.stderr).toContain('libs/x/bad.scss');
    expect(result.stderr).toContain('property-no-unknown');
  });

  it('blocks on a pushed file that differs from HEAD, but not on an unrelated one', () => {
    withRefs(() => {
      git('checkout', '-q', '--detach', clean);
      writeFileSync(join(repo, 'untouched.json'), UNFORMATTED);
      expect(hook(line(clean, base)).status).toBe(0);
      writeFileSync(join(repo, 'a.json'), FORMATTED);
      const unstaged = hook(line(clean, base));
      expect(unstaged.status).toBe(1);
      expect(unstaged.stderr).toContain('commit or stash these first');
      expect(unstaged.stderr).toContain('a.json');
      expect(unstaged.stderr).not.toContain('untouched.json');
      git('add', 'a.json');
      expect(hook(line(clean, base)).stderr).toContain(
        'commit or stash these first',
      );
    });
  });

  it('skips a tool it cannot run, with a note', () => {
    const lonely = mkdtempSync(join(tmpdir(), 'pre-push-lonely-'));
    try {
      mkdirSync(join(lonely, 'scripts'));
      copyFileSync(script, join(lonely, 'scripts/pre-push-check.mjs'));
      git('checkout', '-q', '--detach', broken);
      const result = hook(
        line(broken, clean),
        join(lonely, 'scripts/pre-push-check.mjs'),
      );
      expect(result.status).toBe(0);
      expect(result.stderr).toContain('could not run prettier');
      expect(result.stderr).toContain('pnpm install');
    } finally {
      rmSync(lonely, { recursive: true, force: true });
    }
  });

  it('says so when it has nothing to compare a new branch with', () => {
    withRefs(() => {
      git('update-ref', '-d', 'refs/remotes/origin/main');
      git('checkout', '-q', '--detach', broken);
      const result = hook(line(broken, ZERO));
      expect(result.status).toBe(0);
      expect(result.stderr).toContain('no origin/main');
    });
  });

  it('checks the checked-out ref, notes another, and ignores deletions and tags', () => {
    git('checkout', '-q', '--detach', broken);
    const result = hook(
      line(broken, clean) +
        line(clean, base, 'refs/heads/other') +
        line(broken, ZERO, 'refs/tags/v1') +
        `(delete) ${ZERO} refs/heads/old ${base}\n`,
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('bad dir/bad.json');
    expect(result.stderr).toContain(
      'refs/heads/other is not the checked-out commit',
    );
    expect(result.stderr).not.toContain('refs/tags');
    expect(hook(`(delete) ${ZERO} refs/heads/old ${base}\n`).status).toBe(0);
  });
});
