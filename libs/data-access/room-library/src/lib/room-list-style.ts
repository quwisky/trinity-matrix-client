import { InjectionToken, signal, type Signal } from '@angular/core';

/** How dense room rows are drawn; the application provides it from the Appearance choice. */
export type RoomListStyle = 'rich' | 'compact';

export const ROOM_LIST_STYLE = new InjectionToken<Signal<RoomListStyle>>(
  'ROOM_LIST_STYLE',
  { providedIn: 'root', factory: () => signal<RoomListStyle>('rich') },
);
