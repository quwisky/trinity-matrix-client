import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { fireEvent, render } from '@trinity/testing';
import { TrnDialogService, TrnToastService } from '@trinity/components/overlay';
import {
  HomeserverInfoService,
  type HomeserverCapabilities,
  type HomeserverInfo,
} from '@trinity/data-access/homeserver';
import {
  RoomSettingsService,
  type RoomAdvancedInfo,
  type RoomStateEntry,
} from '@trinity/data-access/room-administration';
import { DateTimeFormatService } from '@trinity/platform-native';
import { MockProvider } from 'ng-mocks';
import { of } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RoomStateViewerComponent } from '../room-state-viewer/room-state-viewer.component';
import { RoomSettingsAdvancedComponent } from './room-settings-advanced.component';

const ACCOUNT = '@me:hs';
const INFO: RoomAdvancedInfo = {
  roomId: '!room:hs',
  version: '10',
  createdBy: [
    { userId: '@alice:hs', displayName: 'Alice' },
    { userId: '@carol:hs', displayName: '@carol:hs' },
  ],
  createdAt: 1_700_000_000_000,
  encrypted: true,
  encryption: 'm.megolm.v1.aes-sha2',
  federated: false,
  predecessor: { roomId: '!old:hs', eventId: '$tomb' },
  successor: '!new:hs',
};
const UNKNOWN: RoomAdvancedInfo = {
  roomId: '!room:hs',
  version: null,
  createdBy: [],
  createdAt: null,
  encrypted: false,
  encryption: null,
  federated: null,
  predecessor: null,
  successor: null,
};
const STATE: readonly RoomStateEntry[] = [
  { type: 'm.room.create', stateKey: '', event: { type: 'm.room.create' } },
];

const homeserver = (
  capabilities: HomeserverCapabilities | null,
): HomeserverInfo => ({
  userId: ACCOUNT,
  serverName: 'hs',
  baseUrl: 'https://hs',
  discovered: false,
  software: null,
  specVersions: null,
  unstableFeatures: null,
  capabilities,
});

async function build(
  info: RoomAdvancedInfo = INFO,
  capabilities: HomeserverCapabilities | null = null,
) {
  const infos = signal<ReadonlyMap<string, HomeserverInfo>>(
    new Map([[ACCOUNT, homeserver(capabilities)]]),
  );
  const load = vi.fn(() => of(undefined));
  const open = vi.fn();
  const show = vi.fn();
  const stateEvents = vi.fn(() => STATE);
  const openRoom = vi.fn();
  const result = await render(RoomSettingsAdvancedComponent, {
    inputs: { accountId: ACCOUNT, info },
    on: { openRoom },
    providers: [
      MockProvider(HomeserverInfoService, { infos: infos.asReadonly(), load }),
      MockProvider(RoomSettingsService, { stateEvents }),
      MockProvider(TrnDialogService, { open }),
      MockProvider(TrnToastService, { show }),
    ],
  });
  /** The `<dd>` text that follows the `<dt>` named `term`, whitespace-collapsed. */
  const row = (term: string): string | null => {
    const dt = [...result.container.querySelectorAll('dt')].find(
      (el) => el.textContent?.trim() === term,
    );
    return dt
      ? (dt.nextElementSibling?.textContent?.replace(/\s+/g, ' ').trim() ?? '')
      : null;
  };
  return { ...result, load, open, show, stateEvents, openRoom, row };
}

afterEach(() => vi.unstubAllGlobals());

describe('RoomSettingsAdvancedComponent', () => {
  it('shows the room’s technical details', async () => {
    const { container, row } = await build();

    expect(
      container.querySelector('[data-testid="room-settings-panel-advanced"]'),
    ).not.toBeNull();
    expect(row('Room ID')).toContain('!room:hs');
    expect(row('Room version')).toContain('10');
    expect(row('Created by')).toContain('Alice (@alice:hs)');
    expect(row('Created by')).toContain('@carol:hs');
    expect(row('Created by')).not.toContain('@carol:hs (@carol:hs)');
    expect(row('Created')).toBe(
      TestBed.inject(DateTimeFormatService).dateTime(INFO.createdAt as number),
    );
    expect(row('Encryption')).toBe('m.megolm.v1.aes-sha2');
    expect(row('Federation')).toBe('This server only');
    expect(row('Replaces')).toContain('!old:hs');
    expect(row('Replaced by')).toContain('!new:hs');
  });

  it('reads an unencrypted, federated room with no upgrade history', async () => {
    const { row } = await build({
      ...INFO,
      encrypted: false,
      encryption: null,
      federated: true,
      predecessor: null,
      successor: null,
    });

    expect(row('Encryption')).toBe('Off');
    expect(row('Federation')).toBe('Other servers can join');
    expect(row('Replaces')).toBeNull();
    expect(row('Replaced by')).toBeNull();
  });

  // Partial state still shows the room ID.
  it('shows the room ID and Unknown when the create event is missing', async () => {
    const { row, queryByRole } = await build(UNKNOWN);

    expect(row('Room ID')).toContain('!room:hs');
    expect(row('Room version')).toBe('Unknown');
    expect(row('Created by')).toBe('Unknown');
    expect(row('Created')).toBe('Unknown');
    expect(row('Federation')).toBe('Unknown');
    expect(queryByRole('button', { name: 'Copy room version' })).toBeNull();
  });

  it('reads an encrypted room with an unusable algorithm as Unknown, not Off', async () => {
    const { row } = await build({ ...INFO, encrypted: true, encryption: null });

    expect(row('Encryption')).toBe('Unknown');
  });

  it('names what each copy button copies and copies it', async () => {
    const { getByRole, show } = await build();
    for (const name of [
      'Copy room ID',
      'Copy room version',
      'Copy ID of room this replaces',
      'Copy ID of room that replaced this',
    ]) {
      expect(getByRole('button', { name })).toBeTruthy();
    }
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });

    fireEvent.click(getByRole('button', { name: 'Copy room ID' }));
    fireEvent.click(
      getByRole('button', { name: 'Copy ID of room this replaces' }),
    );

    expect(writeText).toHaveBeenNthCalledWith(1, '!room:hs');
    expect(writeText).toHaveBeenNthCalledWith(2, '!old:hs');
    await vi.waitFor(() =>
      expect(show).toHaveBeenCalledWith('Room ID copied.', { duration: 2000 }),
    );
  });

  // No clipboard means a failure toast, never "copied".
  it('toasts a failed copy instead of claiming success', async () => {
    const { getByRole, show } = await build();
    vi.stubGlobal('navigator', {});

    fireEvent.click(getByRole('button', { name: 'Copy room ID' }));

    await vi.waitFor(() =>
      expect(show).toHaveBeenCalledWith('Could not copy the room ID.', {
        duration: 2000,
      }),
    );
    expect(show).not.toHaveBeenCalledWith('Room ID copied.', expect.anything());
  });

  it('toasts a failed copy when the clipboard write rejects', async () => {
    const { getByRole, show } = await build();
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    vi.stubGlobal('navigator', { clipboard: { writeText } });

    fireEvent.click(getByRole('button', { name: 'Copy room ID' }));

    await vi.waitFor(() =>
      expect(show).toHaveBeenCalledWith('Could not copy the room ID.', {
        duration: 2000,
      }),
    );
    expect(show).not.toHaveBeenCalledWith('Room ID copied.', expect.anything());
  });

  it('asks to open the predecessor and the successor', async () => {
    const { getByRole, openRoom } = await build();

    fireEvent.click(getByRole('button', { name: 'Open room this replaces' }));
    fireEvent.click(
      getByRole('button', { name: 'Open room that replaced this' }),
    );

    expect(openRoom).toHaveBeenNthCalledWith(1, '!old:hs');
    expect(openRoom).toHaveBeenNthCalledWith(2, '!new:hs');
  });

  it.each<[string, HomeserverCapabilities | null, string | null]>([
    [
      'a newer stable default',
      {
        defaultRoomVersion: '11',
        roomVersions: { '10': 'stable', '11': 'stable' },
        canChangePassword: null,
      },
      'Newer version available',
    ],
    [
      'an unstable room version',
      {
        defaultRoomVersion: '10',
        roomVersions: { '10': 'unstable' },
        canChangePassword: null,
      },
      'Unstable version',
    ],
    [
      'the server default',
      {
        defaultRoomVersion: '10',
        roomVersions: { '10': 'stable' },
        canChangePassword: null,
      },
      null,
    ],
    ['unknown capabilities', null, null],
  ])('notes the version status for %s', async (_case, capabilities, note) => {
    const { container, load } = await build(INFO, capabilities);

    expect(load).toHaveBeenCalledWith(ACCOUNT);
    expect(
      container
        .querySelector('[data-testid="room-advanced-version-note"]')
        ?.textContent?.trim() ?? null,
    ).toBe(note);
  });

  it('opens the room state viewer with the room’s current state', async () => {
    const { getByRole, open, stateEvents } = await build();

    fireEvent.click(getByRole('button', { name: 'View room state' }));

    expect(stateEvents).toHaveBeenCalledWith({
      accountId: ACCOUNT,
      roomId: '!room:hs',
    });
    expect(open).toHaveBeenCalledWith(RoomStateViewerComponent, {
      ariaLabel: 'Room state',
      inputs: { entries: STATE },
    });
  });
});
