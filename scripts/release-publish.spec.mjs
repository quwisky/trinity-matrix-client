import { missingAssets, shouldBeLatest } from './release-publish.mjs';

const complete = [
  'Trinity-0.2.0-arm64.dmg',
  'Trinity-0.2.0-arm64-mac.zip',
  'Trinity.Setup.0.2.0.exe',
  'Trinity-0.2.0.AppImage',
  'trinity-desktop_0.2.0_amd64.deb',
  'Trinity-Web-0.2.0.zip',
];

describe('release publishing', () => {
  it('requires every platform asset', () => {
    expect(missingAssets(complete)).toEqual([]);
    for (const name of complete) {
      expect(missingAssets(complete.filter((n) => n !== name))).toHaveLength(1);
    }
    expect(missingAssets([])).toHaveLength(complete.length);
  });

  it('marks only the highest stable release as latest', () => {
    expect(shouldBeLatest('v0.2.0', ['v0.1.0', 'v0.1.1'])).toBe(true);
    expect(shouldBeLatest('v0.1.2', ['v0.1.1', 'v0.2.0'])).toBe(false);
    expect(shouldBeLatest('v0.2.1', ['v0.2.0', 'v0.1.2'])).toBe(true);
    expect(shouldBeLatest('v0.2.1', ['v0.2.1'])).toBe(true);
    expect(shouldBeLatest('v0.3.0-next.1', ['v0.2.0'])).toBe(false);
  });
});
