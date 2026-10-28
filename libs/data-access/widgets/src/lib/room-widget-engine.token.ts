import { InjectionToken, inject } from '@angular/core';
import type { RoomWidgetEngine } from './room-widget-engine';
import { JsSdkRoomWidgetEngine } from './js-sdk/js-sdk-room-widget-engine';

export const ROOM_WIDGET_ENGINE = new InjectionToken<RoomWidgetEngine>(
  'ROOM_WIDGET_ENGINE',
  { providedIn: 'root', factory: () => inject(JsSdkRoomWidgetEngine) },
);
