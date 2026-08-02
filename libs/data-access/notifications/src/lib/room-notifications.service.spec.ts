import { TestBed } from '@angular/core/testing';
import { MockProvider } from 'ng-mocks';
import { firstValueFrom } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { RoomNotificationsService } from './room-notifications.service';

const ROOM = '!r:hs';

interface Rule {
  rule_id: string;
  enabled: boolean;
  actions: string[];
}

/** A fake client whose push-rule methods record calls and mutate an in-memory ruleset. */
function makeClient(seed: { override?: Rule[]; room?: Rule[] } = {}) {
  const client = {
    pushRules: {
      global: { override: seed.override ?? [], room: seed.room ?? [] },
    },
    getRoomPushRule: vi.fn((_scope: string, roomId: string) =>
      client.pushRules.global.room.find((r) => r.rule_id === roomId),
    ),
    setRoomMutePushRule: vi.fn(() => Promise.resolve()),
    addPushRule: vi.fn(() => Promise.resolve({})),
    deletePushRule: vi.fn(() => Promise.resolve({})),
    getPushRules: vi.fn(() => Promise.resolve(client.pushRules)),
  };
  return client;
}

function setup(seed?: { override?: Rule[]; room?: Rule[] }) {
  const client = makeClient(seed);
  TestBed.configureTestingModule({
    providers: [
      RoomNotificationsService,
      MockProvider(MatrixClientService, {
        isInitialized: true,
        instance: client as never,
      }),
    ],
  });
  return { svc: TestBed.inject(RoomNotificationsService), client };
}

const dontNotify = (rule_id: string): Rule => ({
  rule_id,
  enabled: true,
  actions: ['dont_notify'],
});

describe('RoomNotificationsService', () => {
  describe('modeFor', () => {
    it('reports "all" with no room rules', () => {
      expect(setup().svc.modeFor(ROOM)).toBe('all');
    });

    it('reports "mentions" for a room-kind dont_notify rule', () => {
      const { svc } = setup({ room: [dontNotify(ROOM)] });
      expect(svc.modeFor(ROOM)).toBe('mentions');
    });

    it('reports "mute" for an override dont_notify rule', () => {
      const { svc } = setup({ override: [dontNotify(ROOM)] });
      expect(svc.modeFor(ROOM)).toBe('mute');
    });

    it('prefers mute when both an override and a room rule exist', () => {
      const { svc } = setup({
        override: [dontNotify(ROOM)],
        room: [dontNotify(ROOM)],
      });
      expect(svc.modeFor(ROOM)).toBe('mute');
    });

    it('ignores a disabled override rule', () => {
      const { svc } = setup({
        override: [{ rule_id: ROOM, enabled: false, actions: ['dont_notify'] }],
      });
      expect(svc.modeFor(ROOM)).toBe('all');
    });
  });

  describe('setMode', () => {
    it('mentions → adds the room-kind dont_notify rule and clears any override', async () => {
      const { svc, client } = setup({ override: [dontNotify(ROOM)] });
      await firstValueFrom(svc.setMode(ROOM, 'mentions'));
      expect(client.deletePushRule).toHaveBeenCalledWith(
        'global',
        'override',
        ROOM,
      );
      expect(client.setRoomMutePushRule).toHaveBeenCalledWith(
        'global',
        ROOM,
        true,
      );
    });

    it('mute → clears the room rule and adds an override dont_notify rule', async () => {
      const { svc, client } = setup();
      await firstValueFrom(svc.setMode(ROOM, 'mute'));
      expect(client.setRoomMutePushRule).toHaveBeenCalledWith(
        'global',
        ROOM,
        false,
      );
      expect(client.addPushRule).toHaveBeenCalledWith(
        'global',
        'override',
        ROOM,
        expect.objectContaining({ actions: ['dont_notify'] }),
      );
    });

    it('all → removes both the override and room rules', async () => {
      const { svc, client } = setup({ override: [dontNotify(ROOM)] });
      await firstValueFrom(svc.setMode(ROOM, 'all'));
      expect(client.deletePushRule).toHaveBeenCalledWith(
        'global',
        'override',
        ROOM,
      );
      expect(client.setRoomMutePushRule).toHaveBeenCalledWith(
        'global',
        ROOM,
        false,
      );
    });

    it('mute is idempotent — no duplicate override rule', async () => {
      const { svc, client } = setup({ override: [dontNotify(ROOM)] });
      await firstValueFrom(svc.setMode(ROOM, 'mute'));
      expect(client.addPushRule).not.toHaveBeenCalled();
    });

    it('is cold — nothing is written until subscribed', () => {
      const { svc, client } = setup();
      svc.setMode(ROOM, 'mute'); // not subscribed
      expect(client.addPushRule).not.toHaveBeenCalled();
      expect(client.setRoomMutePushRule).not.toHaveBeenCalled();
    });
  });
});

// A mixed-account sidebar row can belong to an account that isn't active. Push rules live
// per-account, so reading or writing them through the active client reports the wrong level
// and mutes the wrong account while the menu claims success.
describe('RoomNotificationsService per-account rules', () => {
  function setupOwned() {
    const activeClient = makeClient();
    const ownerClient = makeClient({
      room: [{ rule_id: ROOM, enabled: true, actions: ['dont_notify'] }],
    });
    TestBed.configureTestingModule({
      providers: [
        RoomNotificationsService,
        MockProvider(MatrixClientService, {
          isInitialized: true,
          instance: activeClient as never,
          clientFor: vi.fn((id: string) =>
            id === '@owner:hs' ? (ownerClient as never) : null,
          ),
        }),
      ],
    });
    return {
      svc: TestBed.inject(RoomNotificationsService),
      activeClient,
      ownerClient,
    };
  }

  it('reads the level from the owning account', () => {
    const { svc, activeClient } = setupOwned();

    // The owning account has a mentions-only rule; the active account has none.
    expect(svc.modeFor(ROOM, '@owner:hs')).toBe('mentions');
    expect(svc.modeFor(ROOM)).toBe('all');
    expect(activeClient.getRoomPushRule).toHaveBeenCalled();
  });

  it('writes the level to the owning account, not the active one', async () => {
    const { svc, activeClient, ownerClient } = setupOwned();

    await firstValueFrom(svc.setMode(ROOM, 'mute', '@owner:hs'));

    expect(ownerClient.setRoomMutePushRule).toHaveBeenCalled();
    expect(activeClient.setRoomMutePushRule).not.toHaveBeenCalled();
  });

  it('reports "all" and refuses to write when the owning account has no client', async () => {
    const { svc, activeClient } = setupOwned();

    expect(svc.modeFor(ROOM, '@gone:hs')).toBe('all');
    await expect(
      firstValueFrom(svc.setMode(ROOM, 'mute', '@gone:hs')),
    ).rejects.toThrow('Not signed in.');
    expect(activeClient.setRoomMutePushRule).not.toHaveBeenCalled();
  });
});
