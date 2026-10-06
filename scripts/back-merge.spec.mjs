import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import * as backMerge from './back-merge.mjs';
import {
  compareVersions,
  higherVersion,
  mergeNextManifest,
  planBackMerge,
  resolutionFor,
  mergeTag,
  resolveConflicts,
  withoutReleaseAs,
  leaseFor,
} from './back-merge.mjs';

const PAGE = 'apps/docs-users/src/content/docs/index.md';
const filler = (tag) =>
  Array.from({ length: 8 }, (_, i) => `${tag} line ${i}`).join('\n');
const page = (version, footer) =>
  `# Trinity\n\nVersion: ${version}\n\n${filler('body')}\n\n${footer}\n`;
const pkg = (version, dep) =>
  `{\n  "name": "trinity",\n  "version": "${version}",\n${filler('  "x')
    .split('\n')
    .map((line, i) => `${line}${i}": 1,`)
    .join('\n')}\n  "dependencies": {\n    "a": "${dep}"\n  }\n}\n`;
const manifest = (version) => `{\n  ".": "${version}"\n}\n`;

/** A real repository whose main and release lines both bump the version files. */
function conflictedRepo({ extraConflict = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'back-merge-'));
  const git = (...args) =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
  const write = (files) => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    git('add', '-A');
  };
  const commit = (message) =>
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', message);
  git('init', '-q', '-b', 'main');
  write({
    [PAGE]: page('0.1.1', 'footer'),
    'package.json': pkg('0.1.1', '1.0.0'),
    '.release-please-manifest.next.json': manifest('0.1.1'),
    'src/other.ts': 'export const a = 0;\n',
  });
  commit('base');
  git('switch', '-qc', 'release/0.1.x');
  write({
    [PAGE]: page('0.1.2', 'footer'),
    'package.json': pkg('0.1.2', '1.0.1'),
    '.release-please-manifest.next.json': manifest('0.1.2'),
    ...(extraConflict ? { 'src/other.ts': 'export const a = 1;\n' } : {}),
  });
  commit('release');
  git('switch', '-q', 'main');
  write({
    [PAGE]: page('0.1.2-next.1', 'footer from main'),
    'package.json': pkg('0.1.2-next.1', '1.0.0'),
    '.release-please-manifest.next.json': manifest('0.1.2-next.1'),
    ...(extraConflict ? { 'src/other.ts': 'export const a = 2;\n' } : {}),
  });
  commit('main');
  try {
    git(
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@t',
      'merge',
      '--no-ff',
      '--no-commit',
      'release/0.1.x',
    );
  } catch {
    // The version files conflict by design.
  }
  return { dir, read: (path) => readFileSync(join(dir, path), 'utf8') };
}

describe('back-merge', () => {
  it('resolves only the known version files', () => {
    expect(resolutionFor('CHANGELOG.md')).toBe('release');
    expect(resolutionFor('.release-please-manifest.json')).toBe('release');
    expect(resolutionFor('apps/docs-users/release.json')).toBe('release');
    expect(resolutionFor('apps/docs-users/src/content/docs/index.md')).toBe(
      'release',
    );
    expect(
      resolutionFor('apps/docs-users/src/content/docs/guide/setup.mdx'),
    ).toBe('release');
    expect(resolutionFor('package.json')).toBe('main');
    expect(resolutionFor('electron/package.json')).toBe('main');
    expect(resolutionFor('.release-please-manifest.next.json')).toBe('higher');
    for (const other of [
      'src/main.ts',
      'apps/docs-users/astro.config.mjs',
      'libs/a/package.json',
    ]) {
      expect(resolutionFor(other)).toBeNull();
    }
  });

  it('orders versions by semver precedence', () => {
    const ordered = [
      '0.1.0',
      '0.1.1-next.0',
      '0.1.1-next.3',
      '0.1.1-next.10',
      '0.1.1',
      '0.2.0-next.0',
      '0.2.0',
      '1.0.0',
    ];
    for (let i = 1; i < ordered.length; i += 1) {
      expect(compareVersions(ordered[i - 1], ordered[i])).toBe(-1);
      expect(compareVersions(ordered[i], ordered[i - 1])).toBe(1);
    }
    expect(compareVersions('0.1.1', '0.1.1')).toBe(0);
    expect(() => compareVersions('0.1', '0.1.1')).toThrow(/version/);
  });

  it('keeps main moving forward after a stable release', () => {
    expect(higherVersion('0.1.1-next.3', '0.1.1')).toBe('0.1.1');
    expect(higherVersion('0.2.0-next.0', '0.1.1')).toBe('0.2.0-next.0');
    expect(higherVersion('0.1.1', '0.1.1')).toBe('0.1.1');
    expect(
      mergeNextManifest(
        '{\n  ".": "0.1.1-next.3"\n}\n',
        '{\n  ".": "0.1.1"\n}\n',
      ),
    ).toBe('{\n  ".": "0.1.1"\n}\n');
  });

  it('plans an idempotent back-merge', () => {
    expect(planBackMerge({ mainContainsTag: true, existingPr: null })).toBe(
      'skip',
    );
    expect(planBackMerge({ mainContainsTag: true, existingPr: 12 })).toBe(
      'skip',
    );
    expect(planBackMerge({ mainContainsTag: false, existingPr: 12 })).toBe(
      'update',
    );
    expect(planBackMerge({ mainContainsTag: false, existingPr: null })).toBe(
      'create',
    );
  });

  describe('resolving conflicts in a real merge', () => {
    let repo;
    afterEach(() => rmSync(repo.dir, { recursive: true, force: true }));

    it('resolves each conflicting hunk by rule and keeps the other side elsewhere', () => {
      repo = conflictedRepo();
      const resolved = resolveConflicts('v0.1.2', repo.dir);
      expect(resolved).toEqual([
        {
          path: '.release-please-manifest.next.json',
          rule: 'higher',
          wholeFile: false,
        },
        { path: PAGE, rule: 'release', wholeFile: false },
        { path: 'package.json', rule: 'main', wholeFile: false },
      ]);
      expect(repo.read(PAGE)).toBe(page('0.1.2', 'footer from main'));
      expect(repo.read('package.json')).toBe(pkg('0.1.2-next.1', '1.0.1'));
      expect(repo.read('.release-please-manifest.next.json')).toBe(
        manifest('0.1.2'),
      );
      const unmerged = execFileSync(
        'git',
        ['diff', '--name-only', '--diff-filter=U'],
        {
          cwd: repo.dir,
          encoding: 'utf8',
        },
      );
      expect(unmerged).toBe('');
    });

    it('refuses conflicts outside the version files and lists them', () => {
      repo = conflictedRepo({ extraConflict: true });
      expect(() => resolveConflicts('v0.1.2', repo.dir)).toThrow(
        /outside the version files:\n {2}src\/other\.ts\n/,
      );
    });
  });

  describe('merging a tag', () => {
    let dir;
    afterEach(() => rmSync(dir, { recursive: true, force: true }));
    const sh = (...args) =>
      execFileSync(
        'git',
        ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args],
        {
          cwd: dir,
          encoding: 'utf8',
          stdio: 'pipe',
        },
      );
    const setup = (base, release, main) => {
      dir = mkdtempSync(join(tmpdir(), 'back-merge-'));
      sh('init', '-q', '-b', 'main');
      sh('config', 'user.name', 't');
      sh('config', 'user.email', 't@t');
      const write = (files) => {
        for (const [path, text] of Object.entries(files)) {
          mkdirSync(dirname(join(dir, path)), { recursive: true });
          writeFileSync(join(dir, path), text);
        }
        sh('add', '-A');
      };
      write(base);
      sh('commit', '-qm', 'base');
      sh('switch', '-qc', 'release/0.1.x');
      write(release.files);
      for (const path of release.remove ?? []) sh('rm', '-q', path);
      sh('commit', '-qm', 'release');
      sh('tag', 'v0.1.2');
      sh('switch', '-q', 'main');
      write(main.files);
      for (const path of main.remove ?? []) sh('rm', '-q', path);
      sh('commit', '-qm', 'main');
      sh('update-ref', 'refs/remotes/origin/main', 'main');
    };
    const read = (path) => readFileSync(join(dir, path), 'utf8');

    it("keeps main's version when the version files merge cleanly", () => {
      setup(
        {
          'package.json': pkg('0.1.1', '1.0.0'),
          'electron/package.json': pkg('0.1.1', '1.0.0'),
        },
        {
          files: {
            'package.json': pkg('0.1.2', '1.0.0'),
            'electron/package.json': pkg('0.1.2', '1.0.0'),
          },
        },
        {
          files: {
            'package.json': pkg('0.1.1', '1.0.0').replace(
              '"a": "1.0.0"',
              '"a": "1.0.9"',
            ),
            'electron/package.json': pkg('0.1.1', '1.0.0'),
          },
        },
      );
      expect(mergeTag('v0.1.2', dir)).toEqual([]);
      expect(read('package.json')).toBe(pkg('0.1.1', '1.0.9'));
      expect(read('electron/package.json')).toBe(pkg('0.1.1', '1.0.0'));
    });

    it("keeps main's version after a conflicted merge too", () => {
      setup(
        { 'package.json': pkg('0.1.1', '1.0.0') },
        { files: { 'package.json': pkg('0.1.2', '1.0.1') } },
        { files: { 'package.json': pkg('0.1.2-next.1', '1.0.0') } },
      );
      mergeTag('v0.1.2', dir);
      expect(read('package.json')).toBe(pkg('0.1.2-next.1', '1.0.1'));
    });

    it('explains a delete/modify conflict', () => {
      setup(
        { 'CHANGELOG.md': '# a\n', 'x.txt': '1\n' },
        { files: { 'CHANGELOG.md': '# b\n' } },
        { files: { 'x.txt': '2\n' }, remove: ['CHANGELOG.md'] },
      );
      expect(() => mergeTag('v0.1.2', dir)).toThrow(
        /CHANGELOG\.md.*[Mm]erge.*by hand/s,
      );
    });

    it('explains a merge that fails without conflicts', () => {
      setup(
        { 'a.txt': '1\n' },
        { files: { 'a.txt': '2\n' } },
        { files: { 'b.txt': '1\n' } },
      );
      expect(() => mergeTag('v0.1.9', dir)).toThrow(
        /merge of v0\.1\.9 failed without conflicts: .*not something we can merge/s,
      );
    });
  });

  it('leases the back-merge branch on the sha the remote has', () => {
    expect(
      leaseFor('back-merge/v0.1.2', 'abc123\trefs/heads/back-merge/v0.1.2\n'),
    ).toBe('--force-with-lease=back-merge/v0.1.2:abc123');
    expect(leaseFor('back-merge/v0.1.2', '')).toBe(
      '--force-with-lease=back-merge/v0.1.2:',
    );
  });

  it('leaves landing to land-back-merge.mjs: it never merges the PR itself', () => {
    expect(backMerge.autoMergeArgs).toBeUndefined();
  });

  it('strips the one-time release-as without reformatting the config', () => {
    // The real config's formatting, unpinned: on a release branch before its tag the file
    // already carries the one-time pin, so start from the stripped text in both states.
    const real = readFileSync(
      resolve(import.meta.dirname, '../release-please-config.json'),
      'utf8',
    );
    const config = withoutReleaseAs(real) ?? real;
    const pinned = config.replace(
      '".": {}',
      '".": {\n      "release-as": "0.2.0"\n    }',
    );
    expect(pinned).not.toBe(config);
    expect(withoutReleaseAs(pinned)).toBe(config);
    expect(withoutReleaseAs(config)).toBeNull();
  });
});
