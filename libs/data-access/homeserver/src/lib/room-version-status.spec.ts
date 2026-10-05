import { describe, expect, it } from 'vitest';
import type { HomeserverCapabilities } from './homeserver-info.model';
import { roomVersionStatus } from './room-version-status';

const caps = (
  over: Partial<HomeserverCapabilities> = {},
): HomeserverCapabilities => ({
  defaultRoomVersion: '10',
  roomVersions: {
    '9': 'stable',
    '10': 'stable',
    '11': 'stable',
    '12': 'stable',
  },
  canChangePassword: null,
  ...over,
});

describe('roomVersionStatus', () => {
  it('is unknown when the server stated no room versions', () => {
    expect(roomVersionStatus('10', null)).toBeNull();
    expect(
      roomVersionStatus(
        '10',
        caps({ defaultRoomVersion: null, roomVersions: null }),
      ),
    ).toBeNull();
  });

  it('is current when the room is at the server default', () => {
    expect(roomVersionStatus('10', caps())).toBe('current');
  });

  it('offers a newer stable default, comparing versions as numbers', () => {
    expect(roomVersionStatus('9', caps())).toBe('newer-available');
  });

  // Review Focus 2: a room created elsewhere at v12 is not behind a v10 default.
  it('does not call a room outdated when it is newer than the default', () => {
    expect(roomVersionStatus('12', caps())).toBe('current');
  });

  it('does not offer an unstable default', () => {
    expect(
      roomVersionStatus(
        '9',
        caps({
          defaultRoomVersion: '11',
          roomVersions: { '9': 'stable', '11': 'unstable' },
        }),
      ),
    ).toBe('current');
  });

  it('flags a room on an unstable version', () => {
    expect(
      roomVersionStatus(
        'org.matrix.msc1234',
        caps({
          roomVersions: { '10': 'stable', 'org.matrix.msc1234': 'unstable' },
        }),
      ),
    ).toBe('unstable');
  });

  it('uses the default alone when the server lists no available map', () => {
    expect(roomVersionStatus('9', caps({ roomVersions: null }))).toBe(
      'newer-available',
    );
  });
});
