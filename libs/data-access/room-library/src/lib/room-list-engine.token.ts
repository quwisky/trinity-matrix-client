import { InjectionToken } from '@angular/core';
import type { RoomListEngine } from './room-list-engine';

export const ROOM_LIST_ENGINE = new InjectionToken<RoomListEngine>(
  'ROOM_LIST_ENGINE',
  {
    providedIn: 'root',
    factory: () => {
      throw new Error('RoomListEngine has no adapter yet');
    },
  },
);
