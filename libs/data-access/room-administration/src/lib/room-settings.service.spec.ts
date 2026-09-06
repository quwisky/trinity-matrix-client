import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MockProvider } from 'ng-mocks';
import { firstValueFrom } from 'rxjs';
import { HistoryVisibility, JoinRule, KnownMembership } from 'matrix-js-sdk';
import { describe, expect, it, vi } from 'vitest';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { RoomActionPermissionsService } from './room-action-permissions.service';
import { RoomSettingsService } from './room-settings.service';

function setup(
  opts: {
    may?: (type: string) => boolean;
    noRoom?: boolean;
    signedOut?: boolean;
    joinRule?: string;
    allow?: unknown;
    version?: string;
    historyVisibility?: string;
    name?: string;
    topic?: string;
    avatarUrl?: string;
  } = {},
) {
  const setRoomName = vi.fn().mockResolvedValue({});
  const setRoomTopic = vi.fn().mockResolvedValue({});
  const uploadContent = vi.fn().mockResolvedValue({ content_uri: 'mxc://a/b' });
  const sendStateEvent = vi.fn().mockResolvedValue({});
  const stateListeners = new Set<
    (event?: { getRoomId(): string | null }, state?: { roomId: string }) => void
  >();
  const syncListeners = new Set<
    (event?: { getRoomId(): string | null }, state?: { roomId: string }) => void
  >();
  const accountIds = signal<readonly string[]>(
    opts.signedOut ? [] : ['@me:hs'],
  );
  const activeUserId = signal<string | null>(opts.signedOut ? null : '@me:hs');
  const stateFor = (type: string) => {
    if (type === 'm.room.join_rules' && opts.joinRule !== undefined) {
      return {
        getContent: () => ({ join_rule: opts.joinRule, allow: opts.allow }),
      };
    }
    if (type === 'm.room.name' && opts.name !== undefined) {
      return { getContent: () => ({ name: opts.name }) };
    }
    if (type === 'm.room.topic' && opts.topic !== undefined) {
      return { getContent: () => ({ topic: opts.topic }) };
    }
    if (type === 'm.room.avatar' && opts.avatarUrl !== undefined) {
      return { getContent: () => ({ url: opts.avatarUrl }) };
    }
    if (
      type === 'm.room.history_visibility' &&
      opts.historyVisibility !== undefined
    ) {
      return {
        getContent: () => ({ history_visibility: opts.historyVisibility }),
      };
    }
    return null;
  };
  const room = opts.noRoom
    ? null
    : {
        getVersion: () => opts.version ?? '10',
        getMyMembership: () => KnownMembership.Join,
        hasEncryptionStateEvent: () => true,
        // The service reads room state via the live timeline (liveRoomState()),
        // which is what the SDK's deprecated `currentState` aliased.
        getLiveTimeline: () => ({
          getState: () => ({
            maySendStateEvent: (type: string) =>
              opts.may ? opts.may(type) : true,
            getStateEvents: (type: string, _stateKey: string) => stateFor(type),
          }),
        }),
      };
  const instance = {
    setRoomName,
    setRoomTopic,
    uploadContent,
    sendStateEvent,
    getRoom: () => room,
    getUserId: () => '@me:hs',
    on: vi.fn(
      (
        event: string,
        listener: (
          event?: { getRoomId(): string | null },
          state?: { roomId: string },
        ) => void,
      ) => {
        if (event === 'RoomState.events') stateListeners.add(listener);
        if (event === 'sync') syncListeners.add(listener);
      },
    ),
    off: vi.fn(
      (
        event: string,
        listener: (
          event?: { getRoomId(): string | null },
          state?: { roomId: string },
        ) => void,
      ) => {
        if (event === 'RoomState.events') stateListeners.delete(listener);
        if (event === 'sync') syncListeners.delete(listener);
      },
    ),
  };
  const permissionFor = (type: string) => ({
    available:
      !opts.signedOut && !opts.noRoom && (opts.may ? opts.may(type) : true),
    reason:
      opts.signedOut || opts.noRoom || (opts.may && !opts.may(type))
        ? 'Not allowed.'
        : null,
  });
  const clientFor = vi.fn((accountId: string) =>
    accountIds().includes(accountId) ? (instance as never) : null,
  );
  TestBed.configureTestingModule({
    providers: [
      RoomSettingsService,
      MockProvider(MatrixClientService, {
        isInitialized: !opts.signedOut,
        instance: instance as never,
        accountIds: accountIds.asReadonly(),
        activeUserId: activeUserId.asReadonly(),
        clientFor,
      }),
      MockProvider(RoomActionPermissionsService, {
        settings: () => ({
          name: permissionFor('m.room.name'),
          topic: permissionFor('m.room.topic'),
          avatar: permissionFor('m.room.avatar'),
          joinRule: permissionFor('m.room.join_rules'),
          history: permissionFor('m.room.history_visibility'),
          aliases: permissionFor('m.room.canonical_alias'),
        }),
        settingsFor: () => ({
          name: permissionFor('m.room.name'),
          topic: permissionFor('m.room.topic'),
          avatar: permissionFor('m.room.avatar'),
          joinRule: permissionFor('m.room.join_rules'),
          history: permissionFor('m.room.history_visibility'),
          aliases: permissionFor('m.room.canonical_alias'),
        }),
        assert: (permission: { available: boolean }) => {
          if (!permission.available) throw new Error('Not allowed.');
        },
      }),
    ],
  });
  return {
    svc: TestBed.inject(RoomSettingsService),
    setRoomName,
    setRoomTopic,
    uploadContent,
    sendStateEvent,
    accountIds,
    activeUserId,
    clientFor,
    setIdentity: (name: string, topic: string) => {
      opts.name = name;
      opts.topic = topic;
    },
    emitState: () => {
      for (const listener of stateListeners) {
        // Live RoomState events can omit the room id on the MatrixEvent while the
        // accompanying RoomState still names it.
        listener({ getRoomId: () => null }, { roomId: '!r:hs' });
      }
      for (const listener of syncListeners) listener();
    },
  };
}

describe('RoomSettingsService', () => {
  it('setName is cold and renames the room (trimmed) on subscribe', async () => {
    const { svc, setRoomName } = setup();

    const action = svc.setName('!r:hs', '  New Name  ');
    expect(setRoomName).not.toHaveBeenCalled(); // cold

    await firstValueFrom(action);
    expect(setRoomName).toHaveBeenCalledWith('!r:hs', 'New Name');
  });

  it('setTopic is cold and sets the topic (trimmed) on subscribe', async () => {
    const { svc, setRoomTopic } = setup();

    await firstValueFrom(svc.setTopic('!r:hs', '  hello  '));
    expect(setRoomTopic).toHaveBeenCalledWith('!r:hs', 'hello');
  });

  it('rechecks the live state permission before a write', async () => {
    const { svc, setRoomName } = setup({
      may: (type) => type !== 'm.room.name',
    });

    await expect(firstValueFrom(svc.setName('!r:hs', 'Nope'))).rejects.toThrow(
      'Not allowed',
    );
    expect(setRoomName).not.toHaveBeenCalled();
  });

  it('setAvatar uploads the file then writes m.room.avatar', async () => {
    const { svc, uploadContent, sendStateEvent } = setup();
    const file = new File(['x'], 'photo.png', { type: 'image/png' });

    await firstValueFrom(svc.setAvatar('!r:hs', file));

    expect(uploadContent).toHaveBeenCalledWith(file, expect.any(Object));
    expect(sendStateEvent).toHaveBeenCalledWith(
      '!r:hs',
      'm.room.avatar',
      { url: 'mxc://a/b' },
      '',
    );
  });

  it('setJoinRule is cold and writes m.room.join_rules on subscribe', async () => {
    const { svc, sendStateEvent } = setup();

    const action = svc.setJoinRule('!r:hs', JoinRule.Public);
    expect(sendStateEvent).not.toHaveBeenCalled(); // cold

    await firstValueFrom(action);
    expect(sendStateEvent).toHaveBeenCalledWith(
      '!r:hs',
      'm.room.join_rules',
      { join_rule: 'public' },
      '',
    );
  });

  it('setJoinRule sends the allow list with a restricted rule', async () => {
    const { svc, sendStateEvent } = setup();

    await firstValueFrom(
      svc.setJoinRule('!r:hs', JoinRule.Restricted, ['!space:hs', '!other:hs']),
    );

    expect(sendStateEvent).toHaveBeenCalledWith(
      '!r:hs',
      'm.room.join_rules',
      {
        join_rule: 'restricted',
        allow: [
          { type: 'm.room_membership', room_id: '!space:hs' },
          { type: 'm.room_membership', room_id: '!other:hs' },
        ],
      },
      '',
    );
  });

  it('setJoinRule preserves unfamiliar restricted allow entries', async () => {
    const unknown = {
      type: 'org.example.membership_claim',
      issuer: 'example.org',
    };
    const { svc, sendStateEvent } = setup({
      joinRule: JoinRule.Restricted,
      allow: [{ type: 'm.room_membership', room_id: '!old:hs' }, unknown],
    });

    await firstValueFrom(
      svc.setJoinRule('!r:hs', JoinRule.Restricted, ['!new:hs']),
    );

    expect(sendStateEvent).toHaveBeenCalledWith(
      '!r:hs',
      'm.room.join_rules',
      {
        join_rule: 'restricted',
        allow: [{ type: 'm.room_membership', room_id: '!new:hs' }, unknown],
      },
      '',
    );
  });

  it('setJoinRule rejects an invalid allowed Space ID before writing', async () => {
    const { svc, sendStateEvent } = setup();

    await expect(
      firstValueFrom(
        svc.setJoinRule('!r:hs', JoinRule.Restricted, ['not-a-room-id']),
      ),
    ).rejects.toThrow('valid Matrix Room ID');
    expect(sendStateEvent).not.toHaveBeenCalled();
  });

  it('setJoinRule de-duplicates allowed Spaces before writing', async () => {
    const { svc, sendStateEvent } = setup();

    await firstValueFrom(
      svc.setJoinRule('!r:hs', JoinRule.Restricted, ['!space:hs', '!space:hs']),
    );

    expect(sendStateEvent).toHaveBeenCalledWith(
      '!r:hs',
      'm.room.join_rules',
      {
        join_rule: 'restricted',
        allow: [{ type: 'm.room_membership', room_id: '!space:hs' }],
      },
      '',
    );
  });

  it('setJoinRule refuses a restricted rule with nothing allowed', async () => {
    // Sending this would lock every member out of a room only an admin could reopen, so it
    // is refused in the service — the one place every join-rule write passes through.
    const { svc, sendStateEvent } = setup();

    await expect(
      firstValueFrom(svc.setJoinRule('!r:hs', JoinRule.Restricted)),
    ).rejects.toThrow(/at least one space/i);
    expect(sendStateEvent).not.toHaveBeenCalled();
  });

  it('setJoinRule omits allow entirely for a non-restricted rule', async () => {
    // An `allow` left on a public rule is ignored by the server but misleads every client
    // that reads the state back, including our own seeding.
    const { svc, sendStateEvent } = setup();

    await firstValueFrom(
      svc.setJoinRule('!r:hs', JoinRule.Public, ['!space:hs']),
    );

    expect(sendStateEvent).toHaveBeenCalledWith(
      '!r:hs',
      'm.room.join_rules',
      { join_rule: 'public' },
      '',
    );
  });

  it('currentAccess reads the allowed spaces of a restricted rule', () => {
    const { svc } = setup({
      joinRule: 'restricted',
      allow: [
        { type: 'm.room_membership', room_id: '!space:hs' },
        { type: 'm.room_membership', room_id: '!two:hs' },
      ],
    });

    expect(svc.currentAccess('!r:hs').allowedSpaceIds).toEqual([
      '!space:hs',
      '!two:hs',
    ]);
  });

  it('setJoinRule rejects rather than writing when signed out', async () => {
    // Every write in this service defers its signed-in check to subscribe time, so a
    // caller that built the Observable before a logout must not reach sendStateEvent.
    const { svc, sendStateEvent } = setup({ signedOut: true });

    await expect(
      firstValueFrom(svc.setJoinRule('!r:hs', JoinRule.Public)),
    ).rejects.toThrow(/not signed in/i);
    expect(sendStateEvent).not.toHaveBeenCalled();
  });

  it('currentIdentity is blank when signed out', () => {
    // The opener calls this synchronously just before creating the dialog; throwing here
    // would take the whole settings dialog down rather than open it empty.
    const { svc } = setup({ signedOut: true, name: 'Design', topic: 'T' });

    expect(svc.currentIdentity('!r:hs')).toEqual({
      name: '',
      topic: '',
      avatarMxc: null,
    });
  });

  it('currentIdentity is blank for a room the client does not have', () => {
    const { svc } = setup({ noRoom: true });

    expect(svc.currentIdentity('!r:hs')).toEqual({
      name: '',
      topic: '',
      avatarMxc: null,
    });
  });

  it('currentAccess falls back to the spec defaults when signed out', () => {
    const { svc } = setup({ signedOut: true, joinRule: 'public' });

    expect(svc.currentAccess('!r:hs')).toEqual({
      joinRule: JoinRule.Invite,
      historyVisibility: HistoryVisibility.Shared,
      allowedSpaceIds: [],
    });
  });

  it('supportsRestricted is false when signed out', () => {
    // False rather than throwing: the room dialog asks this to decide whether to OFFER
    // restricted, and a wrong `true` would present a choice that cannot be written.
    const { svc } = setup({ signedOut: true, version: '10' });

    expect(svc.supportsRestricted('!r:hs')).toBe(false);
  });

  it('editableFields grants nothing when signed out', () => {
    const { svc } = setup({ signedOut: true });

    expect(svc.editableFields('!r:hs')).toEqual({
      name: false,
      topic: false,
      avatar: false,
      joinRule: false,
      history: false,
    });
  });

  it('currentAccess ignores an allow list left under a non-restricted rule', () => {
    // Inert state some other client left behind. Surfacing it would make the dialog see an
    // access change where there is none, and then write one on an unrelated save.
    const { svc } = setup({
      joinRule: 'public',
      allow: [{ type: 'm.room_membership', room_id: '!stale:hs' }],
    });

    expect(svc.currentAccess('!r:hs').allowedSpaceIds).toEqual([]);
  });

  it('currentAccess collapses a repeated allow entry', () => {
    // A caller comparing this against a list it built cannot tell ['!a','!a'] from ['!a']
    // by size, so the duplicate has to go before it is ever handed out.
    const { svc } = setup({
      joinRule: 'restricted',
      allow: [
        { type: 'm.room_membership', room_id: '!a:hs' },
        { type: 'm.room_membership', room_id: '!a:hs' },
      ],
    });

    expect(svc.currentAccess('!r:hs').allowedSpaceIds).toEqual(['!a:hs']);
  });

  it('currentAccess drops malformed allow entries rather than surfacing them', () => {
    // The list is arbitrary state any client may have written. An empty-string id read back
    // here would be written straight back out on the next save.
    const { svc } = setup({
      joinRule: 'restricted',
      allow: [
        { type: 'm.room_membership', room_id: '!good:hs' },
        { type: 'm.room_membership' },
        { type: 'm.room_membership', room_id: '' },
        { type: 'something.else', room_id: '!bad:hs' },
        null,
        'nonsense',
      ],
    });

    expect(svc.currentAccess('!r:hs').allowedSpaceIds).toEqual(['!good:hs']);
  });

  it('supportsRestricted accepts room version 8, where MSC3083 landed', () => {
    expect(setup({ version: '8' }).svc.supportsRestricted('!r:hs')).toBe(true);
  });

  it('supportsRestricted rejects a room older than version 8', () => {
    // Version 7 accepts the string and enforces nothing, so the room silently stays as
    // open as it was — worse than refusing the option.
    expect(setup({ version: '7' }).svc.supportsRestricted('!r:hs')).toBe(false);
  });

  it('supportsRestricted rejects an unparseable version', () => {
    expect(
      setup({ version: 'org.example.9' }).svc.supportsRestricted('!r:hs'),
    ).toBe(false);
  });

  it('supportsRestricted is false for a room the client does not have', () => {
    expect(setup({ noRoom: true }).svc.supportsRestricted('!r:hs')).toBe(false);
  });

  it('setHistoryVisibility is cold and writes m.room.history_visibility', async () => {
    const { svc, sendStateEvent } = setup();

    await firstValueFrom(
      svc.setHistoryVisibility('!r:hs', HistoryVisibility.WorldReadable),
    );
    expect(sendStateEvent).toHaveBeenCalledWith(
      '!r:hs',
      'm.room.history_visibility',
      { history_visibility: 'world_readable' },
      '',
    );
  });

  it('currentAccess reads the room state', () => {
    const { svc } = setup({
      joinRule: 'public',
      historyVisibility: 'world_readable',
    });
    expect(svc.currentAccess('!r:hs')).toEqual({
      joinRule: JoinRule.Public,
      historyVisibility: HistoryVisibility.WorldReadable,
      allowedSpaceIds: [],
    });
  });

  it('currentAccess falls back to the spec defaults when state is absent', () => {
    const { svc } = setup(); // no join_rules / history_visibility state
    expect(svc.currentAccess('!r:hs')).toEqual({
      joinRule: JoinRule.Invite,
      historyVisibility: HistoryVisibility.Shared,
      allowedSpaceIds: [],
    });
  });

  it('currentIdentity reads name, topic and avatar from state', () => {
    const { svc } = setup({
      name: 'General',
      topic: 'The topic',
      avatarUrl: 'mxc://hs/abc',
    });

    expect(svc.currentIdentity('!r:hs')).toEqual({
      name: 'General',
      topic: 'The topic',
      avatarMxc: 'mxc://hs/abc',
    });
  });

  it('currentIdentity returns blanks rather than inventing a name', () => {
    // The SDK's Room.name fabricates a display name from the member list for a nameless room.
    // Seeding a form with that would compare the user's input against something nobody typed,
    // and then write the invention back as a real name.
    const { svc } = setup();

    expect(svc.currentIdentity('!r:hs')).toEqual({
      name: '',
      topic: '',
      avatarMxc: null,
    });
  });

  it('currentIdentity is blank for an unknown room', () => {
    const { svc } = setup({ noRoom: true });

    expect(svc.currentIdentity('!nope:hs')).toEqual({
      name: '',
      topic: '',
      avatarMxc: null,
    });
  });

  it('editableFields reflects per-field power (name yes, the rest no)', () => {
    const { svc } = setup({ may: (type) => type === 'm.room.name' });
    expect(svc.editableFields('!r:hs')).toEqual({
      name: true,
      topic: false,
      avatar: false,
      joinRule: false,
      history: false,
    });
  });

  it('editableFields is all-false when the room is unknown', () => {
    const { svc } = setup({ noRoom: true });
    expect(svc.editableFields('!r:hs')).toEqual({
      name: false,
      topic: false,
      avatar: false,
      joinRule: false,
      history: false,
    });
  });

  it('keeps exact Account ownership after the active Account changes', async () => {
    const { svc, activeUserId, accountIds, clientFor, setRoomName } = setup();
    activeUserId.set('@other:hs');
    accountIds.set(['@me:hs', '@other:hs']);

    await firstValueFrom(
      svc.setName({ accountId: '@me:hs', roomId: '!r:hs' }, 'Exact target'),
    );

    expect(clientFor).toHaveBeenCalledWith('@me:hs');
    expect(setRoomName).toHaveBeenCalledWith('!r:hs', 'Exact target');
  });

  it('observes exact Room state and never retargets when Account activity changes', () => {
    const { svc, activeUserId, setIdentity, emitState } = setup({
      name: 'Before',
      topic: 'Original',
    });
    const snapshots: string[] = [];
    const subscription = svc
      .observe({ accountId: '@me:hs', roomId: '!r:hs' })
      .subscribe((snapshot) => snapshots.push(snapshot.identity.name));

    expect(snapshots.at(-1)).toBe('Before');
    activeUserId.set('@other:hs');
    setIdentity('After', 'Remote');
    emitState();

    expect(snapshots.at(-1)).toBe('After');
    subscription.unsubscribe();
  });

  it('classifies a signed-out exact target without inventing readable state', () => {
    const { svc, accountIds } = setup({ name: 'Private', topic: 'Secret' });
    accountIds.set([]);

    expect(
      svc.snapshot({ accountId: '@me:hs', roomId: '!r:hs' }),
    ).toMatchObject({
      availability: 'account-unavailable',
      unavailableReason: expect.stringContaining('Account'),
      identity: { name: '', topic: '', avatarMxc: null },
      encrypted: null,
    });
  });
});
