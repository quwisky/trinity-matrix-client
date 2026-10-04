import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  backportBranch,
  backportTargets,
  cherryPickArgs,
  cherryPickOnto,
  planBackport,
} from './backport.mjs';

describe('backport', () => {
  it('reads release branches from labels', () => {
    expect(
      backportTargets([
        'bug',
        'backport release/0.1.x',
        'backport release/0.2.x',
        'backport release/0.1.x',
      ]),
    ).toEqual(['release/0.1.x', 'release/0.2.x']);
    expect(
      backportTargets([
        'backport release/0.1',
        'backport main',
        'backport release/01.1.x',
      ]),
    ).toEqual([]);
  });

  it('names the backport branch', () => {
    expect(backportBranch(42, 'release/0.1.x')).toBe(
      'backport/42-release-0.1.x',
    );
  });

  it('cherry-picks merge commits against their first parent', () => {
    expect(cherryPickArgs('abc', 1)).toEqual(['cherry-pick', '-x', 'abc']);
    expect(cherryPickArgs('abc', 2)).toEqual([
      'cherry-pick',
      '-x',
      '-m',
      '1',
      'abc',
    ]);
  });

  it('never opens a second backport', () => {
    expect(
      planBackport({
        targetExists: false,
        branchExists: false,
        existingPr: null,
      }),
    ).toBe('missing-target');
    expect(
      planBackport({ targetExists: true, branchExists: true, existingPr: 7 }),
    ).toBe('skip');
    expect(
      planBackport({
        targetExists: true,
        branchExists: true,
        existingPr: null,
      }),
    ).toBe('skip');
    expect(
      planBackport({
        targetExists: true,
        branchExists: false,
        existingPr: null,
      }),
    ).toBe('create');
  });
});

describe('cherryPickOnto', () => {
  let dir;
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: dir,
      encoding: 'utf8',
      stdio: 'pipe',
    }).trim();
  const commit = (file, text, message) => {
    writeFileSync(join(dir, file), text);
    git('add', file);
    git('commit', '-q', '-m', message);
    return git('rev-parse', 'HEAD');
  };

  /** main and release/0.1.x share a base; origin is a local bare repository. */
  const setup = () => {
    dir = mkdtempSync(join(tmpdir(), 'backport-'));
    const origin = join(dir, 'origin.git');
    const work = join(dir, 'work');
    execFileSync('git', ['init', '-q', '--bare', origin]);
    execFileSync('git', ['init', '-q', '-b', 'main', work]);
    dir = work;
    git('config', 'user.name', 't');
    git('config', 'user.email', 't@example.com');
    git('remote', 'add', 'origin', origin);
    commit('a.txt', 'base\n', 'base');
    git('branch', 'release/0.1.x');
    git('push', '-q', 'origin', 'main', 'release/0.1.x');
    return origin;
  };
  afterEach(() => rmSync(join(dir, '..'), { recursive: true, force: true }));

  it('picks cleanly onto a new branch with a provenance trailer', () => {
    setup();
    const sha = commit('b.txt', 'fix\n', 'fix: b');
    const branch = 'backport/1-release-0.1.x';
    expect(
      cherryPickOnto({ sha, target: 'release/0.1.x', branch, cwd: dir }),
    ).toBe('picked');
    expect(git('log', '-1', '--format=%B', branch)).toContain(
      `(cherry picked from commit ${sha})`,
    );
    expect(git('show', `${branch}:b.txt`)).toBe('fix');
  });

  it('reports a conflict and leaves no backport branch', () => {
    setup();
    git('switch', '-q', 'release/0.1.x');
    commit('a.txt', 'release\n', 'release change');
    git('push', '-q', 'origin', 'release/0.1.x');
    git('switch', '-q', 'main');
    const sha = commit('a.txt', 'main\n', 'main change');
    const branch = 'backport/2-release-0.1.x';
    expect(
      cherryPickOnto({ sha, target: 'release/0.1.x', branch, cwd: dir }),
    ).toBe('conflict');
    expect(git('branch', '--list', 'backport/*')).toBe('');
    expect(git('branch', '--show-current')).toBe('main');
  });
});
