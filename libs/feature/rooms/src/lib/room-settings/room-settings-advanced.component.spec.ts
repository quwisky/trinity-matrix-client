import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { fireEvent, render } from '@trinity/testing';
import {
  TrnSurfaceService,
  TrnToastService,
} from '@trinity/components/overlay';
import {
  HomeserverInfoService,
  type HomeserverCapabilities,
  type HomeserverInfo,
} from '@trinity/data-access/homeserver';
import {
  RoomSettingsService,
  RoomUpgradeService,
  type ActionAvailability,
  type RoomAdvancedInfo,
  type RoomStateEntry,
  type RoomUpgradePlan,
  type RoomUpgradeResult,
} from '@trinity/data-access/room-administration';
import { DateTimeFormatService } from '@trinity/platform-native';
import { MockProvider } from 'ng-mocks';
import { Subject, of, type Observable } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RoomStateViewerComponent } from '../room-state-viewer/room-state-viewer.component';
import {
  ROOM_UPGRADE_WARNING_ID,
  RoomUpgradeDialogComponent,
} from '../room-upgrade/room-upgrade-dialog.component';
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
const ALLOWED: ActionAvailability = { available: true, reason: null };
/** INFO without the successor, so the room is still live. */
const LIVE: RoomAdvancedInfo = { ...INFO, successor: null };
const NEWER: HomeserverCapabilities = {
  defaultRoomVersion: '11',
  roomVersions: { '10': 'stable', '11': 'stable' },
  canChangePassword: null,
};
const PLAN: RoomUpgradePlan = {
  currentVersion: '10',
  targets: [{ version: '11', isDefault: true }],
  invitePrivateDefault: true,
  members: ['@bob:hs'],
  spaces: [],
  additionalCreators: [],
  additionalCreatorNames: [],
};
const RESULT: RoomUpgradeResult = {
  newRoomId: '!new-room:hs',
  invited: ['@bob:hs'],
  inviteFailed: [],
  relinked: [],
  relinkFailed: [],
  skippedSpaces: [],
};

interface UpgradeSetup {
  readonly upgrade?: ActionAvailability;
  readonly result?: Observable<RoomUpgradeResult | null>;
}

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
  upgradeSetup: UpgradeSetup = {},
) {
  const infos = signal<ReadonlyMap<string, HomeserverInfo>>(
    new Map([[ACCOUNT, homeserver(capabilities)]]),
  );
  const load = vi.fn(() => of(undefined));
  const open = vi.fn();
  const openAndWait = vi.fn(() => upgradeSetup.result ?? of(null));
  const show = vi.fn();
  const stateEvents = vi.fn(() => STATE);
  const plan = vi.fn(() => PLAN);
  const openRoom = vi.fn();
  const result = await render(RoomSettingsAdvancedComponent, {
    inputs: {
      accountId: ACCOUNT,
      info,
      ...(upgradeSetup.upgrade ? { upgrade: upgradeSetup.upgrade } : {}),
    },
    on: { openRoom },
    providers: [
      MockProvider(HomeserverInfoService, { infos: infos.asReadonly(), load }),
      MockProvider(RoomSettingsService, { stateEvents }),
      MockProvider(RoomUpgradeService, { plan }),
      MockProvider(TrnSurfaceService, {
        open,
        openAndWait$: openAndWait as never,
      }),
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
  const upgradeButton = () =>
    result.container.querySelector<HTMLButtonElement>(
      '[data-testid="room-advanced-upgrade"]',
    );
  return {
    ...result,
    load,
    open,
    openAndWait,
    show,
    stateEvents,
    plan,
    openRoom,
    row,
    upgradeButton,
  };
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
      inputs: { entries: STATE },
    });
  });
});

describe('RoomSettingsAdvancedComponent upgrade', () => {
  it('hides Upgrade room unless this Account may send the tombstone', async () => {
    const { upgradeButton } = await build(LIVE, NEWER);

    expect(upgradeButton()).toBeNull();
  });

  it('offers Upgrade room when the server has a newer stable version', async () => {
    const { upgradeButton, container } = await build(LIVE, NEWER, {
      upgrade: ALLOWED,
    });

    expect(upgradeButton()?.textContent?.trim()).toBe('Upgrade room');
    expect(upgradeButton()?.getAttribute('aria-disabled')).toBeNull();
    expect(
      container.querySelector('[data-testid="room-advanced-upgrade-reason"]'),
    ).toBeNull();
  });

  it.each([
    [
      'the server offers nothing newer',
      LIVE,
      {
        defaultRoomVersion: '10',
        roomVersions: { '10': 'stable' },
        canChangePassword: null,
      } satisfies HomeserverCapabilities,
      'This room is already on the newest version the server offers.',
    ],
    [
      'the server capabilities are unknown',
      LIVE,
      null,
      'This room is already on the newest version the server offers.',
    ],
    [
      'the room was already upgraded',
      INFO,
      NEWER,
      'This room has already been upgraded.',
    ],
  ])('disables Upgrade room when %s', async (_case, info, caps, reason) => {
    const { upgradeButton, container, plan } = await build(info, caps, {
      upgrade: ALLOWED,
    });

    expect(upgradeButton()?.getAttribute('aria-disabled')).toBe('true');
    expect(
      container
        .querySelector('[data-testid="room-advanced-upgrade-reason"]')
        ?.textContent?.trim(),
    ).toBe(reason);
    fireEvent.click(upgradeButton()!);
    expect(plan).not.toHaveBeenCalled();
  });

  it('opens the upgrade dialog with the plan, undismissable while busy', async () => {
    const { upgradeButton, plan, openAndWait } = await build(LIVE, NEWER, {
      upgrade: ALLOWED,
    });

    fireEvent.click(upgradeButton()!);

    expect(plan).toHaveBeenCalledWith(ACCOUNT, '!room:hs', NEWER);
    const [component, options] = openAndWait.mock.calls[0] as unknown as [
      unknown,
      {
        ariaDescribedBy: string;
        inputs: unknown;
        dismissGuard: (dialog: { busy: () => boolean } | null) => boolean;
      },
    ];
    expect(component).toBe(RoomUpgradeDialogComponent);
    expect(options.ariaDescribedBy).toBe(ROOM_UPGRADE_WARNING_ID);
    expect(options.inputs).toEqual({
      accountId: ACCOUNT,
      roomId: '!room:hs',
      plan: PLAN,
    });
    expect(options.dismissGuard({ busy: () => true })).toBe(false);
    expect(options.dismissGuard({ busy: () => false })).toBe(true);
  });

  it('asks to open the new room after the upgrade', async () => {
    const { upgradeButton, openRoom } = await build(LIVE, NEWER, {
      upgrade: ALLOWED,
      result: of(RESULT),
    });

    fireEvent.click(upgradeButton()!);

    expect(openRoom).toHaveBeenCalledWith('!new-room:hs');
  });

  it('opens nothing when the dialog is cancelled', async () => {
    const { upgradeButton, openRoom } = await build(LIVE, NEWER, {
      upgrade: ALLOWED,
      result: of(null),
    });

    fireEvent.click(upgradeButton()!);

    expect(openRoom).not.toHaveBeenCalled();
  });

  it('opens nothing when Room settings closed before the upgrade finished', async () => {
    const pending = new Subject<RoomUpgradeResult | null>();
    const { upgradeButton, openRoom, fixture } = await build(LIVE, NEWER, {
      upgrade: ALLOWED,
      result: pending,
    });

    fireEvent.click(upgradeButton()!);
    fixture.destroy();
    pending.next(RESULT);

    expect(openRoom).not.toHaveBeenCalled();
  });
});
