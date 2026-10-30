import { InjectionToken, inject } from '@angular/core';
import type { RoomListEngine } from './room-list-engine';
import { JsSdkRoomListEngine } from './js-sdk/js-sdk-room-list-engine';

export const ROOM_LIST_ENGINE = new InjectionToken<RoomListEngine>(
  'ROOM_LIST_ENGINE',
  { providedIn: 'root', factory: () => inject(JsSdkRoomListEngine) },
);
