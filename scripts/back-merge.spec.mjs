import {
  compareVersions,
  higherVersion,
  mergeNextManifest,
  planBackMerge,
  resolutionFor,
} from './back-merge.mjs';

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
});
