import { TestBed } from '@angular/core/testing';
import { MockProvider } from 'ng-mocks';
import { firstValueFrom } from 'rxjs';
import { HistoryVisibility, JoinRule } from 'matrix-js-sdk';
import { describe, expect, it, vi } from 'vitest';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
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
  };
  TestBed.configureTestingModule({
    providers: [
      RoomSettingsService,
      MockProvider(MatrixClientService, {
        isInitialized: !opts.signedOut,
        instance: instance as never,
      }),
    ],
  });
  return {
    svc: TestBed.inject(RoomSettingsService),
    setRoomName,
    setRoomTopic,
    uploadContent,
    sendStateEvent,
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
});
