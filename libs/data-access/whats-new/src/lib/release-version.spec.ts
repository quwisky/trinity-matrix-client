import type { ReleaseNote } from './release-notes';
import { compareReleaseVersions, releasesSince } from './release-version';

const note = (version: string): ReleaseNote => ({
  version,
  date: '2026-01-01',
  sections: {},
});

describe('compareReleaseVersions', () => {
  it('orders -next builds before their stable release', () => {
    expect(compareReleaseVersions('0.5.0-next.2', '0.5.0-next.3')).toBeLessThan(
      0,
    );
    expect(compareReleaseVersions('0.5.0-next.9', '0.5.0')).toBeLessThan(0);
    expect(compareReleaseVersions('0.4.0', '0.5.0-next.1')).toBeLessThan(0);
    expect(compareReleaseVersions('1.0.0', '1.0.0')).toBe(0);
  });

  it('returns null for unparseable versions', () => {
    expect(compareReleaseVersions('banana', '1.0.0')).toBeNull();
  });
});

describe('releasesSince', () => {
  it('returns versions after lastSeen up to running, newest first', () => {
    const notes = [
      note('0.5.0-next.3'),
      note('0.5.0-next.2'),
      note('0.5.0-next.1'),
    ];
    expect(
      releasesSince(notes, '0.5.0-next.1', '0.5.0-next.3').map(
        (n) => n.version,
      ),
    ).toEqual(['0.5.0-next.3', '0.5.0-next.2']);
  });
});
