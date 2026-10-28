import { InjectionToken, inject } from '@angular/core';
import type { RoomAdministrationEngine } from './room-administration-engine';
import { JsSdkRoomAdministrationEngine } from './js-sdk/js-sdk-room-administration-engine';

export const ROOM_ADMINISTRATION_ENGINE =
  new InjectionToken<RoomAdministrationEngine>('ROOM_ADMINISTRATION_ENGINE', {
    providedIn: 'root',
    factory: () => inject(JsSdkRoomAdministrationEngine),
  });
