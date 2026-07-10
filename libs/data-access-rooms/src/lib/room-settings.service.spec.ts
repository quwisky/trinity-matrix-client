import { TestBed } from '@angular/core/testing';
import { MockProvider } from 'ng-mocks';
import { firstValueFrom } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { MatrixClientService } from '@trinity/data-access-matrix-client';
import { RoomSettingsService } from './room-settings.service';

function setup(
  opts: { may?: (type: string) => boolean; noRoom?: boolean } = {},
) {
  const setRoomName = vi.fn().mockResolvedValue({});
  const setRoomTopic = vi.fn().mockResolvedValue({});
  const uploadContent = vi.fn().mockResolvedValue({ content_uri: 'mxc://a/b' });
  const sendStateEvent = vi.fn().mockResolvedValue({});
  const room = opts.noRoom
    ? null
    : {
        currentState: {
          maySendStateEvent: (type: string) =>
            opts.may ? opts.may(type) : true,
        },
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

  it('editableFields reflects per-field power (name yes, topic/avatar no)', () => {
    const { svc } = setup({ may: (type) => type === 'm.room.name' });
    expect(svc.editableFields('!r:hs')).toEqual({
      name: true,
      topic: false,
      avatar: false,
    });
  });

  it('editableFields is all-false when the room is unknown', () => {
    const { svc } = setup({ noRoom: true });
    expect(svc.editableFields('!r:hs')).toEqual({
      name: false,
      topic: false,
      avatar: false,
    });
  });
});
