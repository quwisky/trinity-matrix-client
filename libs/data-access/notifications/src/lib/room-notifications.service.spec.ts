import { effect } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ClientEvent } from 'matrix-js-sdk';
import { MockProvider } from 'ng-mocks';
import { firstValueFrom } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import {
  RoomNotificationsService,
  type RoomNotifyMode,
} from './room-notifications.service';

const ROOM = '!r:hs';

interface Rule {
  rule_id: string;
  enabled: boolean;
  actions: string[];
}

/** A fake client whose push-rule methods record calls and mutate an in-memory ruleset. */
function makeClient(seed: { override?: Rule[]; room?: Rule[] } = {}) {
  const serverRules = {
    global: {
      override: structuredClone(seed.override ?? []),
      room: structuredClone(seed.room ?? []),
    },
  };
  const client = {
    pushRules: structuredClone(serverRules),
    getRoomPushRule: vi.fn((_scope: string, roomId: string) =>
      client.pushRules.global.room.find((r) => r.rule_id === roomId),
    ),
    setRoomMutePushRule: vi.fn(
      async (_scope: string, roomId: string, mute: boolean) => {
        serverRules.global.room = mute ? [dontNotify(roomId)] : [];
      },
    ),
    addPushRule: vi.fn(
      async (
        _scope: string,
        kind: string,
        roomId: string,
        body: { actions: string[] },
      ) => {
        const rule = { rule_id: roomId, enabled: true, actions: body.actions };
        if (kind === 'override') {
          serverRules.global.override = [rule];
        } else {
          serverRules.global.room = [rule];
        }
        return {};
      },
    ),
    deletePushRule: vi.fn(
      async (_scope: string, kind: string, roomId: string) => {
        if (kind === 'override') {
          serverRules.global.override = serverRules.global.override.filter(
            (rule) => rule.rule_id !== roomId,
          );
        } else {
          serverRules.global.room = serverRules.global.room.filter(
            (rule) => rule.rule_id !== roomId,
          );
        }
        return {};
      },
    ),
    getPushRules: vi.fn(async () => {
      client.pushRules = structuredClone(serverRules);
      return client.pushRules;
    }),
    on: vi.fn(),
    off: vi.fn(),
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
        accountIds: (() => ['@me:hs']) as never,
        all: () => [{ client }] as never,
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

    it('reacts to push rules delivered by account-data sync', () => {
      const { svc, client } = setup();
      const observed: RoomNotifyMode[] = [];
      TestBed.runInInjectionContext(() =>
        effect(() => observed.push(svc.modeFor(ROOM))),
      );
      svc.connect();
      TestBed.tick();

      client.pushRules.global.room = [dontNotify(ROOM)];
      const handler = client.on.mock.calls.find(
        ([event]) => event === ClientEvent.AccountData,
      )?.[1] as (() => void) | undefined;
      handler?.();
      TestBed.tick();

      expect(observed.at(-1)).toBe('mentions');
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

    it('restores the previous server mode when a multi-step update fails', async () => {
      const originalMute = dontNotify(ROOM);
      const serverRules = {
        global: { override: [originalMute], room: [] as Rule[] },
      };
      const { svc, client } = setup({ override: [originalMute] });
      client.deletePushRule.mockImplementation(async () => {
        serverRules.global.override = [];
        return {};
      });
      client.setRoomMutePushRule.mockRejectedValueOnce(
        new Error('homeserver unavailable'),
      );
      client.addPushRule.mockImplementation(async () => {
        serverRules.global.override = [originalMute];
        return {};
      });
      client.getPushRules.mockImplementation(async () => {
        client.pushRules = structuredClone(serverRules);
        return client.pushRules;
      });

      await expect(
        firstValueFrom(svc.setMode(ROOM, 'mentions')),
      ).rejects.toThrow('homeserver unavailable');

      expect(serverRules.global.override).toEqual([originalMute]);
      expect(client.pushRules).toEqual(serverRules);
      expect(svc.modeFor(ROOM)).toBe('mute');
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
          clientFor: vi.fn((id: string) => {
            if (id === '@owner:hs') return ownerClient as never;
            if (id === '@active:hs') return activeClient as never;
            return null;
          }),
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

  it('restores every account when one merged-row update fails', async () => {
    const { svc, activeClient, ownerClient } = setupOwned();
    ownerClient.addPushRule.mockRejectedValueOnce(new Error('owner offline'));

    await expect(
      firstValueFrom(
        svc.setModeForAccounts(ROOM, 'mute', ['@owner:hs', '@active:hs']),
      ),
    ).rejects.toMatchObject({ restored: true });

    expect(svc.modeFor(ROOM)).toBe('all');
    expect(svc.modeFor(ROOM, '@owner:hs')).toBe('mentions');
    expect(activeClient.deletePushRule).toHaveBeenCalledWith(
      'global',
      'override',
      ROOM,
    );
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
