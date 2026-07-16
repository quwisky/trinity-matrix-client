import { TestBed } from '@angular/core/testing';
import { MockProvider } from 'ng-mocks';
import { firstValueFrom } from 'rxjs';
import { HistoryVisibility, JoinRule } from 'matrix-js-sdk';
import { describe, expect, it, vi } from 'vitest';
import { MatrixClientService } from '@trinity/data-access-matrix-client';
import { RoomSettingsService } from './room-settings.service';

function setup(
  opts: {
    may?: (type: string) => boolean;
    noRoom?: boolean;
    joinRule?: string;
    historyVisibility?: string;
  } = {},
) {
  const setRoomName = vi.fn().mockResolvedValue({});
  const setRoomTopic = vi.fn().mockResolvedValue({});
  const uploadContent = vi.fn().mockResolvedValue({ content_uri: 'mxc://a/b' });
  const sendStateEvent = vi.fn().mockResolvedValue({});
  const stateFor = (type: string) => {
    if (type === 'm.room.join_rules' && opts.joinRule !== undefined) {
      return { getContent: () => ({ join_rule: opts.joinRule }) };
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
        isInitialized: true,
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
    });
  });

  it('currentAccess falls back to the spec defaults when state is absent', () => {
    const { svc } = setup(); // no join_rules / history_visibility state
    expect(svc.currentAccess('!r:hs')).toEqual({
      joinRule: JoinRule.Invite,
      historyVisibility: HistoryVisibility.Shared,
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
