/** A Space that directly contains the opening Room. */
export interface ParentSpace {
  readonly id: string;
  readonly name: string;
}

/** Open `roomId` for the Account that opened Room settings, once settings close. */
export interface RoomSettingsOpenRoom {
  readonly accountId: string;
  readonly roomId: string;
}

/** What Room settings closes with: `false` for an ordinary close, or a room to open. */
export type RoomSettingsResult = false | RoomSettingsOpenRoom;
