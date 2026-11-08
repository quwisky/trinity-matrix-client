import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  commitLabel,
  generate,
  renderBuildInfo,
  stripTimestamp,
} from './gen-build-info.mjs';

/** The version the stub root reports — arbitrary, and deliberately not the repo's. */
const VERSION = '0.0.1';

/** A git stub answering rev-parse with `hash` and status with `porcelain`. */
const fakeGit =
  (hash, porcelain = '') =>
  (_root, command) => {
    if (command.includes('rev-parse')) return hash;
    if (command.includes('status')) return porcelain;
    return '';
  };

const tmpDirs = [];
function tmpOut() {
  const dir = mkdtempSync(join(tmpdir(), 'buildinfo-'));
  tmpDirs.push(dir);
  return join(dir, 'build-info.ts');
}

/**
 * A stub repo root: a temp dir holding just the `package.json` the generator reads.
 * Pointing `root` at the real repo would couple these assertions to the *actual*
 * version, so every release bump broke the suite (it did — 0.0.1 → 0.1.0). `git` is
 * injected separately, so this is the last thing tying the tests to the real tree.
 */
function fakeRoot(version = VERSION) {
  const dir = mkdtempSync(join(tmpdir(), 'buildinfo-root-'));
  tmpDirs.push(dir);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ version }));
  return dir;
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('commitLabel', () => {
  it('uses the short hash as-is on a clean tree', () => {
    expect(commitLabel('abc1234', '')).toBe('abc1234');
  });

  it('appends -dirty when the tree has changes', () => {
    expect(commitLabel('abc1234', ' M some/file.ts')).toBe('abc1234-dirty');
  });

  it('falls back to "unknown" without a hash', () => {
    expect(commitLabel('', '')).toBe('unknown');
  });
});

describe('renderBuildInfo / stripTimestamp', () => {
  it('interpolates version, commit, and builtAt', () => {
    const source = renderBuildInfo({
      version: '1.2.3',
      commit: 'abc1234',
      builtAt: '2026-01-01T00:00:00.000Z',
    });
    expect(source).toContain("version: '1.2.3'");
    expect(source).toContain("commit: 'abc1234'");
    expect(source).toContain("builtAt: '2026-01-01T00:00:00.000Z'");
    expect(source).toContain('BUILD_INFO_VALUE');
  });

  it('blanks the timestamp for change comparison', () => {
    expect(stripTimestamp("  builtAt: '2026-01-01T00:00:00.000Z',")).toBe(
      "  builtAt: '',",
    );
  });
});

describe('generate', () => {
  it('writes build-info from package.json + git when the file is absent', () => {
    const out = tmpOut();
    const result = generate({
      root: fakeRoot(),
      outFile: out,
      git: fakeGit('abc1234'),
      now: () => 'T',
    });

    expect(result).toEqual({
      version: VERSION,
      commit: 'abc1234',
      wrote: true,
    });
    const written = readFileSync(out, 'utf8');
    expect(written).toContain(`version: '${VERSION}'`);
    expect(written).toContain("commit: 'abc1234'");
    expect(written).toContain("builtAt: 'T'");
  });

  it('takes the version from the root package.json', () => {
    const out = tmpOut();
    const result = generate({
      root: fakeRoot('9.8.7'),
      outFile: out,
      git: fakeGit('abc1234'),
      now: () => 'T',
    });

    expect(result.version).toBe('9.8.7');
    expect(readFileSync(out, 'utf8')).toContain("version: '9.8.7'");
  });

  it('is idempotent: an unchanged version/commit is not rewritten (timestamp aside)', () => {
    const out = tmpOut();
    const root = fakeRoot(); // the same root both times: only the timestamp differs
    generate({ root, outFile: out, git: fakeGit('abc1234'), now: () => 'T1' });
    const again = generate({
      root,
      outFile: out,
      git: fakeGit('abc1234'),
      now: () => 'T2', // a new timestamp alone must not trigger a write
    });
    expect(again.wrote).toBe(false);
  });

  it('rewrites when the commit changes', () => {
    const out = tmpOut();
    const root = fakeRoot();
    generate({ root, outFile: out, git: fakeGit('abc1234'), now: () => 'T' });
    const changed = generate({
      root,
      outFile: out,
      git: fakeGit('def5678'),
      now: () => 'T',
    });
    expect(changed.wrote).toBe(true);
    expect(readFileSync(out, 'utf8')).toContain("commit: 'def5678'");
  });

  it('marks a dirty working tree in the commit', () => {
    const out = tmpOut();
    const result = generate({
      root: fakeRoot(),
      outFile: out,
      git: fakeGit('abc1234', ' M file'),
      now: () => 'T',
    });
    expect(result.commit).toBe('abc1234-dirty');
  });
});
