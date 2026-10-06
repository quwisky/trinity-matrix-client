import { firstReleaseVersion } from './release-version.mjs';

describe('first stable release version', () => {
  const branch = 'release/0.3.x';

  it('takes the version of the prerelease the line was cut from', () => {
    expect(
      firstReleaseVersion(branch, ['v0.2.0', 'v0.3.0-next.0', 'v0.3.0-next.1']),
    ).toBe('0.3.0');
  });

  it('is empty once the line has a stable tag', () => {
    expect(
      firstReleaseVersion(branch, ['v0.3.0-next.1', 'v0.3.0', 'v0.3.1']),
    ).toBe('');
    expect(firstReleaseVersion(branch, ['v0.3.0-next.1', 'v0.3.0'])).toBe('');
  });

  it("ignores another line's prereleases and stable tags", () => {
    expect(
      firstReleaseVersion(branch, ['v0.2.0', 'v0.2.1-next.0', 'v0.4.0-next.0']),
    ).toBe('');
    expect(
      firstReleaseVersion(branch, [
        'v0.2.1',
        'v0.13.0-next.0',
        'v0.3.0-next.0',
      ]),
    ).toBe('0.3.0');
  });

  it('takes the newest prerelease of the line', () => {
    expect(
      firstReleaseVersion(branch, [
        'v0.3.1-next.0',
        'v0.3.0-next.12',
        'v0.3.0-next.2',
      ]),
    ).toBe('0.3.1');
  });

  it('is empty off a release branch and ignores other tag names', () => {
    expect(firstReleaseVersion('main', ['v0.3.0-next.1'])).toBe('');
    expect(
      firstReleaseVersion(branch, ['v0.3.0-rc.1', 'x0.3.0', 'v0.3.0-next.1']),
    ).toBe('0.3.0');
  });
});
