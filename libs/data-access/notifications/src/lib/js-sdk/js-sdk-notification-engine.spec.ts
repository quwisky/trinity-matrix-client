import { TestBed } from '@angular/core/testing';
import {
  ClientEvent,
  EventType,
  MatrixError,
  RoomEvent,
  SyncState,
} from 'matrix-js-sdk';
import { firstValueFrom } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { JS_SDK_CLIENTS } from '@trinity/data-access/matrix-client';
import type { NotificationSettings, PushRoom } from '../notification-engine';
import { JsSdkNotificationEngine } from './js-sdk-notification-engine';

const ALICE = '@alice:hs';

interface Rules {
  global: Record<string, unknown[] | undefined>;
}

function fakeClient(initial?: Rules) {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const client = {
    pushRules: initial,
    server: initial,
    accountData: {} as Record<string, unknown>,
    getAccountData: (type: string) =>
      type in client.accountData
        ? { getContent: () => client.accountData[type] }
        : undefined,
    /** Stores and echoes the event, as the SDK resolves only after the sync echo. */
    setAccountData: vi.fn(async (type: string, content: unknown) => {
      client.accountData[type] = content;
      client.emit(ClientEvent.AccountData, { getType: () => type });
      return {};
    }),
    emit(event: string, ...args: unknown[]) {
      for (const fn of listeners.get(event) ?? []) fn(...args);
    },
    on(event: string, fn: (...args: unknown[]) => void) {
      (listeners.get(event) ?? listeners.set(event, new Set()).get(event))?.add(
        fn,
      );
    },
    off(event: string, fn: (...args: unknown[]) => void) {
      listeners.get(event)?.delete(fn);
    },
    /** Assigns the server's rules, as the SDK's getPushRules does. */
    getPushRules: vi.fn(async () => {
      client.pushRules = client.server;
      return client.pushRules;
    }),
    addPushRule: vi.fn().mockResolvedValue({}),
    deletePushRule: vi.fn().mockResolvedValue({}),
    setPushRuleEnabled: vi.fn().mockResolvedValue({}),
    getDeviceId: vi.fn((): string | null => 'DEV1'),
    setPusher: vi.fn().mockResolvedValue({}),
    removePusher: vi.fn().mockResolvedValue({}),
    getPushers: vi.fn().mockResolvedValue({ pushers: [] }),
    rooms: [] as {
      roomId: string;
      name: string;
      membership: string;
      /** Whether the room's state holds `m.room.encryption`. */
      encryptionState?: boolean;
    }[],
    getRooms: () =>
      client.rooms.map((room) => ({
        roomId: room.roomId,
        name: room.name,
        getMyMembership: () => room.membership,
        hasEncryptionStateEvent: () => room.encryptionState === true,
      })),
    /** Per room, the crypto store's answer; a room left out never answers. */
    storeEncrypted: {} as Record<string, boolean>,
    getCrypto: () => ({
      isEncryptionEnabledInRoom: (roomId: string) =>
        roomId in client.storeEncrypted
          ? Promise.resolve(client.storeEncrypted[roomId])
          : new Promise<boolean>(() => undefined),
    }),
  };
  return client;
}

const KEYWORD_ACTIONS = [
  'notify',
  { set_tweak: 'sound', value: 'default' },
  { set_tweak: 'highlight' },
];

const keyword = (ruleId: unknown, pattern: unknown, enabled = true) => ({
  rule_id: ruleId,
  pattern,
  enabled,
  default: false,
  actions: ['notify'],
});

describe('JsSdkNotificationEngine', () => {
  let client: ReturnType<typeof fakeClient>;
  let engine: JsSdkNotificationEngine;

  function setup(initial?: Rules): void {
    client = fakeClient(initial);
    TestBed.configureTestingModule({
      providers: [
        {
          provide: JS_SDK_CLIENTS,
          useValue: {
            clientFor: (id: string) => (id === ALICE ? client : null),
          },
        },
      ],
    });
    engine = TestBed.inject(JsSdkNotificationEngine);
  }

  beforeEach(() => TestBed.resetTestingModule());

  it('reads the cached rules synchronously, skipping malformed ones and folding keywords by word', () => {
    setup({
      global: {
        override: [
          { rule_id: '.m.rule.master', enabled: false, default: true },
          null,
          { rule_id: 'custom-override', enabled: true },
        ],
        content: [
          { rule_id: '.m.rule.contains_user_name', enabled: true },
          keyword('cat', 'cat', false),
          keyword('Cat-2', 'cat', true),
          keyword('dog', undefined),
          keyword(7, 'bird'),
          { rule_id: 'no-actions', pattern: 'x' },
        ],
        underride: [{ rule_id: '.m.rule.message', enabled: true }],
      },
    });
    const seen: NotificationSettings[] = [];

    engine.settings(ALICE).subscribe((settings) => seen.push(settings));

    expect(seen).toEqual([
      {
        loaded: true,
        defaultRules: [
          { ruleId: '.m.rule.master', kind: 'override', enabled: false },
          {
            ruleId: '.m.rule.contains_user_name',
            kind: 'content',
            enabled: true,
          },
          { ruleId: '.m.rule.message', kind: 'underride', enabled: true },
        ],
        keywords: [
          { pattern: 'cat', enabled: true },
          { pattern: 'dog', enabled: true },
        ],
        roomModes: {},
        sound: true,
        reactionNotifications: false,
      },
    ]);
  });

  it('emits unloaded before the rules sync, then the rules once a sync brings them', async () => {
    setup();
    const seen: NotificationSettings[] = [];
    engine.settings(ALICE).subscribe((settings) => seen.push(settings));
    expect(seen).toEqual([
      {
        loaded: false,
        defaultRules: [],
        keywords: [],
        roomModes: {},
        sound: true,
        reactionNotifications: false,
      },
    ]);

    client.pushRules = { global: { content: [keyword('cat', 'cat')] } };
    client.emit(ClientEvent.Sync, 'PREPARED');
    client.emit(ClientEvent.Sync, 'SYNCING');
    await Promise.resolve();

    expect(seen).toHaveLength(2);
    expect(seen[1].keywords).toEqual([{ pattern: 'cat', enabled: true }]);

    // Once loaded, changes arrive as m.push_rules account data, not per sync.
    client.pushRules = { global: { content: [] } };
    client.emit(ClientEvent.Sync, 'SYNCING');
    await Promise.resolve();
    expect(seen).toHaveLength(2);
  });

  it('re-emits on an m.push_rules change only', async () => {
    setup({ global: { content: [] } });
    const seen: NotificationSettings[] = [];
    engine.settings(ALICE).subscribe((settings) => seen.push(settings));

    client.pushRules = { global: { content: [keyword('cat', 'cat')] } };
    client.emit(ClientEvent.AccountData, { getType: () => 'm.direct' });
    await Promise.resolve();
    expect(seen).toHaveLength(1);

    client.emit(ClientEvent.AccountData, { getType: () => 'm.push_rules' });
    await Promise.resolve();
    expect(seen).toHaveLength(2);
  });

  it('adds a rule keyed by the word, then replies after the refreshed snapshot', async () => {
    setup({ global: { content: [] } });
    const seen: NotificationSettings[] = [];
    engine.settings(ALICE).subscribe((settings) => seen.push(settings));
    client.server = { global: { content: [keyword('cat', 'cat')] } };

    const result = await firstValueFrom(engine.setKeyword(ALICE, 'cat'));

    expect(result).toEqual({ ok: true, value: null });
    expect(client.addPushRule).toHaveBeenCalledWith(
      'global',
      'content',
      'cat',
      {
        pattern: 'cat',
        actions: KEYWORD_ACTIONS,
      },
    );
    expect(seen.at(-1)?.keywords).toEqual([{ pattern: 'cat', enabled: true }]);
  });

  it('rewrites and enables the first rule of a disabled keyword, and leaves an enabled one alone', async () => {
    setup({
      global: {
        content: [keyword('Cat-1', 'cat', false), keyword('cat', 'cat', false)],
      },
    });

    await firstValueFrom(engine.setKeyword(ALICE, 'cat'));
    expect(client.addPushRule).toHaveBeenCalledExactlyOnceWith(
      'global',
      'content',
      'Cat-1',
      { pattern: 'cat', actions: KEYWORD_ACTIONS },
    );
    expect(client.setPushRuleEnabled).toHaveBeenCalledExactlyOnceWith(
      'global',
      'content',
      'Cat-1',
      true,
    );

    client.pushRules = { global: { content: [keyword('cat', 'cat', true)] } };
    client.addPushRule.mockClear();
    client.setPushRuleEnabled.mockClear();
    await firstValueFrom(engine.setKeyword(ALICE, 'cat'));
    expect(client.addPushRule).not.toHaveBeenCalled();
    expect(client.setPushRuleEnabled).not.toHaveBeenCalled();
  });

  it('enables a disabled rule it overwrites because its id is the word', async () => {
    // Legacy re-point data: id `OnCall`, pattern `oncall`. The PUT rewrites the pattern but
    // the server keeps the stored enabled flag.
    setup({ global: { content: [keyword('OnCall', 'oncall', false)] } });

    await firstValueFrom(engine.setKeyword(ALICE, 'OnCall'));

    expect(client.addPushRule).toHaveBeenCalledWith(
      'global',
      'content',
      'OnCall',
      { pattern: 'OnCall', actions: KEYWORD_ACTIONS },
    );
    expect(client.setPushRuleEnabled).toHaveBeenCalledWith(
      'global',
      'content',
      'OnCall',
      true,
    );
  });

  it('deletes every rule for a word, also one keyed by another id', async () => {
    setup({
      global: {
        content: [
          keyword('cat', 'cat'),
          keyword('dog', 'dog'),
          keyword('Cat-2', 'cat'),
        ],
      },
    });

    await firstValueFrom(engine.removeKeyword(ALICE, 'cat'));

    expect(client.deletePushRule.mock.calls).toEqual([
      ['global', 'content', 'cat'],
      ['global', 'content', 'Cat-2'],
    ]);
  });

  it('enables each named rule', async () => {
    setup({ global: {} });

    await firstValueFrom(
      engine.setPushRulesEnabled(
        ALICE,
        [
          { ruleId: '.m.rule.master', kind: 'override' },
          { ruleId: '.m.rule.message', kind: 'underride' },
        ],
        true,
      ),
    );

    expect(client.setPushRuleEnabled.mock.calls).toEqual([
      ['global', 'override', '.m.rule.master', true],
      ['global', 'underride', '.m.rule.message', true],
    ]);
  });

  it('reports a landed write as done when the refresh fails', async () => {
    setup({ global: {} });
    client.getPushRules.mockRejectedValueOnce(new Error('offline'));

    expect(await firstValueFrom(engine.setKeyword(ALICE, 'cat'))).toEqual({
      ok: true,
      value: null,
    });
  });

  it('re-reads and publishes the rules after a partly failed write', async () => {
    setup({
      global: { content: [keyword('cat', 'cat'), keyword('Cat-2', 'cat')] },
    });
    const seen: NotificationSettings[] = [];
    const sub = engine.settings(ALICE).subscribe((s) => seen.push(s));
    client.server = { global: { content: [keyword('Cat-2', 'cat')] } };
    client.deletePushRule
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('offline'));

    const result = await firstValueFrom(engine.removeKeyword(ALICE, 'cat'));
    sub.unsubscribe();

    expect(result.ok).toBe(false);
    expect(client.getPushRules).toHaveBeenCalled();
    expect(seen.at(-1)?.keywords).toEqual([{ pattern: 'cat', enabled: true }]);
    expect(client.pushRules).toBe(client.server);
  });

  it('reports a refused write as request-failed', async () => {
    setup({ global: {} });
    client.addPushRule.mockRejectedValueOnce(
      new MatrixError({ errcode: 'M_FORBIDDEN', error: 'no' }, 403),
    );

    const result = await firstValueFrom(engine.setKeyword(ALICE, 'cat'));

    expect(result.ok || result.failure).toMatchObject({
      code: 'request-failed',
      kind: 'permission',
    });
  });

  describe('room modes', () => {
    const ROOM = '!r:hs';
    const roomMatch = (roomId: string) => [
      { kind: 'event_match', key: 'room_id', pattern: roomId },
    ];

    it('classifies rooms as Rust does, counting only enabled rules', () => {
      setup({
        global: {
          override: [
            { rule_id: '.m.rule.master', enabled: false, default: true },
            // Legacy no-notify actions mute as well as `[]` does.
            {
              rule_id: 'a',
              enabled: true,
              actions: ['dont_notify'],
              conditions: roomMatch('!muted:hs'),
            },
            {
              rule_id: '!off:hs',
              enabled: false,
              actions: [],
              conditions: roomMatch('!off:hs'),
            },
            {
              rule_id: '!both:hs',
              enabled: true,
              actions: [],
              conditions: roomMatch('!both:hs'),
            },
            {
              rule_id: 'loud',
              enabled: true,
              actions: ['notify'],
              conditions: roomMatch('!loud:hs'),
            },
          ],
          room: [
            { rule_id: '!mentions:hs', enabled: true, actions: ['coalesce'] },
            { rule_id: '!both:hs', enabled: true, actions: [] },
            { rule_id: '!off:hs', enabled: false, actions: [] },
            { rule_id: '!loud:hs', enabled: true, actions: ['notify'] },
          ],
        },
      });
      let latest: NotificationSettings | undefined;
      engine.settings(ALICE).subscribe((settings) => (latest = settings));

      expect(latest?.roomModes).toEqual({
        '!muted:hs': 'mute',
        '!both:hs': 'mute',
        '!mentions:hs': 'mentions',
      });
    });

    it('re-reads the server, writes the mode’s rule first, then deletes the room’s other rules', async () => {
      setup({ global: {} });
      client.server = {
        global: {
          override: [
            {
              rule_id: 'custom',
              enabled: true,
              actions: ['notify'],
              conditions: roomMatch(ROOM),
            },
            {
              rule_id: 'other',
              enabled: true,
              actions: [],
              conditions: roomMatch('!x:hs'),
            },
          ],
          room: [{ rule_id: ROOM, enabled: true, actions: ['notify'] }],
          underride: [{ rule_id: ROOM, enabled: true, actions: ['notify'] }],
        },
      };
      const order: string[] = [];
      client.addPushRule.mockImplementation(async (_scope, kind, id) => {
        order.push(`put ${kind} ${id}`);
        return {};
      });
      client.deletePushRule.mockImplementation(async (_scope, kind, id) => {
        order.push(`delete ${kind} ${id}`);
        return {};
      });

      const result = await firstValueFrom(
        engine.setRoomMode(ALICE, ROOM, 'mute'),
      );

      expect(result).toEqual({ ok: true, value: null });
      expect(client.addPushRule).toHaveBeenCalledWith(
        'global',
        'override',
        ROOM,
        {
          actions: [],
          conditions: roomMatch(ROOM),
        },
      );
      expect(order).toEqual([
        `put override ${ROOM}`,
        'delete override custom',
        `delete room ${ROOM}`,
        `delete underride ${ROOM}`,
      ]);
      expect(client.setPushRuleEnabled).not.toHaveBeenCalled();
    });

    it('enables a disabled rule it overwrites, and writes a notifying room rule for all', async () => {
      const disabled = {
        global: { room: [{ rule_id: ROOM, enabled: false, actions: [] }] },
      };
      setup(disabled);

      await firstValueFrom(engine.setRoomMode(ALICE, ROOM, 'mentions'));
      expect(client.setPushRuleEnabled).toHaveBeenCalledWith(
        'global',
        'room',
        ROOM,
        true,
      );

      client.server = {
        global: { room: [{ rule_id: ROOM, enabled: true, actions: [] }] },
      };
      client.server = {
        global: {
          override: [
            {
              rule_id: ROOM,
              enabled: true,
              actions: [],
              conditions: roomMatch(ROOM),
            },
          ],
          room: [{ rule_id: ROOM, enabled: true, actions: [] }],
        },
      };
      client.setPushRuleEnabled.mockClear();
      await firstValueFrom(engine.setRoomMode(ALICE, ROOM, 'all'));
      expect(client.addPushRule).toHaveBeenLastCalledWith(
        'global',
        'room',
        ROOM,
        {
          actions: ['notify', { set_tweak: 'sound', value: 'default' }],
        },
      );
      expect(client.deletePushRule.mock.calls).toEqual([
        ['global', 'override', ROOM],
      ]);
      expect(client.setPushRuleEnabled).not.toHaveBeenCalled();
    });

    it('reads a notifying room rule as all, and writes nothing for all over it', async () => {
      setup({
        global: {
          room: [{ rule_id: ROOM, enabled: true, actions: ['notify'] }],
        },
      });
      let latest: NotificationSettings | undefined;
      engine.settings(ALICE).subscribe((settings) => (latest = settings));
      expect(latest?.roomModes).toEqual({});

      await firstValueFrom(engine.setRoomMode(ALICE, ROOM, 'all'));

      expect(client.addPushRule).not.toHaveBeenCalled();
      expect(client.deletePushRule).not.toHaveBeenCalled();
    });

    it('writes the notifying room rule for all on a room without rules', async () => {
      setup({ global: {} });

      await firstValueFrom(engine.setRoomMode(ALICE, ROOM, 'all'));

      expect(client.addPushRule).toHaveBeenCalledWith('global', 'room', ROOM, {
        actions: ['notify', { set_tweak: 'sound', value: 'default' }],
      });
    });

    it('queues an account’s room-mode writes, each re-reading after the previous one', async () => {
      setup({ global: {} });
      let release = (): void => undefined;
      client.addPushRule.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = () => resolve({});
          }),
      );

      const first = firstValueFrom(engine.setRoomMode(ALICE, ROOM, 'mute'));
      const second = firstValueFrom(engine.setRoomMode(ALICE, ROOM, 'all'));
      await vi.waitFor(() => expect(client.addPushRule).toHaveBeenCalledOnce());
      // Only the first write's opening re-read so far.
      expect(client.getPushRules).toHaveBeenCalledOnce();

      release();
      await first;
      await second;

      expect(client.addPushRule).toHaveBeenCalledTimes(2);
      // first: re-read, write, re-read; second: re-read, write, re-read
      expect(client.getPushRules).toHaveBeenCalledTimes(4);
    });

    it('writes nothing when the room already has the mode', async () => {
      setup({
        global: { room: [{ rule_id: ROOM, enabled: true, actions: [] }] },
      });

      await firstValueFrom(engine.setRoomMode(ALICE, ROOM, 'mentions'));

      expect(client.getPushRules).toHaveBeenCalled();
      expect(client.addPushRule).not.toHaveBeenCalled();
      expect(client.deletePushRule).not.toHaveBeenCalled();
    });

    it('reads the mode from a fresh read of the server, and fails when that read fails', async () => {
      setup({ global: {} });
      client.server = {
        global: { room: [{ rule_id: ROOM, enabled: true, actions: [] }] },
      };

      expect(await firstValueFrom(engine.readRoomMode(ALICE, ROOM))).toEqual({
        ok: true,
        value: 'mentions',
      });

      client.getPushRules.mockRejectedValueOnce(new Error('offline'));
      const failed = await firstValueFrom(engine.readRoomMode(ALICE, ROOM));
      expect(failed.ok || failed.failure.code).toBe('request-failed');
    });
  });

  describe('preferences', () => {
    const SOUND = 'dev.trinityproject.trinity.notification_sound';
    const LEGACY_SOUND = 'eu.qwky.trinity.notification_sound';
    const REACTIONS = 'dev.trinityproject.trinity.reaction_notifications';
    const LEGACY_REACTIONS = 'eu.qwky.trinity.reaction_notifications';

    it('reads them before the push rules sync, falling back on malformed content', () => {
      setup();
      client.accountData[SOUND] = { enabled: 'no' };
      client.accountData[REACTIONS] = { enabled: true };
      let latest: NotificationSettings | undefined;
      engine.settings(ALICE).subscribe((settings) => (latest = settings));

      expect(latest).toMatchObject({
        loaded: false,
        sound: true,
        reactionNotifications: true,
      });
    });

    it('copies retired names once while subscribed, never over a current one', async () => {
      setup({ global: {} });
      client.accountData[LEGACY_SOUND] = { enabled: false };
      client.accountData[REACTIONS] = { enabled: false };
      client.accountData[LEGACY_REACTIONS] = { enabled: true };
      let latest: NotificationSettings | undefined;
      const sub = engine.settings(ALICE).subscribe((s) => (latest = s));

      expect(latest).toMatchObject({
        sound: false,
        reactionNotifications: false,
      });
      expect(client.setAccountData.mock.calls).toEqual([
        [SOUND, { enabled: false }],
      ]);
      sub.unsubscribe();
    });

    it('copies a retired name that arrives later on its account-data event', async () => {
      setup({ global: {} });
      engine.settings(ALICE).subscribe();
      client.accountData[LEGACY_REACTIONS] = { enabled: true };
      client.emit(ClientEvent.AccountData, { getType: () => LEGACY_REACTIONS });
      await Promise.resolve();

      expect(client.setAccountData).toHaveBeenCalledWith(REACTIONS, {
        enabled: true,
      });
    });

    it('writes again when the echo it waited on was an earlier write’s', async () => {
      setup({ global: {} });
      client.setAccountData.mockImplementationOnce(async (type: string) => {
        // The retired-name copy's echo lands first and resolves the wait.
        client.accountData[type] = { enabled: false };
        return {};
      });

      await firstValueFrom(engine.setPreference(ALICE, 'sound', true));

      expect(client.setAccountData).toHaveBeenCalledTimes(2);
      expect(client.accountData[SOUND]).toEqual({ enabled: true });
    });

    it('re-emits on a preference change and replies to a write after the snapshot holds it', async () => {
      setup({ global: {} });
      const seen: NotificationSettings[] = [];
      engine.settings(ALICE).subscribe((s) => seen.push(s));

      const result = await firstValueFrom(
        engine.setPreference(ALICE, 'reactionNotifications', true),
      );

      expect(result).toEqual({ ok: true, value: null });
      expect(client.setAccountData).toHaveBeenCalledWith(REACTIONS, {
        enabled: true,
      });
      expect(seen.at(-1)?.reactionNotifications).toBe(true);
    });
  });

  describe('pushers', () => {
    const PUSHER = {
      appId: 'dev.trinityproject.trinity.ios',
      pushkey: 'TOKEN',
      appDisplayName: 'Trinity',
      lang: 'en',
      url: 'https://push.example/_matrix/push/v1/notify',
      format: 'event_id_only' as const,
      data: { trinity_user_id: ALICE, trinity_render: 'device' },
    };

    it('registers an http pusher that appends, named by the device, with every data key', async () => {
      setup();

      expect(await firstValueFrom(engine.setPusher(ALICE, PUSHER))).toEqual({
        ok: true,
        value: null,
      });
      expect(client.setPusher).toHaveBeenCalledWith({
        app_id: 'dev.trinityproject.trinity.ios',
        pushkey: 'TOKEN',
        kind: 'http',
        app_display_name: 'Trinity',
        device_display_name: 'DEV1',
        lang: 'en',
        data: {
          url: 'https://push.example/_matrix/push/v1/notify',
          format: 'event_id_only',
          trinity_user_id: ALICE,
          trinity_render: 'device',
        },
        append: true,
      });
    });

    it('names the pusher Trinity without a device id, and leaves out a null format', async () => {
      setup();
      client.getDeviceId.mockReturnValue(null);

      await firstValueFrom(
        engine.setPusher(ALICE, { ...PUSHER, format: null, data: {} }),
      );

      expect(client.setPusher).toHaveBeenCalledWith(
        expect.objectContaining({
          device_display_name: 'Trinity',
          data: { url: PUSHER.url },
        }),
      );
    });

    it('removes a pusher and reads the pushers back by app id and pushkey', async () => {
      setup();
      client.getPushers.mockResolvedValue({
        pushers: [{ app_id: 'a', pushkey: 'k', kind: 'http', data: {} }],
      });

      await firstValueFrom(engine.removePusher(ALICE, 'a', 'k'));

      expect(client.removePusher).toHaveBeenCalledWith('k', 'a');
      expect(await firstValueFrom(engine.pushers(ALICE))).toEqual({
        ok: true,
        value: [{ appId: 'a', pushkey: 'k' }],
      });
    });

    it('reports a refused pusher as a failed request', async () => {
      setup();
      client.setPusher.mockRejectedValueOnce(
        new MatrixError({ errcode: 'M_UNKNOWN', error: 'bad url' }, 400),
      );

      const result = await firstValueFrom(engine.setPusher(ALICE, PUSHER));

      expect(result.ok || result.failure.code).toBe('request-failed');
    });
  });

  describe('push rooms', () => {
    const flush = () => new Promise((resolve) => setTimeout(resolve));

    function watchRooms(): (readonly PushRoom[])[] {
      const seen: (readonly PushRoom[])[] = [];
      engine.pushRooms(ALICE).subscribe((rooms) => seen.push(rooms));
      return seen;
    }

    it('lists joined rooms with names and DM flags, encrypted until the crypto store answers', async () => {
      setup();
      client.rooms = [
        { roomId: '!plain:hs', name: 'Plain', membership: 'join' },
        { roomId: '!dm:hs', name: 'Bob', membership: 'join' },
        { roomId: '!stored:hs', name: 'Stored', membership: 'join' },
        {
          roomId: '!state:hs',
          name: 'State',
          membership: 'join',
          encryptionState: true,
        },
        { roomId: '!silent:hs', name: 'Silent', membership: 'join' },
        { roomId: '!inv:hs', name: 'Invite', membership: 'invite' },
      ];
      client.accountData[EventType.Direct] = { '@bob:hs': ['!dm:hs', 7] };
      client.storeEncrypted = {
        '!plain:hs': false,
        '!dm:hs': false,
        '!stored:hs': true,
        '!state:hs': false,
      };

      const seen = watchRooms();
      expect(seen).toEqual([
        [
          {
            roomId: '!plain:hs',
            name: 'Plain',
            direct: false,
            encrypted: true,
          },
          { roomId: '!dm:hs', name: 'Bob', direct: true, encrypted: true },
          {
            roomId: '!stored:hs',
            name: 'Stored',
            direct: false,
            encrypted: true,
          },
          {
            roomId: '!state:hs',
            name: 'State',
            direct: false,
            encrypted: true,
          },
          {
            roomId: '!silent:hs',
            name: 'Silent',
            direct: false,
            encrypted: true,
          },
        ],
      ]);
      await flush();

      expect(seen.at(-1)).toEqual([
        { roomId: '!plain:hs', name: 'Plain', direct: false, encrypted: false },
        { roomId: '!dm:hs', name: 'Bob', direct: true, encrypted: false },
        {
          roomId: '!stored:hs',
          name: 'Stored',
          direct: false,
          encrypted: true,
        },
        { roomId: '!state:hs', name: 'State', direct: false, encrypted: true },
        {
          roomId: '!silent:hs',
          name: 'Silent',
          direct: false,
          encrypted: true,
        },
      ]);
    });

    it('emits the whole list again on a sync, a rename and an m.direct change, and not on other events', async () => {
      setup();
      client.rooms = [{ roomId: '!a:hs', name: 'Team', membership: 'join' }];
      client.storeEncrypted = { '!a:hs': false };
      const seen = watchRooms();
      await flush();
      const before = seen.length;

      client.emit(ClientEvent.Sync, SyncState.Syncing);
      client.emit(ClientEvent.Sync, SyncState.Reconnecting);
      client.rooms[0].name = 'Renamed';
      client.emit(RoomEvent.Name);
      client.accountData[EventType.Direct] = { '@bob:hs': ['!a:hs'] };
      client.emit(ClientEvent.AccountData, { getType: () => EventType.Direct });
      client.emit(ClientEvent.AccountData, { getType: () => 'm.other' });

      expect(seen.slice(before)).toEqual([
        [{ roomId: '!a:hs', name: 'Team', direct: false, encrypted: false }],
        [{ roomId: '!a:hs', name: 'Renamed', direct: false, encrypted: false }],
        [{ roomId: '!a:hs', name: 'Renamed', direct: true, encrypted: false }],
      ]);
    });

    it('reports a room encrypted once its state turns encryption on', async () => {
      setup();
      client.rooms = [{ roomId: '!a:hs', name: 'Team', membership: 'join' }];
      client.storeEncrypted = { '!a:hs': false };
      const seen = watchRooms();
      await flush();

      client.rooms[0].encryptionState = true;
      client.emit(ClientEvent.Sync, SyncState.Syncing);

      expect(seen.at(-1)).toEqual([
        { roomId: '!a:hs', name: 'Team', direct: false, encrypted: true },
      ]);
    });

    it('emits an empty list for an account that is not live, and stops with its subscription', async () => {
      setup();
      client.rooms = [{ roomId: '!a:hs', name: 'Team', membership: 'join' }];
      client.storeEncrypted = { '!a:hs': false };
      const nobody: (readonly PushRoom[])[] = [];
      engine.pushRooms('@nobody:hs').subscribe((rooms) => nobody.push(rooms));
      expect(nobody).toEqual([[]]);

      const seen: (readonly PushRoom[])[] = [];
      const subscription = engine
        .pushRooms(ALICE)
        .subscribe((rooms) => seen.push(rooms));
      subscription.unsubscribe();
      await flush();
      client.emit(ClientEvent.Sync, SyncState.Syncing);

      expect(seen).toHaveLength(1);
    });
  });
});
