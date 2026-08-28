import { effect } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ClientEvent, ConditionKind, PushRuleKind } from 'matrix-js-sdk';
import { MockProvider } from 'ng-mocks';
import { firstValueFrom } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import {
  RoomNotificationsService,
  type RoomNotifyMode,
} from './room-notifications.service';

const ROOM = '!r:hs';
const OTHER_ROOM = '!other:hs';

interface Rule {
  rule_id: string;
  enabled: boolean;
  default: boolean;
  actions: string[];
  conditions?: Array<{ kind: string; key?: string; pattern?: string }>;
  pattern?: string;
}

/** A fake client whose push-rule methods record calls and mutate an in-memory ruleset. */
function makeClient(
  seed: { override?: Rule[]; room?: Rule[] } = {},
  userId = '@me:hs',
) {
  const serverRules = {
    global: {
      override: structuredClone(seed.override ?? []),
      room: structuredClone(seed.room ?? []),
    },
  };
  const client = {
    getUserId: vi.fn(() => userId),
    pushRules: structuredClone(serverRules),
    getRoomPushRule: vi.fn((_scope: string, roomId: string) =>
      client.pushRules.global.room.find((r) => r.rule_id === roomId),
    ),
    setRoomMutePushRule: vi.fn(
      async (_scope: string, roomId: string, mute: boolean) => {
        serverRules.global.room = mute ? [roomMute(roomId)] : [];
      },
    ),
    addPushRule: vi.fn(
      async (
        _scope: string,
        kind: string,
        roomId: string,
        body: {
          actions: string[];
          conditions?: Rule['conditions'];
          pattern?: string;
        },
      ) => {
        const rules =
          kind === PushRuleKind.Override
            ? serverRules.global.override
            : serverRules.global.room;
        const index = rules.findIndex((rule) => rule.rule_id === roomId);
        const rule: Rule = {
          rule_id: roomId,
          enabled: index >= 0 ? (rules[index]?.enabled ?? true) : true,
          default: false,
          actions: structuredClone(body.actions),
          ...(body.conditions
            ? { conditions: structuredClone(body.conditions) }
            : {}),
          ...(body.pattern !== undefined ? { pattern: body.pattern } : {}),
        };
        if (index >= 0) {
          rules[index] = rule;
        } else {
          rules.push(rule);
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
    setPushRuleEnabled: vi.fn(
      async (
        _scope: string,
        kind: string,
        roomId: string,
        enabled: boolean,
      ) => {
        const rules =
          kind === PushRuleKind.Override
            ? serverRules.global.override
            : serverRules.global.room;
        const rule = rules.find((candidate) => candidate.rule_id === roomId);
        if (!rule) throw new Error('missing push rule');
        rule.enabled = enabled;
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
  return { client, serverRules };
}

function setup(seed?: { override?: Rule[]; room?: Rule[] }) {
  const { client, serverRules } = makeClient(seed);
  TestBed.configureTestingModule({
    providers: [
      RoomNotificationsService,
      MockProvider(MatrixClientService, {
        isInitialized: true,
        instance: client as never,
        activeUserId: (() => '@me:hs') as never,
        clientFor: vi.fn((id: string) =>
          id === '@me:hs' ? (client as never) : null,
        ),
        accountIds: (() => ['@me:hs']) as never,
        all: () => [{ client }] as never,
      }),
    ],
  });
  return { svc: TestBed.inject(RoomNotificationsService), client, serverRules };
}

const roomMute = (rule_id: string, enabled = true): Rule => ({
  rule_id,
  enabled,
  default: false,
  actions: ['dont_notify'],
});

const overrideMute = (rule_id: string, enabled = true): Rule => ({
  ...roomMute(rule_id, enabled),
  conditions: [
    { kind: ConditionKind.EventMatch, key: 'room_id', pattern: rule_id },
  ],
});

describe('RoomNotificationsService', () => {
  describe('modeFor', () => {
    it('reports "all" with no room rules', () => {
      expect(setup().svc.modeFor(ROOM)).toBe('all');
    });

    it('reports "mentions" for a room-kind dont_notify rule', () => {
      const { svc } = setup({ room: [roomMute(ROOM)] });
      expect(svc.modeFor(ROOM)).toBe('mentions');
    });

    it('reports "mute" for an override dont_notify rule', () => {
      const { svc } = setup({ override: [overrideMute(ROOM)] });
      expect(svc.modeFor(ROOM)).toBe('mute');
    });

    it('prefers mute when both an override and a room rule exist', () => {
      const { svc } = setup({
        override: [overrideMute(ROOM)],
        room: [roomMute(ROOM)],
      });
      expect(svc.modeFor(ROOM)).toBe('mute');
    });

    it('ignores a disabled override rule', () => {
      const { svc } = setup({
        override: [overrideMute(ROOM, false)],
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

      client.pushRules.global.room = [roomMute(ROOM)];
      const handler = client.on.mock.calls.find(
        ([event]) => event === ClientEvent.AccountData,
      )?.[1] as (() => void) | undefined;
      handler?.();
      TestBed.tick();

      expect(observed.at(-1)).toBe('mentions');
    });
  });

  describe('setMode', () => {
    it('mentions → adds the room-kind dont_notify rule and disables any override', async () => {
      const { svc, client } = setup({ override: [overrideMute(ROOM)] });
      await firstValueFrom(svc.setMode(ROOM, 'mentions'));
      expect(client.setPushRuleEnabled).toHaveBeenCalledWith(
        'global',
        'override',
        ROOM,
        false,
      );
      expect(client.addPushRule).toHaveBeenCalledWith(
        'global',
        PushRuleKind.RoomSpecific,
        ROOM,
        { actions: ['dont_notify'] },
      );
    });

    it('mute → disables the room rule and adds an override dont_notify rule', async () => {
      const { svc, client } = setup();
      await firstValueFrom(svc.setMode(ROOM, 'mute'));
      expect(client.addPushRule).toHaveBeenCalledWith(
        'global',
        'override',
        ROOM,
        expect.objectContaining({ actions: ['dont_notify'] }),
      );
    });

    it('all → disables both the override and room rules without losing priority', async () => {
      const { svc, client } = setup({
        override: [overrideMute(ROOM)],
        room: [roomMute(ROOM)],
      });
      await firstValueFrom(svc.setMode(ROOM, 'all'));
      expect(client.setPushRuleEnabled).toHaveBeenCalledWith(
        'global',
        'override',
        ROOM,
        false,
      );
      expect(client.setPushRuleEnabled).toHaveBeenCalledWith(
        'global',
        PushRuleKind.RoomSpecific,
        ROOM,
        false,
      );
      expect(client.deletePushRule).not.toHaveBeenCalled();
    });

    it('mute is idempotent — no duplicate override rule', async () => {
      const { svc, client } = setup({ override: [overrideMute(ROOM)] });
      await firstValueFrom(svc.setMode(ROOM, 'mute'));
      expect(client.addPushRule).not.toHaveBeenCalled();
    });

    it('is cold — nothing is written until subscribed', () => {
      const { svc, client } = setup();
      svc.setMode(ROOM, 'mute'); // not subscribed
      expect(client.addPushRule).not.toHaveBeenCalled();
      expect(client.deletePushRule).not.toHaveBeenCalled();
    });

    it('restores the previous server mode when a multi-step update fails', async () => {
      const originalMute = overrideMute(ROOM);
      const { svc, client, serverRules } = setup({
        override: [originalMute],
      });
      client.addPushRule.mockRejectedValueOnce(
        new Error('homeserver unavailable'),
      );

      await expect(
        firstValueFrom(svc.setMode(ROOM, 'mentions')),
      ).rejects.toThrow('homeserver unavailable');

      expect(serverRules.global.override).toEqual([originalMute]);
      expect(client.pushRules).toEqual(serverRules);
      expect(svc.modeFor(ROOM)).toBe('mute');
    });

    it('keeps the original override priority when a transition rolls back', async () => {
      const otherMute = overrideMute(OTHER_ROOM);
      const originalMute = overrideMute(ROOM);
      const { svc, client, serverRules } = setup({
        override: [otherMute, originalMute],
      });
      client.addPushRule.mockRejectedValueOnce(new Error('room write failed'));

      await expect(
        firstValueFrom(svc.setMode(ROOM, 'mentions')),
      ).rejects.toThrow('room write failed');

      expect(serverRules.global.override).toEqual([otherMute, originalMute]);
      expect(client.deletePushRule).not.toHaveBeenCalledWith(
        'global',
        PushRuleKind.Override,
        ROOM,
      );
    });

    it('does not overwrite unverified state when the compensating read fails', async () => {
      const original = roomMute(ROOM);
      const { svc, client, serverRules } = setup({ room: [original] });
      const readRules = client.getPushRules.getMockImplementation()!;
      client.getPushRules
        .mockImplementationOnce(readRules)
        .mockRejectedValueOnce(new Error('post-write refresh failed'))
        .mockRejectedValueOnce(new Error('compensating refresh failed'))
        .mockImplementationOnce(readRules);

      await expect(
        firstValueFrom(svc.setMode(ROOM, 'mute')),
      ).rejects.toMatchObject({ restored: false });

      expect(serverRules.global.room).toEqual([roomMute(ROOM, false)]);
      expect(serverRules.global.override).toEqual([overrideMute(ROOM)]);
      expect(svc.modeFor(ROOM)).toBe('mute');
    });

    it('preserves a newer remote edit instead of compensating over it', async () => {
      const original = roomMute(ROOM);
      const remote = { ...roomMute(ROOM), actions: ['notify'] };
      const { svc, client, serverRules } = setup({ room: [original] });
      const readRules = client.getPushRules.getMockImplementation()!;
      client.getPushRules
        .mockImplementationOnce(readRules)
        .mockImplementationOnce(() => {
          serverRules.global.room = [remote];
          return readRules();
        });
      client.addPushRule.mockRejectedValueOnce(new Error('override failed'));

      await expect(
        firstValueFrom(svc.setMode(ROOM, 'mute')),
      ).rejects.toMatchObject({ restored: false });

      expect(serverRules.global.room).toEqual([remote]);
      expect(client.addPushRule).toHaveBeenCalledTimes(1);
    });

    it('restores the owned override when preserving a newer room-rule edit', async () => {
      const originalRoom = roomMute(ROOM);
      const originalOverride = overrideMute(ROOM);
      const remoteRoom = { ...roomMute(ROOM), actions: ['notify'] };
      const { svc, client, serverRules } = setup({
        room: [originalRoom],
        override: [originalOverride],
      });
      const readRules = client.getPushRules.getMockImplementation()!;
      client.getPushRules
        .mockImplementationOnce(readRules)
        .mockRejectedValueOnce(new Error('post-write refresh failed'))
        .mockImplementationOnce(() => {
          serverRules.global.room = [remoteRoom];
          return readRules();
        });

      await expect(
        firstValueFrom(svc.setMode(ROOM, 'all')),
      ).rejects.toMatchObject({ restored: false });

      expect(serverRules.global.room).toEqual([remoteRoom]);
      expect(serverRules.global.override).toEqual([originalOverride]);
    });

    it('restores the owned room rule when preserving a newer override edit', async () => {
      const originalRoom = roomMute(ROOM);
      const originalOverride = overrideMute(ROOM);
      const remoteOverride = { ...overrideMute(ROOM), actions: ['notify'] };
      const { svc, client, serverRules } = setup({
        room: [originalRoom],
        override: [originalOverride],
      });
      const readRules = client.getPushRules.getMockImplementation()!;
      client.getPushRules
        .mockImplementationOnce(readRules)
        .mockRejectedValueOnce(new Error('post-write refresh failed'))
        .mockImplementationOnce(() => {
          serverRules.global.override = [remoteOverride];
          return readRules();
        });

      await expect(
        firstValueFrom(svc.setMode(ROOM, 'all')),
      ).rejects.toMatchObject({ restored: false });

      expect(serverRules.global.room).toEqual([originalRoom]);
      expect(serverRules.global.override).toEqual([remoteOverride]);
    });

    it('snapshots fresh server state before compensating a failed update', async () => {
      const { svc, client, serverRules } = setup();
      // Another client changed the homeserver, but this SDK cache has not synced it yet.
      serverRules.global.room = [roomMute(ROOM)];
      expect(svc.modeFor(ROOM)).toBe('all');
      client.addPushRule.mockRejectedValueOnce(
        new Error('override write failed'),
      );

      await expect(firstValueFrom(svc.setMode(ROOM, 'mute'))).rejects.toThrow(
        'override write failed',
      );

      expect(serverRules.global.room).toEqual([roomMute(ROOM)]);
      expect(serverRules.global.override).toEqual([]);
      expect(svc.modeFor(ROOM)).toBe('mentions');
    });

    it('preserves custom rule bodies instead of overwriting them', async () => {
      const custom: Rule = {
        rule_id: ROOM,
        enabled: false,
        default: false,
        actions: ['notify'],
        pattern: 'custom',
      };
      const { svc, client, serverRules } = setup({ room: [custom] });

      await expect(
        firstValueFrom(svc.setMode(ROOM, 'mentions')),
      ).rejects.toThrow('custom notification rule');

      expect(serverRules.global.room).toEqual([custom]);
      expect(client.addPushRule).not.toHaveBeenCalled();
      expect(client.deletePushRule).not.toHaveBeenCalled();
    });

    it('rejects a success response when the requested mode was not applied', async () => {
      const { svc, client } = setup();
      client.addPushRule.mockResolvedValue({});

      await expect(firstValueFrom(svc.setMode(ROOM, 'mute'))).rejects.toThrow(
        'did not apply',
      );
    });

    it('serializes overlapping choices so the latest mode wins', async () => {
      const { svc, client } = setup();
      const addRule = client.addPushRule.getMockImplementation()!;
      let releaseFirst!: () => void;
      const firstGate = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      client.addPushRule.mockImplementationOnce(async (...args) => {
        await firstGate;
        return addRule(...args);
      });

      const first = firstValueFrom(svc.setMode(ROOM, 'mute'));
      await vi.waitFor(() =>
        expect(client.addPushRule).toHaveBeenCalledTimes(1),
      );
      const second = firstValueFrom(svc.setMode(ROOM, 'mentions'));
      await Promise.resolve();
      expect(client.addPushRule).toHaveBeenCalledTimes(1);

      releaseFirst();
      await Promise.all([first, second]);

      expect(svc.modeFor(ROOM)).toBe('mentions');
    });

    it('serializes different rooms because their refreshes replace one shared cache', async () => {
      const { svc, client, serverRules } = setup();
      const readRules = client.getPushRules.getMockImplementation()!;
      let releaseFirst!: () => void;
      const firstGate = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      client.getPushRules.mockImplementationOnce(async () => {
        await firstGate;
        return readRules();
      });

      const first = firstValueFrom(svc.setMode(ROOM, 'mute'));
      await vi.waitFor(() =>
        expect(client.getPushRules).toHaveBeenCalledTimes(1),
      );
      const second = firstValueFrom(svc.setMode(OTHER_ROOM, 'mute'));
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      expect(client.getPushRules).toHaveBeenCalledTimes(1);

      releaseFirst();
      await Promise.all([first, second]);

      expect(serverRules.global.override.map((rule) => rule.rule_id)).toEqual([
        ROOM,
        OTHER_ROOM,
      ]);
      expect(svc.modeFor(ROOM)).toBe('mute');
      expect(svc.modeFor(OTHER_ROOM)).toBe('mute');
    });

    it('waits for a failed update to restore before applying the queued choice', async () => {
      const { svc, client } = setup({ room: [roomMute(ROOM)] });
      const setEnabled = client.setPushRuleEnabled.getMockImplementation()!;
      let rollbackStarted!: () => void;
      const rollbackHasStarted = new Promise<void>((resolve) => {
        rollbackStarted = resolve;
      });
      let releaseRollback!: () => void;
      const rollbackGate = new Promise<void>((resolve) => {
        releaseRollback = resolve;
      });
      client.setPushRuleEnabled.mockImplementation(async (...args) => {
        const enabled = args[3];
        if (enabled) {
          rollbackStarted();
          await rollbackGate;
        }
        return setEnabled(...args);
      });
      client.addPushRule.mockRejectedValueOnce(new Error('override failed'));

      const first = firstValueFrom(svc.setMode(ROOM, 'mute'));
      await rollbackHasStarted;
      const second = firstValueFrom(svc.setMode(ROOM, 'mentions'));
      const readsBeforeRelease = client.getPushRules.mock.calls.length;
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      expect(client.getPushRules).toHaveBeenCalledTimes(readsBeforeRelease);

      releaseRollback();
      await expect(first).rejects.toThrow('override failed');
      await second;

      expect(svc.modeFor(ROOM)).toBe('mentions');
    });
  });
});

// A mixed-account sidebar row can belong to an account that isn't active. Push rules live
// per-account, so reading or writing them through the active client reports the wrong level
// and mutes the wrong account while the menu claims success.
describe('RoomNotificationsService per-account rules', () => {
  function setupOwned() {
    const { client: activeClient } = makeClient({}, '@active:hs');
    const { client: ownerClient } = makeClient(
      {
        room: [roomMute(ROOM)],
      },
      '@owner:hs',
    );
    TestBed.configureTestingModule({
      providers: [
        RoomNotificationsService,
        MockProvider(MatrixClientService, {
          isInitialized: true,
          instance: activeClient as never,
          activeUserId: (() => '@active:hs') as never,
          accountIds: (() => ['@active:hs', '@owner:hs']) as never,
          all: () =>
            [{ client: activeClient }, { client: ownerClient }] as never,
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

  it('reports a mixed mode when merged accounts disagree', () => {
    const { svc } = setupOwned();

    expect(svc.modeForAccounts(ROOM, ['@owner:hs', '@active:hs'])).toBe(
      'mixed',
    );
  });

  it('writes the level to the owning account, not the active one', async () => {
    const { svc, activeClient, ownerClient } = setupOwned();

    await firstValueFrom(svc.setMode(ROOM, 'mute', '@owner:hs'));

    expect(ownerClient.addPushRule).toHaveBeenCalledWith(
      'global',
      PushRuleKind.Override,
      ROOM,
      expect.objectContaining({ actions: ['dont_notify'] }),
    );
    expect(activeClient.addPushRule).not.toHaveBeenCalled();
  });

  it('resolves a replacement account client when queued work begins', async () => {
    const { client: activeClient } = makeClient({}, '@active:hs');
    const { client: oldOwnerClient } = makeClient({}, '@owner:hs');
    const { client: newOwnerClient } = makeClient({}, '@owner:hs');
    let ownerClient = oldOwnerClient;
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const readActiveRules = activeClient.getPushRules.getMockImplementation()!;
    activeClient.getPushRules.mockImplementationOnce(async () => {
      await firstGate;
      return readActiveRules();
    });
    TestBed.configureTestingModule({
      providers: [
        RoomNotificationsService,
        MockProvider(MatrixClientService, {
          isInitialized: true,
          instance: activeClient as never,
          activeUserId: (() => '@active:hs') as never,
          clientFor: vi.fn((id: string) => {
            if (id === '@active:hs') return activeClient as never;
            if (id === '@owner:hs') return ownerClient as never;
            return null;
          }),
        }),
      ],
    });
    const svc = TestBed.inject(RoomNotificationsService);

    const first = firstValueFrom(svc.setMode(ROOM, 'mute', '@active:hs'));
    await vi.waitFor(() =>
      expect(activeClient.getPushRules).toHaveBeenCalledTimes(1),
    );
    const second = firstValueFrom(svc.setMode(ROOM, 'mute', '@owner:hs'));
    ownerClient = newOwnerClient;

    releaseFirst();
    await Promise.all([first, second]);

    expect(oldOwnerClient.addPushRule).not.toHaveBeenCalled();
    expect(newOwnerClient.addPushRule).toHaveBeenCalledWith(
      'global',
      PushRuleKind.Override,
      ROOM,
      expect.objectContaining({ actions: ['dont_notify'] }),
    );
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
