import { execFileSync } from 'node:child_process';
import {
  existsSync,
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
  metadataPaths,
  cutPrerelease,
  buildBackMerge,
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

const CHANGELOG = (...versions) =>
  `# Changelog\n\n${versions.map((v) => `## [${v}](https://example.test/v${v}) (2026-10-23)\n\n* a fix in ${v}\n`).join('\n')}`;
const OLD_PAGE = 'apps/docs-users/src/content/docs/old.md';
const HEAD = 'back-merge/v0.5.2';

/** main, and release/0.5.x cut at v0.5.0-next.6 with a cherry-picked fix, tagged v0.5.2. */
function releaseRepo({ cutTag = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'back-merge-'));
  const git = (...args) =>
    execFileSync(
      'git',
      ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args],
      {
        cwd: dir,
        encoding: 'utf8',
        stdio: 'pipe',
      },
    ).trim();
  const commit = (message, files, remove = []) => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    for (const path of remove) git('rm', '-q', path);
    git('add', '-A');
    git('commit', '-qm', message);
    return git('rev-parse', 'HEAD');
  };
  git('init', '-q', '-b', 'main');
  commit('base', {
    'CHANGELOG.md': CHANGELOG('0.4.0'),
    '.release-please-manifest.json': manifest('0.4.0'),
    '.release-please-manifest.next.json': manifest('0.5.0-next.6'),
    'package.json': pkg('0.5.0-next.6', '1.0.0'),
    [PAGE]: page('0.5.0-next.6', 'footer'),
    [OLD_PAGE]: page('0.5.0-next.6', 'old'),
    'src/fix.ts': 'export const fixed = false;\n',
  });
  if (cutTag) git('tag', 'v0.5.0-next.6');
  git('switch', '-qc', 'release/0.5.x');
  const releaseCommits = [
    commit('fix: the bug (cherry picked)', {
      'src/fix.ts': 'export const fixed = true;\n',
    }),
    commit('release: 0.5.2', {
      'CHANGELOG.md': CHANGELOG('0.5.2', '0.5.1', '0.5.0', '0.4.0'),
      '.release-please-manifest.json': manifest('0.5.2'),
      '.release-please-manifest.next.json': manifest('0.5.2'),
      'package.json': pkg('0.5.2', '1.0.0'),
      [PAGE]: page('0.5.2', 'footer'),
      [OLD_PAGE]: page('0.5.2', 'old'),
    }),
  ];
  git('tag', 'v0.5.2');
  git('switch', '-q', 'main');
  commit(
    'fix: the bug',
    {
      'src/fix.ts': 'export const fixed = true; // and more\n',
      'CHANGELOG.md': CHANGELOG('0.4.1', '0.4.0'),
      '.release-please-manifest.next.json': manifest('0.6.0-next.0'),
      'package.json': pkg('0.6.0-next.0', '1.0.0'),
      [PAGE]: page('0.5.0-next.6', 'footer from main'),
    },
    [OLD_PAGE],
  );
  /** What run() does between fetching and pushing. */
  const backMerge = () => {
    git('switch', '-qC', HEAD, 'main');
    const result = buildBackMerge('v0.5.2', dir);
    if (result.changed)
      git('commit', '-qm', 'chore: back-merge v0.5.2 into main');
    return result;
  };
  return {
    dir,
    git,
    commit,
    backMerge,
    releaseCommits,
    read: (path) => readFileSync(join(dir, path), 'utf8'),
  };
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
    expect(resolutionFor('.release-please-manifest.next.json')).toBe('higher');
    for (const other of [
      'package.json',
      'electron/package.json',
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
    expect(planBackMerge({ alreadyBackMerged: true, existingPr: null })).toBe(
      'skip',
    );
    expect(planBackMerge({ alreadyBackMerged: true, existingPr: 12 })).toBe(
      'skip',
    );
    expect(planBackMerge({ alreadyBackMerged: false, existingPr: 12 })).toBe(
      'update',
    );
    expect(planBackMerge({ alreadyBackMerged: false, existingPr: null })).toBe(
      'create',
    );
  });

  describe('building the back-merge commit', () => {
    let repo;
    afterEach(() => rmSync(repo.dir, { recursive: true, force: true }));

    it('builds one commit whose only parent is main', () => {
      repo = releaseRepo();
      repo.backMerge();
      expect(
        repo.git('rev-list', '--parents', '-n1', 'HEAD').split(' '),
      ).toEqual([repo.git('rev-parse', 'HEAD'), repo.git('rev-parse', 'main')]);
    });

    it('does not bring release-branch code commits into main', () => {
      repo = releaseRepo();
      repo.backMerge();
      expect(repo.read('src/fix.ts')).toBe(
        'export const fixed = true; // and more\n',
      );
      const log = repo.git('log', '--format=%H', 'HEAD').split('\n');
      for (const sha of repo.releaseCommits) expect(log).not.toContain(sha);
      expect(
        repo.git('diff', '--name-only', 'main', 'HEAD').split('\n').sort(),
      ).toEqual(['.release-please-manifest.json', 'CHANGELOG.md', PAGE]);
    });

    it("takes the release branch's CHANGELOG", () => {
      repo = releaseRepo();
      repo.backMerge();
      expect(repo.read('CHANGELOG.md')).toBe(
        CHANGELOG('0.5.2', '0.5.1', '0.5.0', '0.4.0'),
      );
      expect(repo.read(PAGE)).toBe(page('0.5.2', 'footer from main'));
    });

    it('keeps the higher next manifest', () => {
      repo = releaseRepo();
      const { resolved } = repo.backMerge();
      expect(resolved).toContain('.release-please-manifest.next.json');
      expect(repo.read('.release-please-manifest.next.json')).toBe(
        manifest('0.6.0-next.0'),
      );
      expect(repo.read('package.json')).toBe(pkg('0.6.0-next.0', '1.0.0'));
    });

    it("sets the stable manifest to the line's cut prerelease", () => {
      repo = releaseRepo();
      expect(cutPrerelease('v0.5.2', repo.dir)).toBe('0.5.0-next.6');
      repo.backMerge();
      expect(repo.read('.release-please-manifest.json')).toBe(
        manifest('0.5.0-next.6'),
      );
    });

    it('lists only the release and higher metadata paths', () => {
      repo = releaseRepo();
      const base = repo.git('merge-base', 'main', 'v0.5.2');
      expect(metadataPaths(base, 'main', 'v0.5.2', repo.dir).sort()).toEqual([
        '.release-please-manifest.json',
        '.release-please-manifest.next.json',
        'CHANGELOG.md',
        PAGE,
        OLD_PAGE,
      ]);
    });

    it("keeps main's newer cut when an older line back-merges", () => {
      repo = releaseRepo();
      repo.commit('chore: back-merge v0.6.0 into main', {
        '.release-please-manifest.json': manifest('0.6.0-next.3'),
      });
      repo.backMerge();
      expect(repo.read('.release-please-manifest.json')).toBe(
        manifest('0.6.0-next.3'),
      );
    });

    it('replaces a legacy stable value with the cut', () => {
      repo = releaseRepo();
      repo.commit('chore: back-merge v0.5.1 into main', {
        '.release-please-manifest.json': manifest('0.5.1'),
      });
      repo.backMerge();
      expect(repo.read('.release-please-manifest.json')).toBe(
        manifest('0.5.0-next.6'),
      );
    });

    it('skips a metadata path that main deleted', () => {
      repo = releaseRepo();
      const { resolved } = repo.backMerge();
      expect(resolved).not.toContain(OLD_PAGE);
      expect(repo.git('ls-files', OLD_PAGE)).toBe('');
      expect(existsSync(join(repo.dir, OLD_PAGE))).toBe(false);
    });

    it('fails when no cut prerelease precedes the tag', () => {
      repo = releaseRepo({ cutTag: false });
      expect(() => cutPrerelease('v0.5.2', repo.dir)).toThrow(
        /No v\*-next\.\* tag is reachable from v0\.5\.2/,
      );
      expect(() => repo.backMerge()).toThrow(/v0\.5\.2/);
    });

    it('plans skip when main already carries the release', () => {
      repo = releaseRepo();
      repo.backMerge();
      repo.git('switch', '-q', 'main');
      repo.git('merge', '-q', '--ff-only', HEAD);
      expect(repo.backMerge().changed).toBe(false);
      expect(planBackMerge({ alreadyBackMerged: true, existingPr: 12 })).toBe(
        'skip',
      );
    });

    it('rebuilds on current main', () => {
      repo = releaseRepo();
      repo.backMerge();
      const first = repo.git('rev-parse', 'HEAD');
      repo.git('switch', '-q', 'main');
      const moved = repo.commit('feat: more', { 'src/more.ts': '1;\n' });
      repo.backMerge();
      expect(
        repo.git('rev-list', '--parents', '-n1', 'HEAD').split(' '),
      ).toEqual([repo.git('rev-parse', 'HEAD'), moved]);
      expect(repo.git('log', '--format=%H', 'HEAD').split('\n')).not.toContain(
        first,
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

  it('only pushes its own back-merge branch and leaves the release config as merged', () => {
    const source = readFileSync(
      resolve(import.meta.dirname, 'back-merge.mjs'),
      'utf8',
    );
    expect(backMerge.withoutReleaseAs).toBeUndefined();
    expect(source).not.toContain('release-as');
    expect(source.match(/git\('push'[^\n]*/g)).toEqual([
      "git('push', lease, 'origin', `${head}:${head}`);",
    ]);
  });
});
